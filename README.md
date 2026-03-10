# BenchMemo

Evidence-backed debate engine for engineering decisions.

## Why this shape
BenchMemo treats a decision like a pipeline, not a chatbot:
- frame the decision
- generate pro and con cases per option
- probe the repo with Codex in read-only mode
- verify claims against docs / web / repo evidence
- score options deterministically
- emit a final memo with dissent and evidence gaps

## Workspace
- `apps/api` - orchestrator, agents, state machine
- `packages/shared` - schemas and shared types
- `workers/codex-runner` - thin wrapper around `codex exec`

## Local setup
```bash
pnpm install
pnpm --filter @benchmemo/api dev
```

### Required env vars
- `OPENAI_API_KEY`
- `CODEX_API_KEY` (optional if you already authenticate Codex another way)

### Codex CLI
Install the Codex CLI so `codex` is on your PATH.

```bash
npm install -g @openai/codex
```

## HTTP API
Start the API:

```bash
pnpm dev:api
```

Create a decision run:

```bash
curl -X POST http://127.0.0.1:3000/decisions \
  -H 'content-type: application/json' \
  -d @decision-brief.json
```

Fetch run status and final memo:

```bash
curl http://127.0.0.1:3000/decisions/dec_001
```

Run data is stored in `.benchmemo-data/` during local development.
