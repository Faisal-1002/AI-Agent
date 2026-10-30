import { sql } from "./db.js";
import { client } from "./opencode.js";

// Closing idle folders. OpenCode keeps one "instance" per folder in memory (config, tools, the
// model catalog, …) and never closes one by itself — with a folder per user, the harness would
// grow with every user who ever opened a conversation. The api notes when it last used each
// folder (table harness_folders); every few minutes one api pod closes the folders nobody has
// used for AI_AGENT_IDLE_MINUTES. Nothing is lost: conversations live in OpenCode's database, and the
// next request opens the folder again (a second or two).
//
// OpenCode has no list of open folders, and closing one opens it first — so only folders used
// since they were last closed are candidates. Never closed: a folder whose agent is working, or
// that waits for an approval (closing it would reject the request).

const IDLE_MINUTES = Number(process.env.AI_AGENT_IDLE_MINUTES ?? 30);
const CHECK_SECONDS = Number(process.env.AI_AGENT_IDLE_CHECK_SECONDS ?? 300);
const IDLE_MS = IDLE_MINUTES * 60_000;
// How often an open chat says "still in use" — well within the idle limit, whatever it is.
export const KEEP_OPEN_MS = Math.max(5_000, Math.min(120_000, IDLE_MS / 3));

// "In use" marks, at most one database write per folder per minute and api pod.
export function toucher(write: (directory: string) => Promise<unknown>, now: () => number = Date.now, everyMs = 60_000) {
  const last = new Map<string, number>();
  return (directory: string): string => {
    const t = now();
    if ((last.get(directory) ?? -Infinity) + everyMs <= t) {
      last.set(directory, t);
      void write(directory).catch((err: Error) => console.error(`[idle] couldn't note ${directory}: ${err.message}`));
    }
    return directory;
  };
}

// Mark a folder as in use and return it: client.session.status({ directory: inUse(dir) }).
export const inUse = toucher(
  (directory) => sql`
    INSERT INTO harness_folders (directory) VALUES (${directory})
    ON CONFLICT (directory) DO UPDATE SET last_used_at = now()`,
  Date.now,
  Math.max(1_000, Math.min(60_000, IDLE_MS / 4)),
);

// Folders that may have an open instance: used since they were last closed.
export async function openFolders(): Promise<string[]> {
  const rows = await sql<{ directory: string }[]>`
    SELECT directory FROM harness_folders WHERE closed_at IS NULL OR closed_at < last_used_at`;
  return rows.map((r) => r.directory);
}

async function closeIdleFolders() {
  // One api pod at a time (a transaction-scoped lock: released when the transaction ends).
  await sql.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(4243) AS locked`;
    if (!locked) return;
    const idle = await tx<{ directory: string }[]>`
      SELECT directory FROM harness_folders
      WHERE (closed_at IS NULL OR closed_at < last_used_at)
        AND last_used_at < now() - make_interval(secs => ${IDLE_MS / 1000})`;
    for (const { directory } of idle) {
      const [status, pending] = await Promise.all([client.session.status({ directory }), client.permission.list({ directory })]);
      if (status.error !== undefined || pending.error !== undefined) continue; // try again next round
      const working = Object.values(status.data ?? {}).some((s) => s.type !== "idle");
      if (working || (pending.data ?? []).length > 0) continue;
      const closed = await client.instance.dispose({ directory });
      if (closed.error !== undefined) continue;
      await tx`UPDATE harness_folders SET closed_at = now() WHERE directory = ${directory}`;
      console.log(`[idle] closed ${directory} (unused for ${IDLE_MINUTES}+ min)`);
    }
  });
}

export function startIdleCleanup() {
  if (!(IDLE_MINUTES > 0)) return console.log("[idle] closing idle folders is off (AI_AGENT_IDLE_MINUTES=0)");
  setInterval(() => void closeIdleFolders().catch((err: Error) => console.error(`[idle] ${err.message}`)), CHECK_SECONDS * 1000).unref();
  console.log(`[idle] closing folders unused for ${IDLE_MINUTES} min (checked every ${CHECK_SECONDS} s)`);
}
