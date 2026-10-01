import { sql } from "./db.js";

// The audit log: who did what, and when — table audit.log. Append-only for the api: its
// database user may only INSERT and SELECT there. The schema and table belong to a separate
// role (seyl_audit, created by scripts/db-setup.ts), so the api can't update, delete, truncate
// or drop rows, and can't switch off the trigger that refuses changes either — neither a bug nor
// an injected query can rewrite history. (A database admin still could; a hosted Seyl would
// ship the log to a separate store.) No message text or secrets go in here: only actions and ids.

export type AuditAction =
  | "login"
  | "logout"
  | "device.connect"
  | "device.disconnect"
  | "approval.once"
  | "approval.this_chat"
  | "approval.auto"
  | "approval.deny"
  | "document.upload"
  | "document.delete"
  | "conversation.delete"
  | "prompt.blocked"
  | "space.create";

// Never throws: an audit failure is logged, and the action itself goes ahead.
export async function audit(actor: string, action: AuditAction, target?: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    await sql`
      INSERT INTO audit.log (actor, action, target, detail)
      VALUES (${actor}, ${action}, ${target ?? null}, ${detail ? sql.json(detail as Parameters<typeof sql.json>[0]) : null})`;
  } catch (err) {
    console.error(`[audit] could not record ${action} by ${actor}:`, (err as Error).message);
  }
}
