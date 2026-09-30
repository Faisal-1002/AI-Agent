# seyl-ai

My own AI agent — a local web app built on the [OpenCode](https://github.com/anomalyco/opencode) harness, running an open model (Qwen3) on my own GPU.

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
Ollama runtime                localhost:11434                inference on the GPU
   │
   ▼
Qwen3 8B (16k context)                         ollama/Modelfile
```

- **Model** — Qwen3 8B, the "brain". Just weights; can't run on its own.
- **Ollama** — the runtime that loads the weights onto the GPU and serves them over HTTP.
- **OpenCode** — the harness: runs the agent loop (model → tool call → result → model …), provides tools (read, grep, glob, …), and enforces permissions.
- **Backend** — conversations (= OpenCode sessions), prompts, stop, history, and a live event stream; translates OpenCode's data into a small model the UI understands (`server/translate.ts`, types in `shared/chat.ts`).
- **Web UI** — a chat app in the style of LibreChat: conversation sidebar, streamed markdown replies, collapsible "Thoughts" and tool calls (with their input and output), stop button, light/dark theme.

The agent can only see files in [`workspace/`](workspace). For now it's **read-only**: edits, shell commands and web fetches are denied (see `permission` in `server/opencode.ts`).

## Requirements

- Node.js 24+
- [Ollama](https://ollama.com) with `qwen3:8b` pulled
- OpenCode: `npm install -g opencode-ai`

## Setup

```bash
npm install
ollama pull qwen3:8b
ollama create seyl-qwen3-8b -f ollama/Modelfile
```

## Run

```bash
npm run dev
```

Then open http://localhost:5173 and ask something like *"Read notes.md and tell me the project codename."*

## Run in containers

Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) (WSL 2 engine on Windows). Ollama keeps running on the host because it needs the GPU; containers reach it at `host.docker.internal:11434`.

```
            ┌──────────── Kubernetes (namespace seyl-ai) ────────────┐
Browser ──► │ web ×2 (nginx)  ──/api──►  api ×2  ──►  harness ×1      │ ──► Ollama on the host (GPU)
:8080       │ LoadBalancer               Service      Service + disk   │
            └────────────────────────────────────────────────────────┘
```

Two images, built from `deploy/`:

| Image | Built from | Runs |
|---|---|---|
| `seyl-ai/app:dev` | `deploy/app.Dockerfile` | the **api** (default command) *or* the **harness** (`server/harness.ts`) |
| `seyl-ai/web:dev` | `deploy/web.Dockerfile` | nginx serving the built UI, proxying `/api` → `api:3000` (`deploy/nginx.conf`) |

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
| `k8s/20-api.yaml` | api Deployment (2 replicas) with readiness (`/api/readyz`) and liveness (`/api/healthz`) probes, ClusterIP Service |
| `k8s/30-web.yaml` | web Deployment (2 replicas), LoadBalancer Service on port 8080 |

### Configuration

All settings are environment variables with local-dev defaults (`server/opencode.ts`, `server/index.ts`):

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `3000` | api |
| `OPENCODE_URL` | `http://127.0.0.1:4097` | api → harness |
| `OPENCODE_HOSTNAME` / `OPENCODE_PORT` | `127.0.0.1` / `4097` | harness |
| `OLLAMA_URL` | `http://localhost:11434` | harness → Ollama |
| `SEYL_WORKSPACE` | `./workspace` | folder the agent works in (path inside the harness) |

## Project layout

| Path | What it is |
|---|---|
| `server/harness.ts` | Starts the OpenCode harness with our config |
| `server/opencode.ts` | OpenCode config (model, provider, permissions) + typed client |
| `server/index.ts` | Backend HTTP API (below) |
| `server/translate.ts` | OpenCode sessions/messages/events → our chat model |
| `shared/chat.ts` | Types shared by backend and UI |
| `web/src/App.tsx` | Page layout: sidebar + chat |
| `web/src/hooks/` | `useChat` (history, live events, send, stop), `useConversations`, … |
| `web/src/lib/` | API client, chat reducer, date grouping — plain functions, no React |
| `web/src/components/ui/` | Reusable pieces: `IconButton`, `Collapsible`, `CodeBlock`, `Markdown`, `CopyButton`, `Avatar` |
| `web/src/components/chat/` | `MessageList`, `MessageTurn`, `parts/Reasoning`, `parts/ToolCall`, `Landing`, `ChatHeader` |
| `web/src/components/nav/` | `Sidebar`, `ConversationItem` |
| `web/src/components/input/` | `ChatForm`, `ComposerButton` |
| `ollama/Modelfile` | Qwen3 8B with a 16k context window |
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

## Credits

The UI's look (layout and color tokens) follows [LibreChat](https://github.com/danny-avila/LibreChat) (MIT License, © LibreChat contributors). The components themselves are written for seyl-ai.
