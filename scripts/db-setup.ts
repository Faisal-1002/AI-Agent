// One-time database setup for seyl-ai's own data (safe to run again).
//
//   npm run db:setup                         # Postgres at 127.0.0.1:5432 (Compose publishes it)
//   DB_PORT=5433 npm run db:setup            # e.g. through: kubectl -n seyl-ai port-forward svc/db 5433:5432
//
// Uses the Postgres ADMIN user (the gateway's) once, to create:
//   - a separate login role "seyl" with its own password (SEYL_DB_PASSWORD) — the app never gets admin rights
//   - a separate database "seyl", owned by that role
//   - the pgvector extension in it (creating extensions needs admin rights)
// The app creates its own tables at startup (server/db.ts).

import postgres from "postgres";

try {
  process.loadEnvFile();
} catch {}

const host = process.env.DB_HOST ?? "127.0.0.1";
const port = Number(process.env.DB_PORT ?? 5432);
const adminPassword = required("POSTGRES_PASSWORD");
const appPassword = required("SEYL_DB_PASSWORD");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`; // DDL can't take $1 parameters

const admin = postgres({ host, port, user: "litellm", password: adminPassword, database: "litellm", onnotice: () => {} });
const [role] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'seyl'`;
await admin.unsafe(`${role ? "ALTER" : "CREATE"} ROLE seyl LOGIN PASSWORD ${quote(appPassword)}`);
console.log(`✓ role seyl ${role ? "password updated" : "created"}`);

const [db] = await admin`SELECT 1 FROM pg_database WHERE datname = 'seyl'`;
if (!db) await admin.unsafe("CREATE DATABASE seyl OWNER seyl");
console.log(`✓ database seyl ${db ? "exists" : "created"}`);
await admin.end();

const adminOnSeyl = postgres({ host, port, user: "litellm", password: adminPassword, database: "seyl", onnotice: () => {} });
await adminOnSeyl`CREATE EXTENSION IF NOT EXISTS vector`;
const [{ extversion }] = await adminOnSeyl`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
console.log(`✓ pgvector ${extversion} enabled in seyl`);
await adminOnSeyl.end();
