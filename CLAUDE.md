# Project

## Development principles

Read [docs/principles/README.md](docs/principles/README.md) before starting work. The principle files apply to every commit; the Sandcastle reviewer enforces them.

## Domain context and decisions

- [CONTEXT.md](CONTEXT.md) — canonical domain vocabulary. Populate this before writing domain code; the reviewer enforces nomenclature binding against it.
- [docs/adr/](docs/adr/) — architectural decisions. Add one per material decision (format: `NNNN-short-title.md`). The reviewer flags diffs that contradict an ADR.

## Agent skills

### Issue tracker

Issues live as GitHub issues. Use the `gh` CLI. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Five canonical triage-state labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus the Sandcastle workflow labels (`sandcastle`, `in-progress`, `needs-review`, `blocked`, `retry`, `priority`, `oversized`, `skipped-this-run`). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Reviewer

Advisory reviewer sub-agent invoked by the Sandcastle wrapper after the implementer commits. Read-only against the worktree; eager-loads every `docs/principles/*.md`, `CONTEXT.md`, and the `docs/adr/` index, then applies a four-category rubric (domain integrity, test discipline, architecture intent, glossary & ADR alignment) and emits a structured JSON verdict. The wrapper renders the verdict as a separate GitHub issue comment alongside the existing status comment. **Advisory only** — a `FAIL` verdict surfaces findings for the human reviewer but does not gate the merge. See [.sandcastle/reviewer.md](.sandcastle/reviewer.md) (prompt) and [.sandcastle/reviewer.ts](.sandcastle/reviewer.ts) (parsing + comment formatting). Per-issue transcript is copied to `.sandcastle/logs/issue-N-reviewer.log`.
