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

## Doctor and evals
BenchMemo now includes lightweight dependency checks plus two eval paths:

```bash
pnpm run doctor
pnpm evals
pnpm evals:live
```

Notes:
- `pnpm run doctor` verifies `OPENAI_API_KEY`, the local `codex` binary, and `codex login status`.
- `pnpm run doctor` is a lightweight readiness check; it does not execute a live `codex exec` probe.
- BenchMemo now runs one merged read-only `repo_scan` per option, rather than separate impact and risk probes.
- Repo probes default to a conservative local posture: `BENCHMEMO_MAX_PARALLEL_PROBES=1`, `BENCHMEMO_CODEX_PROBE_TIMEOUT_MS=45000`, and `BENCHMEMO_CODEX_PROBE_MAX_ATTEMPTS=1`.
- `pnpm evals` runs 5 deterministic stage-driven fixtures:
  - easy winner
  - stale-doc trap
  - hidden-coupling trap
  - need-more-evidence
  - rollback-risk
- `pnpm evals:live` runs a real end-to-end smoke against the local API path and reports `PASS`, `FAIL`, or `SKIPPED`.
- Live smoke failures include the decision id, run timing, repo probe stage timing, and grouped failure kinds with example errors.
- With serialized 45-second probes, `pnpm evals:live` can take several minutes to finish.
- On current `pnpm`, `pnpm doctor` is reserved by pnpm itself, so use `pnpm run doctor` for the BenchMemo doctor command.

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

## Degraded runs
BenchMemo keeps decision runs code-orchestrated and tries to finish with a useful memo even when repo probing is unhealthy.

- If repo probing is blocked by auth, CLI, transport, timeout, or invalid-output issues, the run records structured failed probe outcomes instead of crashing the pipeline.
- When required repo evidence is incomplete, the final memo is forced to `need_more_evidence` with explicit evidence gaps and next steps.
- Repeated platform failures are collapsed into shared memo guidance instead of repeating the same probe error for every option.
