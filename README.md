# seyl-ai

My own AI agent — a local web app built on the [OpenCode](https://github.com/anomalyco/opencode) harness, running open models (Qwen3.5) on my own GPU.

## How it works

```
Browser (React)               localhost:5173   web/          chat UI
   │  HTTP + Server-Sent Events
   ▼
seyl-ai backend (Hono)        localhost:3000   server/       my code: sessions, prompts, event translation
   │  @opencode-ai/sdk
   ▼
OpenCode harness              localhost:4097   server/harness.ts   agent loop, tools, permissions
   │  OpenAI-compatible API
   ▼
Ollama runtime                localhost:11434                inference
   │
   ├─▶ Qwen3.5 9B   (GPU, 32k context)          main model: agent loop, tools, images
   └─▶ Qwen3.5 0.8B (CPU, no thinking)          small model: chat titles
```

- **Models** — Qwen3.5 9B is the "brain"; Qwen3.5 0.8B handles quick jobs (OpenCode's `small_model`). Just weights; they can't run on their own.
- **Ollama** — the runtime that loads the weights onto the GPU and serves them over HTTP.
- **OpenCode** — the harness: runs the agent loop (model → tool call → result → model …), provides tools (read, grep, glob, …), and enforces permissions.
- **Backend** — conversations (= OpenCode sessions), prompts, stop, history, and a live event stream; translates OpenCode's data into a small model the UI understands (`server/translate.ts`, types in `shared/chat.ts`).
- **Web UI** — a chat app in the style of LibreChat: conversation sidebar, streamed markdown replies, collapsible "Thoughts" and tool calls (with their input and output), stop button, light/dark theme.

The agent can only see files in [`workspace/`](workspace). For now it's **read-only**: edits, shell commands and web fetches are denied (see `permission` in `server/opencode.ts`).

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
```

### Models

| Model | Where | Speed (RTX 3080) | Why |
|---|---|---|---|
| `seyl-qwen3.5-9b` | GPU, 6.5 GB incl. 32k context | ~79 tokens/s | Agent loop, tools, thinking, images. Hybrid attention keeps long context cheap. |
| `seyl-qwen3.5-0.8b` | CPU (`num_gpu 0`) | title in ~3 s | Titles. Thinking disabled with `reasoningEffort: "none"`. |

Lesson learned: with both models on a 10 GB GPU (plus the Windows desktop), VRAM overflowed and Windows
spilled it into system RAM — generation dropped from ~46 to ~1 token/s. Keep the GPU for one model and put
small helpers on the CPU. Check with `ollama ps` (PROCESSOR column) and `nvidia-smi`.

## Run

```bash
npm run dev
```

Then open http://localhost:5173 and ask something like *"Read notes.md and tell me the project codename."*

Voice is optional; to use it with `npm run dev`, start the voice containers: `docker compose up -d asr tts`.

## Voice

```
🎤 mic button ──► POST /api/voice/transcribe ──► asr  (Qwen3-ASR 0.6B, CPU) ──► text in the message box
🔊 read aloud ──► POST /api/voice/speak      ──► tts  (Qwen3-TTS 0.6B, CPU) ──► audio, sentence by sentence
```

- Each voice model is a small Python (FastAPI) service in its own container — `voice/asr`, `voice/tts` — with an
  **OpenAI-compatible** API (`/v1/audio/transcriptions`, `/v1/audio/speech`), so it could later be swapped for a
  hosted service or put behind a gateway like LiteLLM. Ollama can't serve audio models.
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

Four images:

| Image | Built from | Runs |
|---|---|---|
| `seyl-ai/app:dev` | `deploy/app.Dockerfile` | the **api** (default command) *or* the **harness** (`server/harness.ts`) |
| `seyl-ai/web:dev` | `deploy/web.Dockerfile` | nginx serving the built UI, proxying `/api` → `api:3000` (`deploy/nginx.conf`) |
| `seyl-ai/asr:dev` | `voice/asr/Dockerfile` | speech-to-text service (Python, CPU PyTorch, ffmpeg) |
| `seyl-ai/tts:dev` | `voice/tts/Dockerfile` | text-to-speech service (Python, CPU PyTorch) |

Docker Desktop needs ~12 GB of its memory for everything (the voice models take ~4.5 GB each).

### Docker Compose

```bash
docker compose up --build -d
```

Open http://localhost:8080. Stop with `docker compose down` (chats are kept in the `opencode-data` volume).

### Kubernetes (Docker Desktop)

Enable Kubernetes in Docker Desktop (kubeadm), build the images, then:

```bash
docker compose build
kubectl apply -f k8s/
kubectl -n seyl-ai get pods,svc
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
| `k8s/10-harness.yaml` | harness Deployment (1 replica, `Recreate`), 1 GiB PersistentVolumeClaim for sessions, ClusterIP Service |
| `k8s/20-api.yaml` | api Deployment (2 replicas) with readiness + liveness probes on `/api/healthz`, `preStop` pause, ClusterIP Service |
| `k8s/30-web.yaml` | web Deployment (2 replicas), `preStop` pause, LoadBalancer Service on port 8080 |
| `k8s/40-asr.yaml`, `k8s/50-tts.yaml` | voice Deployments (1 replica each) with a 5 GiB volume for the model, a `startupProbe` that allows 10 min for the first download, memory limits sized from peak usage |

Lessons learned while testing rollouts (hammering the API during `rollout restart`):

- **`preStop` pause**: a pod gets SIGTERM before the load balancer stops routing to it. Waiting 5 s first avoids 502s → 110/110 requests OK during an api rollout.
- **Readiness ≠ "my dependencies are up"**: the api's readiness probe first checked the harness too. Restarting the harness then marked *every* api pod unready — a cascading outage. Now readiness only checks the pod itself; harness restarts cost ~2 failed chat-related requests instead of everything.

### Configuration

All settings are environment variables with local-dev defaults (`server/opencode.ts`, `server/index.ts`):

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `3000` | api |
| `OPENCODE_URL` | `http://127.0.0.1:4097` | api → harness |
| `OPENCODE_HOSTNAME` / `OPENCODE_PORT` | `127.0.0.1` / `4097` | harness |
| `OLLAMA_URL` | `http://localhost:11434` | harness → Ollama |
| `SEYL_WORKSPACE` | `./workspace` | folder the agent works in (path inside the harness) |
| `ASR_URL` / `TTS_URL` | `http://127.0.0.1:8001` / `:8002` | api → voice services |
| `TTS_VOICE` | `Aiden` | api: voice used for read-aloud |
| `TORCH_THREADS` | `8` (asr) / `4` (tts) | voice services: CPU threads |

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
| `web/src/App.tsx` | Page layout: sidebar + chat |
| `web/src/hooks/` | `useChat` (history, live events, send, stop), `useConversations`, … |
| `web/src/lib/` | API client, chat reducer, date grouping — plain functions, no React |
| `web/src/components/ui/` | Reusable pieces: `IconButton`, `Collapsible`, `CodeBlock`, `Markdown`, `CopyButton`, `Avatar` |
| `web/src/components/chat/` | `MessageList`, `MessageTurn`, `parts/Reasoning`, `parts/ToolCall`, `Landing`, `ChatHeader` |
| `web/src/components/nav/` | `Sidebar`, `ConversationItem` |
| `web/src/components/input/` | `ChatForm`, `ComposerButton`, `MicButton` (🎤) |
| `web/src/components/chat/SpeakButton.tsx` | 🔊 read aloud, via the shared player in `web/src/lib/speaker.ts` |
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
| `POST /api/conversations/:id/prompt` | Send a message (reply arrives on the event stream) |
| `POST /api/conversations/:id/abort` | Stop the agent |
| `GET /api/conversations/:id/events` | Live updates (Server-Sent Events) |
| `GET /api/voice/status` | Which voice services are up (`{ asr, tts }`) |
| `POST /api/voice/transcribe` | Multipart audio (`file`) → `{ text, language }` |
| `POST /api/voice/speak` | `{ text }` (markdown ok) → `audio/wav` |

## Credits

The UI's look (layout and color tokens) follows [LibreChat](https://github.com/danny-avila/LibreChat) (MIT License, © LibreChat contributors). The components themselves are written for seyl-ai.
