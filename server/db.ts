import postgres from "postgres";

// Ai-Agent's own database (documents and their vectors), separate from the gateway's.
// Connects as the least-privilege "ai_agent" role (scripts/db-setup.ts creates it).
const env = process.env;
export const sql = postgres({
  host: env.AI_AGENT_DB_HOST ?? "127.0.0.1",
  port: Number(env.AI_AGENT_DB_PORT ?? 5432),
  database: "ai_agent",
  user: "ai_agent",
  password: env.AI_AGENT_DB_PASSWORD,
  max: 5,
  onnotice: () => {},
});

// Must match the embedding model (Qwen3-Embedding 0.6B → 1024 numbers per text).
export const EMBEDDING_DIMENSIONS = 1024;

// Create the tables if they don't exist yet. Several api pods may start at once, so an
// advisory lock makes them take turns instead of racing on CREATE statements.
export async function migrate() {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242)`;
    await tx`
      CREATE TABLE IF NOT EXISTS documents (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        type        text NOT NULL,
        size        integer NOT NULL,
        content     text NOT NULL DEFAULT '',
        status      text NOT NULL DEFAULT 'indexing',  -- indexing | ready | failed
        error       text,
        chunk_count integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`;
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          bigserial PRIMARY KEY,
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        position    integer NOT NULL,
        content     text NOT NULL,
        embedding   vector(${EMBEDDING_DIMENSIONS}) NOT NULL
      )`);
    // HNSW: an approximate nearest-neighbour index, so search stays fast as chunks grow.
    await tx`CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)`;

    // Login sessions (server/auth.ts). Only a HASH of the cookie's session id is stored:
    // someone who reads this table still can't use it to sign in.
    await tx`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id_hash    text PRIMARY KEY,
        sub        text NOT NULL,
        name       text NOT NULL,
        email      text,
        username   text,
        id_token   text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`;

    // Which user created which conversation (server/owners.ts).
    await tx`
      CREATE TABLE IF NOT EXISTS conversation_owners (
        conversation_id text PRIMARY KEY,
        owner           text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )`;
    await tx`CREATE INDEX IF NOT EXISTS conversation_owners_owner_idx ON conversation_owners (owner)`;

    // Connected devices (server/devices.ts). Only hashes of what was handed out: the gateway's
    // own hashed key id (enough to revoke the key) and the SHA-256 of the MCP token.
    await tx`
      CREATE TABLE IF NOT EXISTS devices (
        id               uuid PRIMARY KEY,
        owner            text NOT NULL,
        name             text NOT NULL,
        gateway_key_hash text NOT NULL,
        mcp_token_hash   text NOT NULL UNIQUE,
        created_at       timestamptz NOT NULL DEFAULT now(),
        last_used_at     timestamptz,
        expires_at       timestamptz NOT NULL,
        revoked_at       timestamptz
      )`;
    await tx`CREATE INDEX IF NOT EXISTS devices_owner_idx ON devices (owner)`;

    // "Allow for this chat" rules, one conversation at a time (server/approvals.ts).
    await tx`
      CREATE TABLE IF NOT EXISTS approval_rules (
        session_id text NOT NULL,
        permission text NOT NULL,
        patterns   text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, permission, patterns)
      )`;

    // Spaces (server/spaces.ts): whose files and documents. One personal space per user today;
    // company spaces (shared by a team) can come later without moving anything.
    await tx`
      CREATE TABLE IF NOT EXISTS spaces (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind       text NOT NULL DEFAULT 'personal',
        owner_sub  text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS spaces_personal_idx ON spaces (owner_sub) WHERE kind = 'personal'`;
    // Each document belongs to a space. Documents from before spaces have none: nobody sees them
    // until server/spaces.ts gives them to the owner of the old conversations.
    await tx`ALTER TABLE documents ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES spaces(id) ON DELETE CASCADE`;
    await tx`ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by text`;
    await tx`CREATE INDEX IF NOT EXISTS documents_space_idx ON documents (space_id, created_at DESC)`;
    // Each conversation: its space and the folder its agent works in (none = from before spaces).
    await tx`ALTER TABLE conversation_owners ADD COLUMN IF NOT EXISTS space_id uuid`;
    await tx`ALTER TABLE conversation_owners ADD COLUMN IF NOT EXISTS directory text`;
    // Upgrading from before spaces: who owned the conversations back then, recorded ONCE — at the
    // first migration, when every existing conversation is still without a space — so rows written
    // later (say, by an old api pod during a rolling update) never count. Only a single owner gets
    // the old library and folder (server/spaces.ts); with several, nobody does: an admin decides.
    await tx`
      CREATE TABLE IF NOT EXISTS spaces_upgrade (
        id             integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        legacy_owner   text,
        legacy_owners  integer NOT NULL,
        recorded_at    timestamptz NOT NULL DEFAULT now()
      )`;
    await tx`
      INSERT INTO spaces_upgrade (id, legacy_owner, legacy_owners)
      SELECT 1, CASE WHEN count(DISTINCT owner) = 1 THEN min(owner) END, count(DISTINCT owner)
      FROM conversation_owners WHERE space_id IS NULL
      ON CONFLICT (id) DO NOTHING`;

    // When the api last used each harness folder, and when it last closed it (server/idle.ts).
    await tx`
      CREATE TABLE IF NOT EXISTS harness_folders (
        directory    text PRIMARY KEY,
        last_used_at timestamptz NOT NULL DEFAULT now(),
        closed_at    timestamptz
      )`;
  });

  // The audit log is NOT created here: the api's own user may only add and read rows, so it
  // can't create (or alter) the table either. scripts/db-setup.ts does, under its own owner.
  const [{ exists }] = await sql<{ exists: boolean }[]>`SELECT to_regclass('audit.log') IS NOT NULL AS exists`;
  if (!exists) console.warn("[audit] no audit log yet: run npm run db:setup (actions are not being recorded)");
}
