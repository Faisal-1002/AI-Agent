// One-time database setup (safe to run again).
//
//   npm run db:setup                         # Postgres at 127.0.0.1:5432 (Compose publishes it)
//   DB_PORT=5433 npm run db:setup            # e.g. through: kubectl -n seyl-ai port-forward svc/db 5433:5432
//
// Uses the Postgres ADMIN user (the gateway's) once, to give each application its own
// login role and its own database — so no app ever runs with admin rights:
//   - seyl      (SEYL_DB_PASSWORD)      documents + vectors; gets the pgvector extension
//   - keycloak  (KEYCLOAK_DB_PASSWORD)  the identity provider's users, clients, sessions
// The apps create their own tables at startup — except the audit log (below), which the api
// must not own.

import postgres from "postgres";

try {
  process.loadEnvFile();
} catch {}

const host = process.env.DB_HOST ?? "127.0.0.1";
const port = Number(process.env.DB_PORT ?? 5432);
const adminPassword = required("POSTGRES_PASSWORD");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`; // DDL can't take $1 parameters

const APPS = [
  { name: "seyl", password: required("SEYL_DB_PASSWORD"), extensions: ["vector"] },
  { name: "keycloak", password: required("KEYCLOAK_DB_PASSWORD"), extensions: [] },
];

const admin = postgres({ host, port, user: "litellm", password: adminPassword, database: "litellm", onnotice: () => {} });
for (const app of APPS) {
  const [role] = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${app.name}`;
  await admin.unsafe(`${role ? "ALTER" : "CREATE"} ROLE ${app.name} LOGIN PASSWORD ${quote(app.password)}`);
  const [db] = await admin`SELECT 1 FROM pg_database WHERE datname = ${app.name}`;
  if (!db) await admin.unsafe(`CREATE DATABASE ${app.name} OWNER ${app.name}`);
  console.log(`✓ ${app.name}: role ${role ? "updated" : "created"}, database ${db ? "exists" : "created"}`);

  for (const extension of app.extensions) {
    const adminOnApp = postgres({ host, port, user: "litellm", password: adminPassword, database: app.name, onnotice: () => {} });
    await adminOnApp.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    const [{ extversion }] = await adminOnApp`SELECT extversion FROM pg_extension WHERE extname = ${extension}`;
    console.log(`  ✓ extension ${extension} ${extversion}`);
    await adminOnApp.end();
  }
}

// The audit log (server/audit.ts): its own schema, owned by a role nobody logs in as, so the
// api's "seyl" user can only add and read rows — not change, delete or drop them, and not switch
// off the trigger that refuses changes (only an owner could; "seyl" owns the database, so a
// table in its "public" schema could be dropped — hence a separate schema).
const [auditRole] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'seyl_audit'`;
if (!auditRole) await admin.unsafe("CREATE ROLE seyl_audit NOLOGIN");
const adminOnSeyl = postgres({ host, port, user: "litellm", password: adminPassword, database: "seyl", onnotice: () => {} });
await adminOnSeyl.begin(async (tx) => {
  await tx.unsafe("CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION seyl_audit");
  await tx.unsafe("SET LOCAL ROLE seyl_audit"); // everything below belongs to seyl_audit
  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS audit.log (
      id     bigserial PRIMARY KEY,
      at     timestamptz NOT NULL DEFAULT now(),
      actor  text NOT NULL,
      action text NOT NULL,
      target text,
      detail jsonb
    )`);
  await tx.unsafe("CREATE INDEX IF NOT EXISTS log_actor_at_idx ON audit.log (actor, at DESC)");
  await tx.unsafe(`
    CREATE OR REPLACE FUNCTION audit.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'the audit log is append-only'; END $$`);
  await tx.unsafe("CREATE OR REPLACE TRIGGER no_change BEFORE UPDATE OR DELETE ON audit.log FOR EACH ROW EXECUTE FUNCTION audit.append_only()");
  await tx.unsafe("CREATE OR REPLACE TRIGGER no_truncate BEFORE TRUNCATE ON audit.log FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only()");
  await tx.unsafe("REVOKE ALL ON SCHEMA audit FROM PUBLIC");
  await tx.unsafe("REVOKE ALL ON audit.log FROM PUBLIC");
  await tx.unsafe("GRANT USAGE ON SCHEMA audit TO seyl");
  // Only these columns: the database itself sets the time and the id, so the api can't backdate
  // an entry or fill a gap. (REVOKE first: an older setup granted INSERT on every column.)
  await tx.unsafe("REVOKE INSERT ON audit.log FROM seyl");
  await tx.unsafe("GRANT SELECT, INSERT (actor, action, target, detail) ON audit.log TO seyl");
  await tx.unsafe("GRANT USAGE ON SEQUENCE audit.log_id_seq TO seyl");
});
await adminOnSeyl.end();

// Prove it, as the api's user: adding works; every way of rewriting history is refused.
// (All inside one transaction that is rolled back, so the check leaves no trace.)
const asApi = postgres({ host, port, user: "seyl", password: APPS[0].password, database: "seyl", onnotice: () => {} });
const ROLLBACK = new Error("rollback");
const refused: string[] = [];
await asApi
  .begin(async (tx) => {
    await tx`INSERT INTO audit.log (actor, action) VALUES ('db-setup', 'setup.check')`;
    for (const [what, statement] of [
      ["update", "UPDATE audit.log SET actor = 'someone else'"],
      ["delete", "DELETE FROM audit.log"],
      ["truncate", "TRUNCATE audit.log"],
      ["disable the trigger", "ALTER TABLE audit.log DISABLE TRIGGER ALL"],
      ["drop the table", "DROP TABLE audit.log"],
      ["drop the schema", "DROP SCHEMA audit CASCADE"],
      ["backdate", "INSERT INTO audit.log (at, actor, action) VALUES ('2020-01-01', 'db-setup', 'setup.check')"],
      ["choose the id", "INSERT INTO audit.log (id, actor, action) VALUES (1, 'db-setup', 'setup.check')"],
      ["reset the id counter", "SELECT setval('audit.log_id_seq', 1)"],
    ]) {
      const allowed = await tx.savepoint((sp) => sp.unsafe(statement)).then(() => true, () => false);
      if (allowed) throw new Error(`the api's database user could run: ${statement}`);
      refused.push(what);
    }
    throw ROLLBACK;
  })
  .catch((err) => {
    if (err !== ROLLBACK) throw err;
  });
await asApi.end();
console.log(`✓ audit log: the api can add and read, but not ${refused.join(", ")}`);

await admin.end();
