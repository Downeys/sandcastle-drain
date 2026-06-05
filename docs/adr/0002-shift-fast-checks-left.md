# 0002 — Shift fast checks left into the implementer

## Context

Every quality check used to live post-handoff. The implementer ([src/prompts/implementer.md.tpl](../../src/prompts/implementer.md.tpl)) was explicitly told **not** to run checks — only the single test file it touched — and the wrapper's CI gate ([src/orchestrator/ci-gate.ts](../../src/orchestrator/ci-gate.ts)) ran `install → typecheck → lint → test` (full suite) in a clean worktree after the agent emitted `<promise>COMPLETE</promise>`. When that gate went red, the fixer sub-agent ([src/prompts/fixer.md.tpl](../../src/prompts/fixer.md.tpl)) was spawned to recover the branch.

That arrangement was deliberate: an earlier version had the implementer running the **full test suite**, which "eats the idle budget, and is the most common reason a run times out before it can land" — a large suite runs for minutes with long silent stretches the idle watcher can't see, and the same reasoning is why in-sandbox git hooks are disabled (`HUSKY=0`, see [main.ts](../../src/orchestrator/main.ts) implementer `run()` call site).

The cost surfaced in testing: the fixer was being spawned for trivial typecheck and lint errors — a whole second agent, sandbox, and CI re-gate to fix a one-line type error the implementer could have caught itself. The fixer's worthwhile job is stray unit-test breakage, not lint cleanup.

The key realization is that "checks are too slow to run in the implementer" was only ever true of the **full test suite**. Typecheck and lint are fast (seconds to low minutes), stream output continuously, and catch most of the "should've been caught" failures. Tests scoped to the change are similarly cheap.

## Decision

Split checks by cost. The **implementer runs the fast checks before handoff**; the **slow full suite stays in the CI gate**.

1. **Fast/slow split.** Before emitting `<promise>COMPLETE</promise>`, the implementer runs its project's `typecheck` and `lint` scripts (the same scripts the gate runs, so the preview is faithful to the gate) plus the unit tests **related to its changed files** (`npx vitest related --run <changed files>`). The full `test` suite remains the wrapper's job, post-handoff, in a clean worktree.

2. **Related, not just new-file.** Scoped tests mean tests *related to the changed source* (Vitest's module-graph `related` mode — already what [linting-and-tooling.md](../../src/content/principles/linting-and-tooling.md) prescribes for the Husky hook), not only the test file the implementer authored. This is the tightest scope that still catches "my refactor broke a sibling's test," which was the most common avoidable fixer trigger.

3. **Prompt-only, not an enforced gate.** The check is added as a mandatory instruction in the implementer prompt — not a re-enabled pre-commit hook and not a new wrapper-side pre-flight gate. A hook reintroduces the `HUSKY=0` trap (silent budget burn the idle watcher can't see); a wrapper-side gate just duplicates the fixer loop. Prompt-only fails gracefully: if the agent skips the check, we land exactly where we are today (the gate + fixer catch it), so we lose nothing and gain on every compliant run.

4. **Bounded effort to fix.** The implementer *must run* the checks but only chases failures its change caused that are quick to fix. A failure needing substantial/design-level work, a pre-existing failure, or one surfacing near the budget → emit `<promise>COMPLETE</promise>` and let the gate + fixer handle it. This mirrors the fixer's own "surgical only, bail on design-level" rule and makes it impossible for the pre-handoff check to trap the agent into a timeout.

5. **Fixer unchanged.** The fixer stays general (typecheck / lint / test) as defense-in-depth for failures that slip past the implementer. We changed the *expected frequency* of typecheck/lint failures reaching it, not its scope.

## Consequences

- **Both the implementer and the CI gate run typecheck + lint.** This looks redundant and is intentional: the implementer's run is fast feedback that avoids a fixer round-trip; the gate's run is the canonical check in a clean, frozen-install worktree (catching lockfile drift / missing-dep failures a dirty worktree hides). The redundancy is the point — do not "simplify" it by removing the checks from the implementer without re-reading this ADR.
- **The fixer should now fire mainly for genuine non-local test breakage** — tests that don't statically import the changed files (dynamic wiring, integration tests, snapshot drift). Occasional lint/type slips still reach it; that's accepted.
- **Documented retreat path.** If `related`-test runs prove too costly in the implementer's budget, the staged fallback is to narrow scope back to the new-file-only test run, or to leave all test breakage to the fixer — a later-release decision, anticipated here, not an oversight.
- **The `related` command is Vitest-specific.** The prompt names it with an "or your test runner's equivalent" escape, consistent with the principle set already committing to Vitest. A host project on a different runner relies on the agent mapping the intent.
