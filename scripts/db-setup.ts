// One-time database setup (safe to run again).
//
//   npm run db:setup                         # Postgres at 127.0.0.1:5432 (Compose publishes it)
//   DB_PORT=5433 npm run db:setup            # e.g. through: kubectl -n seyl-ai port-forward svc/db 5433:5432
//
// Uses the Postgres ADMIN user (the gateway's) once, to give each application its own
// login role and its own database — so no app ever runs with admin rights:
//   - seyl      (SEYL_DB_PASSWORD)      documents + vectors; gets the pgvector extension
//   - keycloak  (KEYCLOAK_DB_PASSWORD)  the identity provider's users, clients, sessions
// The apps create their own tables at startup.

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
await admin.end();
