// Load .env before anything reads process.env (npm run dev; containers get real environment
// variables instead). Imported FIRST by the modules that read settings at load time — a later
// process.loadEnvFile() would come too late for them (imports are evaluated before the importer).
try {
  process.loadEnvFile();
} catch {}
