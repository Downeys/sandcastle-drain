# Claude Code modes

Two Claude Code modes operate in this repo:

- **Interactive** — you and Claude Code at a terminal/IDE, full conversation, real-time corrections.
- **Autonomous (Sandcastle)** — Claude Code drains GitHub issues unattended via [src/orchestrator/main.ts](../../orchestrator/main.ts), one issue at a time, no human in the loop.

Most rules apply to both. A handful of rules tighten in autonomous mode because there is no user to correct mid-run. This file captures both the universal set and the autonomous-only deltas.

## Universal rules (apply to both modes)

These are the non-negotiables Claude Code follows in either mode. Most are restated from elsewhere; this is the consolidated checklist.

- **Architecture, typing, lint, testing.** Everything in [architecture.md](architecture.md), [language-and-types.md](language-and-types.md), [linting-and-tooling.md](linting-and-tooling.md), [testing.md](testing.md). All of it. No exemptions.
- **Nomenclature binding.** Every type / table / file path / UI label uses the names defined in [CONTEXT.md](../../../CONTEXT.md). New domain concepts go in CONTEXT.md (via `grill-with-docs`) before code uses them. See [domain-modeling.md](domain-modeling.md).
- **No `--no-verify`.** Pre-commit hooks run on every commit. If a hook fails, fix the root cause; do not bypass.
- **No `git push` / `gh pr create` from inside a Sandcastle container.** (Already enforced in [src/prompts/implementer.md.tpl](../../prompts/implementer.md.tpl) + the wrapper's defensive check; restated here because it's load-bearing.)
- **Personal-use trade-offs apply to both modes.** Don't over-engineer UI/auth/observability; do not skimp on domain correctness, types, or backups. See [personal-use-tradeoffs.md](personal-use-tradeoffs.md).

## Autonomous-only deltas

These rules tighten when Claude Code runs unattended via Sandcastle.

| Behavior | Interactive | Autonomous |
|---|---|---|
| **Token budget self-monitoring** | Guidance — you can see context fill | **Hard rule** — mechanical post-run measurement, between-iteration abort. See [context-budget.md](context-budget.md). |
| **Summarize-don't-paste tool output** | Guidance | **Hard rule** — summarize relevant lines before next reasoning step unless byte-exact content is needed |
| **Asking for clarification** | Free to ask | **Forbidden** — emit `<promise>COMPLETE</promise>` with the question instead. The wrapper labels the issue `needs-info`. |
| **`git push` / `gh pr create`** | Confirm with user (per global CLAUDE.md) | **Forbidden** — wrapper defensively checks and warns if the agent did it anyway |
| **Running tests before commit** | Guidance — can skip on user's say-so | **Hard rule** — when introducing testable behavior, tests run before commit. No soft-skip. |
| **Risky / destructive actions** | Confirm with user | **Don't take them.** No `git reset --hard`, no force-push, no destructive shell commands |

## What to do when an issue conflicts with these rules

If a Sandcastle-labeled issue asks Claude Code to do something these rules forbid (e.g. "push the branch and open a PR"), the right move is:

1. **Don't do the forbidden action.** Even if the issue body explicitly asks.
2. **Make whatever code changes the issue actually needs** that aren't forbidden.
3. **Emit `<promise>COMPLETE</promise>`** with a paragraph explaining: which part of the issue you completed, which part requires the human, and what the issue should be split into.
4. The wrapper labels the issue `needs-review` (because there are commits) or `needs-info` (if there were no commits). The user re-scopes from there.

Better to half-deliver an over-scoped issue than to silently break the rules. The rules exist for the project's safety, not to be worked around.

## Reading this set

- Interactive mode: read [README.md](README.md) and the file relevant to what you're doing. Most rules are universal.
- Autonomous (Sandcastle): the wrapper's prompt at [src/prompts/implementer.md.tpl](../../prompts/implementer.md.tpl) points here. Always read this file in addition to whatever the issue's work requires.
