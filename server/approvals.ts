import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import { audit } from "./audit.js";
import { sql } from "./db.js";
import { client } from "./opencode.js";
import { ownerOf } from "./owners.js";

// "Allow for this chat" — really for this chat.
//
// OpenCode's own "always" reply adds an allow rule to the WHOLE harness: every conversation of
// every user, until it restarts (its edit tool's "always" pattern is "*"). So Seyl never sends
// "always". It stores the approval as a rule for ONE conversation, answers OpenCode "once",
// and from then on answers matching requests in that conversation "once" by itself — whether
// or not anyone has the chat open (watchApprovals).

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
export async function autoApprove(request: PermissionRequest): Promise<boolean> {
  try {
    if (!(await allowedHere(request))) return false;
    const res = await client.permission.reply({ requestID: request.id, reply: "once" });
    if (res.error !== undefined) {
      const pending = (await client.permission.list({})).data;
      return pending !== undefined && !pending.some((p) => p.id === request.id); // answered elsewhere
    }
    const owner = (await ownerOf(request.sessionID)) ?? "unknown";
    await audit(owner, "approval.auto", request.sessionID, { permission: request.permission, patterns: request.patterns });
    return true;
  } catch {
    return false;
  }
}

// Answer whatever is waiting and already allowed — e.g. after a reconnect, or right after
// "Allow for this chat" when the agent asked for several things at once.
export async function approvePending(sessionID?: string): Promise<void> {
  const pending = (await client.permission.list({})).data ?? [];
  for (const request of pending) if (!sessionID || request.sessionID === sessionID) await autoApprove(request);
}

// One watcher per api process, so an allowed request is answered even when nobody has its chat
// open (otherwise the agent would wait until someone reopens it). Runs for the process's life.
export async function watchApprovals(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const events = await client.event.subscribe({});
      for await (const event of events.stream) {
        attempt = 1;
        // OpenCode greets every (re)connected subscriber: catch up on what was asked meanwhile.
        if (event.type === "server.connected") void approvePending().catch(() => {});
        if (event.type === "permission.asked") void autoApprove(event.properties);
      }
    } catch (err) {
      console.error(`[approvals] event stream lost (attempt ${attempt}): ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * attempt)));
  }
}

// A conversation's rules go with it.
export const forgetConversation = (sessionID: string) => sql`DELETE FROM approval_rules WHERE session_id = ${sessionID}`;
