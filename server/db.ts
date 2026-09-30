import postgres from "postgres";

// seyl-ai's own database (documents and their vectors), separate from the gateway's.
// Connects as the least-privilege "seyl" role (scripts/db-setup.ts creates it).
const env = process.env;
export const sql = postgres({
  host: env.SEYL_DB_HOST ?? "127.0.0.1",
  port: Number(env.SEYL_DB_PORT ?? 5432),
  database: "seyl",
  user: "seyl",
  password: env.SEYL_DB_PASSWORD,
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
  });
}
