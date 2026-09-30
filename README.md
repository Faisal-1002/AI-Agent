# seyl-ai

My own AI agent — a local web app built on the [OpenCode](https://github.com/anomalyco/opencode) harness, running open models (Qwen3.5) on my own GPU.

## How it works

```
Browser (React)               localhost:5173   web/          chat UI
   │  HTTP + Server-Sent Events
   ▼
seyl-ai backend (Hono)        localhost:3000   server/       my code: sessions, prompts, safety filter, events
   │  @opencode-ai/sdk              (checks every message with Qwen3Guard first — see Safety)
   ▼
OpenCode harness              localhost:4097   server/harness.ts   agent loop, tools, permissions
   │  agent "seyl": own system prompt + 3 read-only tools
   │  OpenAI-compatible API, key "harness"     (the backend's guard and voice use key "api")
   ▼
LiteLLM gateway               localhost:4000   gateway/      one front door to every model
   │
   ├─▶ Ollama (host)  ─▶ Qwen3.5 9B   (GPU, 32k context)   main model: agent loop, tools, images
   │                  ├▶ Qwen3.5 0.8B (CPU, no thinking)   small model: chat titles
   │                  ├▶ Qwen3Guard 0.6B (CPU)             safety classifier
   │                  └▶ Qwen3-Embedding 0.6B (CPU)        document search vectors
   ├─▶ voice/asr      ─▶ Qwen3-ASR 0.6B (CPU)              speech-to-text
   └─▶ voice/tts      ─▶ Qwen3-TTS 0.6B (CPU)              text-to-speech
```

- **Models** — Qwen3.5 9B is the "brain"; Qwen3.5 0.8B handles quick jobs (OpenCode's `small_model`); Qwen3-ASR/TTS are the voice. Just weights; they can't run on their own.
- **Ollama** — the runtime that loads the chat weights onto the GPU and serves them over HTTP.
- **LiteLLM** — the model gateway: one OpenAI-compatible API, per-consumer keys, usage logs (see [Gateway](#gateway)).
- **OpenCode** — the harness: runs the agent loop (model → tool call → result → model …), provides tools (read, grep, glob, …), and enforces permissions. seyl-ai runs its own agent on it ([Safety](#safety)).
- **Backend** — conversations (= OpenCode sessions), prompts, stop, history, and a live event stream; translates OpenCode's data into a small model the UI understands (`server/translate.ts`, types in `shared/chat.ts`).
- **Web UI** — a chat app in the style of LibreChat: conversation sidebar, streamed markdown replies, collapsible "Thoughts" and tool calls (with their input and output), stop button, light/dark theme.

The agent can only see files in [`workspace/`](workspace). It may read them freely and **change them only with your
approval** ([Approvals](#approvals)); shell commands and web access are off.

## Requirements

- Node.js 24+
- [Ollama](https://ollama.com)
- OpenCode: `npm install -g opencode-ai`
- A GPU with ~8 GB free VRAM (developed on an RTX 3080 10 GB)

## Setup

```bash
npm install
ollama pull qwen3.5:9b
ollama pull qwen3.5:0.8b
ollama create seyl-qwen3.5-9b -f ollama/qwen3.5-9b.Modelfile
ollama create seyl-qwen3.5-0.8b -f ollama/qwen3.5-0.8b.Modelfile
ollama pull hf.co/mradermacher/Qwen3Guard-Gen-0.6B-GGUF:Q8_0
ollama create seyl-qwen3guard-0.6b -f ollama/qwen3guard-0.6b.Modelfile
ollama pull qwen3-embedding:0.6b
ollama create seyl-qwen3-embedding-0.6b -f ollama/qwen3-embedding-0.6b.Modelfile
```

Secrets: copy `.env.example` to `.env` and fill in long random values. `.env` is git-ignored; nothing
secret is committed.

### Models

| Model | Where | Speed (RTX 3080) | Why |
|---|---|---|---|
| `seyl-qwen3.5-9b` | GPU, 6.5 GB incl. 32k context | ~79 tokens/s | Agent loop, tools, thinking, images. Hybrid attention keeps long context cheap. |
| `seyl-qwen3.5-0.8b` | CPU (`num_gpu 0`) | title in ~3 s | Titles. Thinking disabled with `reasoningEffort: "none"`. |
| `seyl-qwen3guard-0.6b` | CPU (`num_gpu 0`) | ~0.5 s per check | Safety classifier ([Safety](#safety)). GGUF conversion of the official Apache-2.0 model. |
| `seyl-qwen3-embedding-0.6b` | CPU (`num_gpu 0`) | 16 chunks in ~0.3 s (warm) | Document search ([Documents](#documents-rag)). 1024-dimension vectors, multilingual. |

Lesson learned: with both models on a 10 GB GPU (plus the Windows desktop), VRAM overflowed and Windows
spilled it into system RAM — generation dropped from ~46 to ~1 token/s. Keep the GPU for one model and put
small helpers on the CPU. Check with `ollama ps` (PROCESSOR column) and `nvidia-smi`.

## Run

The app runs locally; the model side (gateway, its database, voice services) runs in Docker:

```bash
docker compose up -d litellm asr tts
npm run gateway:keys
npm run db:setup
npm run dev
```

Then open http://localhost:5173 and ask something like *"Read notes.md and tell me the project codename."*
`npm run gateway:keys` registers the per-consumer keys from `.env` in the gateway (safe to re-run).

## Gateway

Every model call goes through **LiteLLM** (`gateway/config.yaml`). Consumers know only the gateway URL
and model *names* (`qwen3.5-9b`, `qwen3.5-0.8b`, `qwen3-asr`, `qwen3-tts`) — not where the models run.
Moving a model (say, Ollama → Amazon Bedrock) is a change to that one file.

| Key (from `.env`) | Alias | May use | Used by |
|---|---|---|---|
| `LITELLM_KEY_HARNESS` | `harness` | `qwen3.5-9b`, `qwen3.5-0.8b` | the OpenCode harness |
| `LITELLM_KEY_API` | `api` | `qwen3-guard`, `qwen3-embedding`, `qwen3-asr`, `qwen3-tts` (300 requests/min) | the backend's safety filter, document indexing/search and voice |
| `LITELLM_MASTER_KEY` | admin | everything | only `scripts/gateway-keys.ts` and the admin UI |

- **Least privilege**: the harness key calling a voice model → `403`; the voice key calling chat → `403`; no key → `401`.
- **Usage logs** per key and model live in Postgres. Admin UI: http://localhost:4000/ui (user `admin`,
  password = `LITELLM_MASTER_KEY`). In Kubernetes: `kubectl -n seyl-ai port-forward svc/litellm 4001:4000`,
  then http://localhost:4001/ui.
- The logs make the cost of an **agent loop** visible: one question with a tool call was 2–4 calls to
  the 9B and ~11k prompt tokens, because each step re-sends the conversation, system prompt and tool list.
- LiteLLM normalizes Ollama's `reasoning` stream field to the standard `reasoning_content`, so "Thoughts" keep streaming.
- The config is **baked into the gateway image** (`gateway/Dockerfile`), secrets are not — they arrive as
  environment variables. (Also a workaround: Docker Desktop can't bind-mount files from this app's
  virtualized folder.)

## Safety

Two layers with different jobs:

| | **System prompt** (`server/prompts/seyl-ai.md`) | **Safety filter** (`server/guard.ts`) |
|---|---|---|
| What | Tells the agent who it is and how to behave | Checks every message and every reply |
| Where | Inside the model's context | In our backend, *outside* the model |
| Can a user talk their way past it? | Yes — it's a request, not a rule | No — the check runs before the agent sees anything |

**The agent** — seyl-ai runs its own OpenCode agent (`agent: "seyl"` in `server/opencode.ts`): its system prompt
replaces OpenCode's built-in coding prompt, only `read`, `glob` and `grep` are offered (an allow-list), and a
message may take at most 12 model calls. Measured in the gateway logs: **5,301 → 1,566 prompt tokens per agent
step (−70%)** — every step re-sends the system prompt and tool definitions.

**The safety filter** — [Qwen3Guard-Gen 0.6B](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B) labels text *Safe /
Controversial / Unsafe* with categories (Violent, PII, Jailbreak, …). ~0.5 s per check on the CPU.

```
message ──► guard ──(block)──► "seyl-ai can't help with that (Violent)" — the agent never sees it
                └──(allow)──► agent answers ──► guard + PII rules review the reply ──► flag shown on the reply
```

- **Policy** (`decide()`): block *Unsafe*, and anything tagged *Jailbreak*; `GUARD_STRICT=true` also blocks
  *Controversial*. The model labels; our code decides.
- **Replies** are reviewed after they finish; flags are stored in the OpenCode session's metadata, so they survive reloads.
- **Fail closed**: if the guard is down, messages are refused rather than let through unchecked.
- **Self-harm** gets a caring message pointing to people who can help, not a generic "blocked".
- `GUARD_MODE=monitor` checks and flags but never blocks (for tuning); `off` disables checks.

**Evaluate it**: `npm run guard:eval` runs 18 labeled cases (everyday, Arabic, borderline, harmful, jailbreak,
replies) through the real pipeline and checks each *decision* — 18/18 today. Re-run it after changing the model,
its quantization, the template or the policy.

Lessons learned:

- **Chat templates are part of the model.** Qwen3Guard's whole safety policy lives in its Jinja chat template.
  Ollama can't run Jinja — it copied the code verbatim, which the model would have seen as gibberish. So the
  backend renders the official policy text (`server/guard-template.json`, extracted by `scripts/guard-template.ts`)
  and the Modelfile's template only adds the chat markers.
- **Labels ≠ decisions.** The guard rated a jailbreak only *Controversial* (while tagging it *Jailbreak*), so
  "block Unsafe" let it through. The policy now looks at categories too.
- **Defense in depth.** The guard flagged a bare "name, address, SSN" row, but rated the *same data* Safe inside a
  longer explanation. Deterministic rules (`server/pii.ts`: SSN format, Luhn-valid card numbers) catch those.
- **Trade-offs are real.** A request to *make up* a fictional customer record (for a database test) was blocked
  as PII — a false positive. Strictness costs some legitimate uses.
- **Small models are inconsistent**: the 0.6B guard sometimes omits its optional "Refusal:" line; refusal is
  informational only, so nothing depends on it.
- **Don't blindly trust a model file.** The guard weights are a community GGUF conversion (not the "heretic"
  variants, which have safety removed) — hence the evaluation set.

`workspace/customers.csv` holds obviously fake personal data for testing the reply check.

## Documents (RAG)

"Chat with your documents": upload files in the **Documents** panel (sidebar); the agent searches them when a
question needs them.

```
upload ──► api: extract text (PDF, Word, md, txt, csv, json, html) ──► chunks (~1,200 chars, 200 overlap)
       ──► Qwen3-Embedding (via the gateway) ──► Postgres + pgvector (database "seyl", HNSW index)

agent ──► MCP tool docs_search_documents ──► api /mcp ──► nearest chunks by meaning ──► answer, naming the file
```

- **Agentic RAG**: instead of pasting search results into every message, the agent gets **tools** — search,
  list, read a document page by page — and decides when to use them (it often refines its query and searches twice).
- **MCP** (Model Context Protocol, `server/mcp.ts`): the open standard for agent tools. OpenCode connects to it as
  a remote MCP server (`mcp.docs` in `server/opencode.ts`); any MCP client could use the same tools. It lives at
  `/mcp` — outside `/api`, so nginx never exposes it — and requires the `SEYL_MCP_TOKEN` bearer token.
- **pgvector** instead of a separate vector database: one Postgres (on AWS: RDS/Aurora with pgvector). seyl-ai
  has its **own database and user** (`npm run db:setup`); the gateway's admin user isn't used by the app.
- **Asymmetric embeddings**: Qwen3-Embedding expects questions with an instruction prefix and documents without.
  Search works across languages — an Arabic question found and answered from an English document.
- Documents live in the database, not on disk: the api stays stateless (any replica can serve any request).

Measured: the README (20 KB) → 23 passages; indexing takes ~2 s warm, ~17 s when the embedding model has to be
loaded first (Ollama unloads idle models). `npm run ask -- --runs 5 "…"` asks through the real API and reports
tools used and whether a visible answer came out.

Lessons learned:

- **Upgrading a database image can change more than the database.** `postgres:16` runs on Debian 13 (glibc 2.41);
  the default `pgvector` image on Debian 12 (glibc 2.36). Same Postgres, different *text sorting rules* — Postgres
  warned of a **collation version mismatch** and refused to create databases. Fix: the pgvector image built on the
  same Debian (`0.8.6-pg16-trixie`), pinned.
- **Thinking models sometimes leave the answer in their thoughts.** After tool calls, Qwen3.5 occasionally ended a
  turn with the answer only in its (hidden) reasoning — 2 of 3 runs answered visibly. A system-prompt instruction
  fixed most of it (5/5); a **harness safety net** catches the rest: if a turn ends without a visible answer, the
  backend sends one hidden follow-up ("write your final answer now") — it fired once in 5 runs and recovered it.
- **Small models wander**: the agent sometimes looks for uploaded documents with `glob`/`read` first, wasting
  steps. Clearer tool descriptions help; it's a target for the optimization phase.
- **Measure, don't guess**: every change above was checked with repeated runs, not one lucky answer.

## Approvals

seyl-ai can create and change files in the workspace — but every change waits for you:

```
agent wants to edit notes.md ──► OpenCode pauses (permission "ask") ──► event ──► card in the chat with the diff
you: Allow once / Allow for this chat / Deny ──► POST /api/conversations/:id/permissions/:requestID ──► agent continues
```

| Action | Rule | |
|---|---|---|
| read, glob, grep, document tools | allow | on its own |
| edit / write (change or create a file) | **ask** | shows the diff, waits for your answer |
| bash, web, sub-agents, outside the workspace | deny | not even offered to the model |

- Pending approvals survive a page reload (the api lists them from OpenCode).
- The workspace is on a persistent volume, so approved changes survive restarts; an `initContainer` seeds it from
  the image once (`cp -n` never overwrites your edits).
- Tested: an approved edit landed on disk and survived a harness restart; a denied `todo.md` was never created and
  the agent asked what to do instead.

Lessons learned:

- **"Available" is not "allowed".** The agent's tool list was written as `tools: { edit: true }`. OpenCode turns that
  into `permission: { edit: "allow" }` — silently overriding the global `"ask"`. The first test changed a file with
  **no approval**. Found only by reading the *effective* config back from the running harness. Now the rules are
  written as permissions, and **the harness checks them at startup and refuses to run if they're wrong**
  (`server/harness.ts`) — policy as a test, not as hope.
- **This is why you review diffs**: asked to add one line, the model also changed the line above (a stray space).
- **Small models copy line numbers**: `read` shows lines as `6: text`; the model put `6:` into the text to
  replace, so `edit` failed four times — then it rewrote the whole file with `write`. The system prompt now says
  line numbers aren't part of the file and how to append.

## Images

Attach up to 4 images to a message — 📎 button, paste, or drag & drop — and ask about them. Qwen3.5 9B reads them.

```
image ──► browser: shrink to ≤ 1280 px, JPEG (web/src/lib/images.ts) ──► api ──► OpenCode file part (data: URL)
      ──► gateway ──► Ollama ──► Qwen3.5 9B (vision)
```

- **Why shrink in the browser**: a vision model turns an image into tokens in proportion to its size. An 800×600
  screenshot cost ~480 prompt tokens; a 12-megapixel phone photo would cost thousands — and seconds of processing —
  for detail the model doesn't need. A 2400×1600 test image went up as a 25 KB, 1280×853 JPEG.
- The api validates type, count and size; images are stored with the conversation and shown in your message.
- **Limitation**: Qwen3Guard reads text only — images themselves are *not* moderated. The message text still is.
- Tested: a canvas with a red circle, a blue square and the text "seyl-ai 42" → described exactly.

## Voice

```
🎤 mic button ──► POST /api/voice/transcribe ──► asr  (Qwen3-ASR 0.6B, CPU) ──► text in the message box
🔊 read aloud ──► POST /api/voice/speak      ──► tts  (Qwen3-TTS 0.6B, CPU) ──► audio, sentence by sentence
```

- Each voice model is a small Python (FastAPI) service in its own container — `voice/asr`, `voice/tts` — with an
  **OpenAI-compatible** API (`/v1/audio/transcriptions`, `/v1/audio/speech`), and sit behind the [gateway](#gateway)
  like every other model. Ollama can't serve audio models.
- They run on the **CPU**: the GPU is reserved for the chat model. Models download from Hugging Face on first start
  (ASR ~1.9 GB, TTS ~2.5 GB) into a volume.
- The UI shows the buttons only when `/api/voice/status` says the services are up.

Measured on an i7-14700K (CPU only):

| | Speed | Notes |
|---|---|---|
| Speech-to-text | 7.3 s of audio → text in ~2.5 s (≈3× faster than real time) | 52 languages, auto-detected |
| Text-to-speech | ~2.4 s of work per 1 s of speech | voice "Aiden"; 10 languages (no Arabic yet) |

Because TTS is slower than real time on a CPU, a reply is read in **sentence chunks** (`shared/speech.ts`,
`web/src/lib/speaker.ts`): the first (short) chunk plays after ~10 s, and chunk *n+1* is generated while chunk *n*
plays. Code blocks are skipped; headings and bullets become sentences.

Lessons learned:

- **One environment per model**: `qwen-asr` pins `transformers==4.57.6`, `qwen-tts` pins `4.57.3` — they can't share
  a Python environment. Separate containers solve it.
- **More threads ≠ faster**: TTS with 4 threads ≈ 12 threads; 20 threads was 2× slower. It generates audio step by
  step, so per-step latency, not core count, is the limit.
- **Size memory limits from peak, not idle**: TTS idles at ~4.2 GiB; with a 5 GiB limit, Kubernetes **OOMKilled** it
  mid-request (and restarted it automatically). Limits are now 7–8 GiB.
- **Cap generation length**: TTS allowed up to 2048 audio frames (~170 s) by default; a run-away generation grows
  memory. It's now capped at ~2× the expected speech length.

## Run in containers

Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) (WSL 2 engine on Windows). Ollama keeps running on the host because it needs the GPU; containers reach it at `host.docker.internal:11434`.

```
            ┌──────────── Kubernetes (namespace seyl-ai) ────────────┐
Browser ──► │ web ×2 (nginx)  ──/api──►  api ×2  ──►  harness ×1      │ ──► Ollama on the host (GPU)
:8080       │ LoadBalancer               Service  │   Service + disk   │
            │                                     ├─► asr ×1 (CPU)     │
            │                                     └─► tts ×1 (CPU)     │
            └────────────────────────────────────────────────────────┘
```

Five images:

| Image | Built from | Runs |
|---|---|---|
| `seyl-ai/app:dev` | `deploy/app.Dockerfile` | the **api** (default command) *or* the **harness** (`server/harness.ts`) |
| `seyl-ai/web:dev` | `deploy/web.Dockerfile` | nginx serving the built UI, proxying `/api` → `api:3000` (`deploy/nginx.conf`) |
| `seyl-ai/asr:dev` | `voice/asr/Dockerfile` | speech-to-text service (Python, CPU PyTorch, ffmpeg) |
| `seyl-ai/tts:dev` | `voice/tts/Dockerfile` | text-to-speech service (Python, CPU PyTorch) |
| `seyl-ai/gateway:dev` | `gateway/Dockerfile` | LiteLLM with `gateway/config.yaml` baked in |

Plus `postgres:16` for the gateway.

Docker Desktop needs ~12 GB of its memory for everything (the voice models take ~4.5 GB each, LiteLLM ~0.8 GB).
Run the stack in Compose **or** Kubernetes, not both at once.

### Docker Compose

```bash
docker compose up --build -d
npm run gateway:keys
npm run db:setup
```

Open http://localhost:8080. Stop with `docker compose down` (chats are kept in the `opencode-data` volume).

### Kubernetes (Docker Desktop)

Enable Kubernetes in Docker Desktop (kubeadm), build the images, then deploy with Kustomize
(`kustomization.yaml`), which also turns `.env` into a Kubernetes Secret:

```bash
docker compose build
kubectl apply -k .
kubectl -n seyl-ai get pods,svc
```

The in-cluster gateway has its own database, so register the keys once, through a port-forward:

```bash
kubectl -n seyl-ai port-forward svc/litellm 4001:4000
GATEWAY_URL=http://127.0.0.1:4001 npm run gateway:keys
kubectl -n seyl-ai port-forward svc/db 5433:5432
DB_PORT=5433 npm run db:setup
```

Open http://localhost:8080. Things to try:

```bash
kubectl -n seyl-ai delete pod -l app=api          # self-healing: new pods replace them
kubectl -n seyl-ai scale deployment/api --replicas=3
kubectl -n seyl-ai logs deploy/harness
kubectl delete namespace seyl-ai                  # remove everything
```

After changing code: `docker compose build` then `kubectl -n seyl-ai rollout restart deployment`.

| Manifest | Contents |
|---|---|
| `k8s/00-namespace.yaml` | the `seyl-ai` namespace |
| `k8s/10-harness.yaml` | harness Deployment (1 replica, `Recreate`), 1 GiB PersistentVolumeClaim for sessions and the workspace (seeded by an `initContainer`), ClusterIP Service |
| `k8s/20-api.yaml` | api Deployment (2 replicas) with readiness + liveness probes on `/api/healthz`, `preStop` pause, ClusterIP Service |
| `k8s/30-web.yaml` | web Deployment (2 replicas), `preStop` pause, LoadBalancer Service on port 8080 |
| `k8s/40-asr.yaml`, `k8s/50-tts.yaml` | voice Deployments (1 replica each) with a 5 GiB volume for the model, a `startupProbe` that allows 10 min for the first download, memory limits sized from peak usage |
| `k8s/60-postgres.yaml` | Postgres 16 + pgvector (`0.8.6-pg16-trixie`, 1 replica, 2 GiB volume): the gateway's database and seyl-ai's documents; on AWS a managed database (RDS) |
| `k8s/70-litellm.yaml` | the gateway: secrets from the Secret, `DATABASE_URL` composed with `$(POSTGRES_PASSWORD)`, readiness = gateway + database up, not exposed outside the cluster |
| `kustomization.yaml` | lists the manifests; generates the `seyl-secrets` Secret from `.env` (hash-suffixed name, references rewritten) |

Lessons learned while testing rollouts (hammering the API during `rollout restart`):

- **`preStop` pause**: a pod gets SIGTERM before the load balancer stops routing to it. Waiting 5 s first avoids 502s → 110/110 requests OK during an api rollout.
- **Readiness ≠ "my dependencies are up"**: the api's readiness probe first checked the harness too. Restarting the harness then marked *every* api pod unready — a cascading outage. Now readiness only checks the pod itself; harness restarts cost ~2 failed chat-related requests instead of everything.

### Configuration

All settings are environment variables with local-dev defaults (`server/opencode.ts`, `server/index.ts`).
Locally, `.env` is loaded automatically; containers get variables from Compose or the Kubernetes Secret.
The gateway's backends are set in `docker-compose.yml` / `k8s/70-litellm.yaml` (`OLLAMA_API_BASE`, `ASR_API_BASE`, `TTS_API_BASE`).

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `3000` | api |
| `OPENCODE_URL` | `http://127.0.0.1:4097` | api → harness |
| `OPENCODE_HOSTNAME` / `OPENCODE_PORT` | `127.0.0.1` / `4097` | harness |
| `LLM_GATEWAY_URL` | `http://127.0.0.1:4000` | harness and api → LiteLLM |
| `LITELLM_KEY_HARNESS` / `LITELLM_KEY_API` | from `.env` | each consumer's gateway key |
| `SEYL_WORKSPACE` | `./workspace` | folder the agent works in (path inside the harness) |
| `TTS_VOICE` | `Aiden` | api: voice used for read-aloud |
| `TORCH_THREADS` | `8` (asr) / `4` (tts) | voice services: CPU threads |
| `GUARD_MODE` | `enforce` | api: `enforce` / `monitor` / `off` ([Safety](#safety)) |
| `GUARD_STRICT` | `false` | api: also block *Controversial* messages |
| `SEYL_DB_HOST` / `SEYL_DB_PORT` / `SEYL_DB_PASSWORD` | `127.0.0.1` / `5432` / from `.env` | api: seyl-ai's own database |
| `SEYL_API_URL` | `http://127.0.0.1:3000` | harness → the api's MCP tool server |
| `SEYL_MCP_TOKEN` | from `.env` | harness ↔ api: bearer token for `/mcp` |

## Project layout

| Path | What it is |
|---|---|
| `server/harness.ts` | Starts the OpenCode harness with our config |
| `server/opencode.ts` | OpenCode config (model, provider, permissions) + typed client |
| `server/index.ts` | Backend HTTP API (below) |
| `server/translate.ts` | OpenCode sessions/messages/events → our chat model |
| `server/voice.ts` | `/api/voice/*`: forwards to the voice services |
| `shared/chat.ts` | Types shared by backend and UI |
| `shared/speech.ts` | Markdown → speakable text, split into sentence chunks |
| `voice/asr/`, `voice/tts/` | The voice services (Python + Dockerfile each) |
| `gateway/` | LiteLLM config (model list) + Dockerfile |
| `scripts/gateway-keys.ts` | Registers the per-consumer gateway keys (`npm run gateway:keys`) |
| `server/guard.ts`, `server/pii.ts` | Safety filter: Qwen3Guard checks + policy, and the personal-data pattern rules |
| `server/guard-template.json` | Qwen3Guard's official moderation prompt (from `scripts/guard-template.ts`) |
| `server/prompts/seyl-ai.md` | The agent's system prompt |
| `scripts/guard-eval.ts` | Safety filter evaluation (`npm run guard:eval`) |
| `server/documents.ts`, `server/chunk.ts`, `server/db.ts` | Document library: extraction, chunking, embeddings, pgvector search; database connection + tables |
| `server/mcp.ts` | MCP tool server for the agent (search / list / read documents) |
| `scripts/db-setup.ts` | Creates seyl-ai's database, user and the pgvector extension (`npm run db:setup`) |
| `scripts/ask.ts` | Ask through the real API, report tools and answer (`npm run ask -- [--runs N] "…"`) |
| `web/src/App.tsx` | Page layout: sidebar + chat |
| `web/src/hooks/` | `useChat` (history, live events, send, stop), `useConversations`, … |
| `web/src/lib/` | API client, chat reducer, date grouping — plain functions, no React |
| `web/src/components/ui/` | Reusable pieces: `IconButton`, `Collapsible`, `CodeBlock`, `Markdown`, `CopyButton`, `Avatar` |
| `web/src/components/chat/` | `MessageList`, `MessageTurn`, `parts/Reasoning`, `parts/ToolCall`, `Landing`, `ChatHeader` |
| `web/src/components/nav/` | `Sidebar`, `ConversationItem` |
| `web/src/components/input/` | `ChatForm`, `ComposerButton`, `MicButton` (🎤) |
| `web/src/components/chat/SpeakButton.tsx` | 🔊 read aloud, via the shared player in `web/src/lib/speaker.ts` |
| `web/src/components/documents/DocumentsPanel.tsx` | Document library: upload (drag & drop), indexing status, delete |
| `web/src/lib/images.ts` | Shrinks and re-encodes attached images in the browser before upload |
| `web/src/components/chat/PermissionCard.tsx` | The approval card: what, which file, the diff, Allow / Deny |
| `ollama/*.Modelfile` | Model variants: Qwen3.5 9B (32k context), Qwen3.5 0.8B (CPU); the old Qwen3 8B for reference |
| `workspace/` | The only folder the agent can see |

### Backend API

| Method & path | Does |
|---|---|
| `GET /api/model` | Which model is configured |
| `GET /api/conversations` | List conversations |
| `POST /api/conversations` | Create one |
| `DELETE /api/conversations/:id` | Delete one |
| `GET /api/conversations/:id/messages` | History + whether the agent is still working |
| `POST /api/conversations/:id/prompt` | Send a message: `{ text, images? }` (reply arrives on the event stream) |
| `POST /api/conversations/:id/permissions/:requestID` | Answer an approval request: `{ reply: "once" | "always" | "reject" }` |
| `POST /api/conversations/:id/abort` | Stop the agent |
| `GET /api/conversations/:id/events` | Live updates (Server-Sent Events) |
| `GET /api/voice/status` | Which voice services are up (`{ asr, tts }`) |
| `POST /api/voice/transcribe` | Multipart audio (`file`) → `{ text, language }` |
| `POST /api/voice/speak` | `{ text }` (markdown ok) → `audio/wav` |
| `GET /api/documents` | The document library |
| `POST /api/documents` | Multipart `file` (≤ 20 MB) → stored, indexed in the background |
| `DELETE /api/documents/:id` | Remove a document and its passages |
| `POST /mcp` | MCP endpoint for the harness (bearer token; not proxied by nginx) |

## Credits

The UI's look (layout and color tokens) follows [LibreChat](https://github.com/danny-avila/LibreChat) (MIT License, © LibreChat contributors). The components themselves are written for seyl-ai.
