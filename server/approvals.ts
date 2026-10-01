import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import { audit } from "./audit.js";
import { sql } from "./db.js";
import { client } from "./opencode.js";
import { conversationOf } from "./owners.js";

// "Allow for this chat" — really for this chat.
//
// OpenCode's own "always" reply adds an allow rule to the WHOLE folder (every conversation in it,
// until it restarts; its edit tool's "always" pattern is "*"). So Seyl never sends "always". It
// stores the approval as a rule for ONE conversation, answers OpenCode "once", and from then on
// answers matching requests in that conversation "once" by itself — whether or not anyone has the
// chat open (watchApprovals).
//
// OpenCode keeps pending requests per folder: every list and reply names the conversation's folder.

const key = (patterns: string[]) => JSON.stringify([...patterns].sort());

// Remember "allow this kind of request in this conversation" — the same patterns OpenCode's
// "always" would have used (request.always), scoped to one conversation.
export async function rememberForConversation(request: PermissionRequest): Promise<void> {
  const patterns = request.always?.length ? request.always : request.patterns;
  await sql`
    INSERT INTO approval_rules (session_id, permission, patterns)
    VALUES (${request.sessionID}, ${request.permission}, ${key(patterns)})
    ON CONFLICT DO NOTHING`;
}

// A rule covers a request when it allows everything ("*") or every pattern asked for.
export const covers = (rule: string[], wanted: string[]) => rule.includes("*") || wanted.every((p) => rule.includes(p));

async function allowedHere(request: PermissionRequest): Promise<boolean> {
  const rows = await sql<{ patterns: string }[]>`
    SELECT patterns FROM approval_rules WHERE session_id = ${request.sessionID} AND permission = ${request.permission}`;
  return rows.some((r) => covers(JSON.parse(r.patterns) as string[], request.patterns));
}

// Answer a request "once" if its conversation already allowed this kind of request. Returns
// true when it is answered (the UI then doesn't need to ask). Several streams and api pods may
// try at the same moment: OpenCode accepts the first reply, and the others see it's gone.
export async function autoApprove(request: PermissionRequest, directory: string): Promise<boolean> {
  try {
    if (!(await allowedHere(request))) return false;
    const res = await client.permission.reply({ requestID: request.id, reply: "once", directory });
    if (res.error !== undefined) {
      const pending = (await client.permission.list({ directory })).data;
      return pending !== undefined && !pending.some((p) => p.id === request.id); // answered elsewhere
    }
    const owner = (await conversationOf(request.sessionID))?.owner ?? "unknown";
    await audit(owner, "approval.auto", request.sessionID, { permission: request.permission, patterns: request.patterns });
    return true;
  } catch {
    return false;
  }
}

// Answer whatever is waiting and already allowed — after "Allow for this chat" when the agent
// asked for several things at once (one conversation), or after a reconnect (every conversation
// that has rules: only those folders, so idle users' folders aren't woken up).
export async function approvePending(sessionID?: string): Promise<void> {
  const folders = sessionID
    ? [(await conversationOf(sessionID))?.directory].filter((d): d is string => !!d)
    : (await sql<{ directory: string }[]>`
        SELECT DISTINCT o.directory FROM approval_rules r
        JOIN conversation_owners o ON o.conversation_id = r.session_id
        WHERE o.directory IS NOT NULL`).map((r) => r.directory);
  for (const directory of folders) {
    const pending = (await client.permission.list({ directory })).data ?? [];
    for (const request of pending) if (!sessionID || request.sessionID === sessionID) await autoApprove(request, directory);
  }
}

// One watcher per api process, on OpenCode's GLOBAL event stream (every folder's events, each
// with its folder), so an allowed request is answered even when nobody has its chat open
// (otherwise the agent would wait until someone reopens it). Runs for the process's life.
export async function watchApprovals(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const events = await client.global.event();
      for await (const event of events.stream) {
        attempt = 1;
        const { directory, payload } = event as { directory?: string; payload?: { type?: string; properties?: unknown } };
        // OpenCode greets every (re)connection — the SDK reconnects by itself, so this is the only
        // sign of one: catch up on what was asked while we weren't listening.
        if (payload?.type === "server.connected") void approvePending().catch(() => {});
        if (directory && payload?.type === "permission.asked") void autoApprove(payload.properties as PermissionRequest, directory);
      }
    } catch (err) {
      console.error(`[approvals] event stream lost (attempt ${attempt}): ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * attempt)));
  }
}

// A conversation's rules go with it.
export const forgetConversation = (sessionID: string) => sql`DELETE FROM approval_rules WHERE session_id = ${sessionID}`;
