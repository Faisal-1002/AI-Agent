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
