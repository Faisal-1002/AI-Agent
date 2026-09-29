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
- **Backend** — creates sessions, sends prompts, and translates OpenCode's event stream into a small set of events the UI understands (`server/events.ts`).
- **Web UI** — shows the conversation, the model's thinking, and tool calls live.

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
| `server/index.ts` | Backend HTTP API: create session, send prompt, stream events |
| `server/events.ts` | Translates OpenCode events → UI events |
| `web/src/App.tsx` | Chat UI |
| `ollama/Modelfile` | Qwen3 8B with a 16k context window |
| `workspace/` | The only folder the agent can see |
