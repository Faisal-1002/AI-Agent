// Registers seyl-ai's per-consumer keys in the LiteLLM gateway (safe to run again: it updates).
//
//   npm run gateway:keys                      # gateway at http://127.0.0.1:4000 (Compose)
//   GATEWAY_URL=http://127.0.0.1:4001 npm run gateway:keys   # e.g. through kubectl port-forward
//
// The key VALUES come from .env, so the same keys work in Compose and Kubernetes.
// The master key only ever touches this admin script — apps never see it.

export {}; // an ES module, so top-level await works

try {
  process.loadEnvFile(); // .env in the current folder, if present
} catch {}

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:4000";
const MASTER_KEY = required("LITELLM_MASTER_KEY");

// Least privilege: each consumer may only call the models it needs.
const KEYS = [
  {
    key: required("LITELLM_KEY_HARNESS"),
    key_alias: "harness",
    models: ["qwen3.5-9b", "qwen3.5-0.8b"],
    metadata: { purpose: "OpenCode agent loop and chat titles" },
  },
  {
    key: required("LITELLM_KEY_API"),
    key_alias: "api",
    models: ["qwen3-asr", "qwen3-tts", "qwen3-guard"],
    rpm_limit: 120, // a runaway client can't flood the CPU-bound models
    metadata: { purpose: "Voice and the safety filter, called by the seyl-ai API" },
  },
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

async function gateway(path: string, init: RequestInit = {}) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${MASTER_KEY}`, "Content-Type": "application/json" },
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

for (const spec of KEYS) {
  const exists = (await gateway(`/key/info?key=${encodeURIComponent(spec.key)}`)).ok;
  const result = await gateway(exists ? "/key/update" : "/key/generate", {
    method: "POST",
    body: JSON.stringify(spec),
  });
  if (!result.ok) {
    console.error(`✗ ${spec.key_alias}: HTTP ${result.status}`, JSON.stringify(result.body).slice(0, 300));
    process.exitCode = 1;
  } else {
    console.log(`✓ ${spec.key_alias} ${exists ? "updated" : "created"} → models: ${spec.models.join(", ")}`);
  }
}
