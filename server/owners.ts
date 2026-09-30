import { sql } from "./db.js";

// Who owns which conversation. OpenCode's sessions have no notion of users, so seyl-ai
// keeps the mapping itself (conversation id → the OIDC "sub" of its creator) and every
// conversation route checks it: other people's conversations are simply "not found".

export async function recordOwner(conversationId: string, owner: string) {
  await sql`INSERT INTO conversation_owners (conversation_id, owner) VALUES (${conversationId}, ${owner}) ON CONFLICT DO NOTHING`;
}

export async function ownerOf(conversationId: string): Promise<string | undefined> {
  const [row] = await sql<{ owner: string }[]>`SELECT owner FROM conversation_owners WHERE conversation_id = ${conversationId}`;
  return row?.owner;
}

export async function ownedBy(owner: string): Promise<Set<string>> {
  const rows = await sql<{ conversation_id: string }[]>`SELECT conversation_id FROM conversation_owners WHERE owner = ${owner}`;
  return new Set(rows.map((r) => r.conversation_id));
}

// Conversations created before login existed have no owner: the first user to sign in
// gets them (on a single-user install, that's the person who made them).
export async function claimUnowned(conversationIds: string[], owner: string) {
  for (const id of conversationIds) await recordOwner(id, owner);
}
