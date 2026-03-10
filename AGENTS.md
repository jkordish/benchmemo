# BenchMemo AGENTS.md

## Repo-wide rules
- Prefer deterministic, typed outputs over conversational free-form output.
- The workflow is code-orchestrated. Do not collapse it into one giant manager prompt.
- For engineering decisions, claims must be paired with evidence IDs or explicitly marked unresolved.
- For Codex probe tasks, default to read-only analysis. Do not modify files unless explicitly requested.
- Keep prompts short, explicit, and audit-friendly.
