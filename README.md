# Lanifex

<div align="center">
  <img src="public/logos/lf-mark-tight.png" width="96" alt="Lanifex"><br>
  <b>Self-hosted AI planning tool</b> - from raw idea to PRD, features, tasks, and a ready-to-run prompt for your coding agent.<br>
  <a href="README.id.md">Bahasa Indonesia</a> | English
</div>

---

## The name

**Lanifex** comes from Latin: *lāna* (wool) + *-fex* ("maker", from *facere* - as in *artifex*, the craftsman, or *opifex*, the workman). Roughly: **"the weaver"** - one who weaves separate threads into a single, whole fabric.

That is exactly what this tool does: it weaves a messy idea, thread by thread, into something complete and ready to build - clarifying questions, a PRD, a feature list, ordered tasks, and a prompt your coding agent can execute.

## Why Lanifex

Most "AI planning" workflows die in a chat window. Lanifex moves them into a self-hosted web app that becomes the **single source of truth** between you and your coding agent (Claude Code, Codex, OpenCode, etc):

- **5-step wizard** - Idea → Tech stack (AI picks, or you decide) → AI clarifying questions → PRD (streamed) → Features & Tasks
- **Living PRD** - full markdown with acceptance criteria and roadmap, revisable with plain instructions
- **Agent prompt + access token** - copy-paste prompt containing a per-plan scoped token; the agent works through tasks one by one and reports back
- **Agent CLI** - `lanifex task next/start/complete/fail` with per-layer/per-phase checkpoints, so agents don't skip around
- **Monitoring** - progress %, an `on progress` tag on running tasks, auto-refresh
- **Bring your own model** - from the UI (Settings page): point at any OpenAI-compatible endpoint, list its models, assign different models per stage, no container rebuild needed. Env vars still work as fallback.
- **Multi-user + owner mode** - first account becomes the owner, public registration closes automatically, owner can create accounts for others
- **Wizard resume** - leave mid-planning and come back exactly where you stopped, answers intact
- **Zero dependencies** - Node 22 + `node:sqlite` only. Frontend is a single HTML file, no build step, no framework.

## Deploy (Docker)

```bash
git clone https://github.com/rodwell311/lanifex.git
cd lanifex
cp .env.example .env
# edit .env - point LLM_BASE_URL at any OpenAI-compatible provider
docker compose up -d --build
# open http://localhost:8788
```

Requirements: Docker + Compose v2. Change the port via `PORT` in `.env`.

### LLM configuration

Everything in `.env` can be overridden from the **UI → Settings** (database values win):

```bash
LLM_BASE_URL=http://host.docker.internal:20128/v1   # any OpenAI-compatible endpoint
LLM_API_KEY=sk-...
LLM_MODEL=code                                       # main model
LLM_MODEL_QUESTIONS=...                              # optional: per-stage models
LLM_MODEL_PRD=...
LLM_MODEL_FEATURES=...

MOCK_LLM=1                                           # demo without a provider - deterministic output
```

Works with: OpenAI, OpenRouter, Groq, vLLM, LiteLLM, Ollama (`/v1`), LM Studio, and other compatible gateways.

<details>
<summary>Is your LLM gateway a container on the same host, bound to 127.0.0.1?</summary>

`host.docker.internal` cannot reach ports bound to the host's `127.0.0.1`. Fix: join the gateway container's network - `compose.yaml` ships with an optional `networks.router` block (external):

```bash
docker inspect <gateway> --format '{{json .NetworkSettings.Networks}}'  # find the network name
# set LLM_BASE_URL=http://<gateway-container>:<port>/v1
```

Point the network name with `LLM_NET=<name>` or remove the `networks` block if you don't need it.
</details>

## Usage flow

1. **Web** → create an account (the first one becomes the owner) → **+ New plan** → write your idea
2. Answer the clarifying questions → PRD generates (streaming, revisable) → **Split into Features & Tasks**
3. **Agent prompt** → copy the prompt containing your token → paste it into your coding agent
4. The agent runs the loop:
   ```bash
   node cli.js login --server http://localhost:8788 --token lf_xxx
   node cli.js plan get 1
   node cli.js task next --plan 1 --json    # one task, pauses on layer/phase change
   node cli.js task start T1 && node cli.js task complete T1
   ```
5. The dashboard shows live progress - active tasks are tagged `on progress`

## Architecture

```
server.js          # HTTP + SQLite + LLM client + API - one file, zero dependencies
cli.js             # agent CLI (login / plan / task loop)
public/index.html  # wizard + dashboard SPA - single file, no build
Dockerfile         # node:22-alpine
compose.yaml       # port 8788, data/ volume, host.docker.internal
```

**API**: `/api/auth/*`, `/api/plan/*`, `/api/settings*`, `/api/agent/*` (tokens `lf_`).
**DB**: SQLite at `data/lanifex.db` (volume) - tables `users, sessions, api_tokens, plans, features, tasks`.

## Test

```bash
bash smoke.sh    # mock end-to-end: register → PRD → features/tasks → token → CLI loop → progress
```

## Limitations

- Built as an independent re-implementation based on observing the behavior of an existing AI planning product - all code was written from scratch, nothing copied.
- Not implemented yet: payments/quotas, interactive revision chat, codebase sync, multi-workspace.

## License

MIT
