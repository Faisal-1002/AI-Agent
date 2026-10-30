import { sql } from "./db.js";
import type { Space } from "./spaces.js";

// Who owns which conversation, and where its agent works. OpenCode's sessions have no notion of
// users — any session id works for anyone who can reach the harness — so Ai-Agent keeps the mapping
// itself (conversation id → the OIDC "sub" of its creator + their space and folder), and every
// conversation route checks it: other people's conversations are simply "not found".

export type ConversationRecord = { owner: string; spaceId: string | null; directory: string | null };

export async function recordOwner(conversationId: string, owner: string, space: Space) {
  await sql`
    INSERT INTO conversation_owners (conversation_id, owner, space_id, directory)
    VALUES (${conversationId}, ${owner}, ${space.id}, ${space.dir})
    ON CONFLICT DO NOTHING`;
}

export async function conversationOf(conversationId: string): Promise<ConversationRecord | undefined> {
  const [row] = await sql<{ owner: string; space_id: string | null; directory: string | null }[]>`
    SELECT owner, space_id, directory FROM conversation_owners WHERE conversation_id = ${conversationId}`;
  return row && { owner: row.owner, spaceId: row.space_id, directory: row.directory };
}

export async function ownerOf(conversationId: string): Promise<string | undefined> {
  return (await conversationOf(conversationId))?.owner;
}

export async function ownedBy(owner: string): Promise<Set<string>> {
  const rows = await sql<{ conversation_id: string }[]>`SELECT conversation_id FROM conversation_owners WHERE owner = ${owner}`;
  return new Set(rows.map((r) => r.conversation_id));
}

// Does this user own conversations from before spaces (in the old shared folder)?
export async function ownsLegacy(owner: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM conversation_owners WHERE owner = ${owner} AND space_id IS NULL LIMIT 1`;
  return row !== undefined;
}
