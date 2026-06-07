# 0004 — Visual-Iteration Engine as a drain pipeline step

## Context

The drain produced UIs that needed manual tweaking after shipping. The [[Visual-Iteration Engine]] (see [0003](0003-owns-visual-iteration-engine.md)) is the fix, but it has to plug into the existing drain without breaking the implement/review separation the loop is built on.

Two existing constraints shape the integration:

- The drain is **label-driven** (`sandcastle`, `priority`, `oversized`, … — see the README label set). Not every issue in a UI-capable project is a UI issue.
- The only existing gate-on-failure mechanism is `handleRejection` ([src/orchestrator/main.ts](../../src/orchestrator/main.ts)), which **tags and discards the branch** and files a `[follow-up #N]` issue. That is correct for a code-rejected diff (clean restart from `main`) but destructive for an *editor* whose entire output is work worth keeping.

## Decision

The engine runs as a pipeline step, gated per-issue, and **annotates rather than rejects**.

1. **Pipeline placement.** `implementer → ci → fixer → [Visual-Iteration Engine] → ci → fixer → Code Reviewer`. The engine runs *before* the Code Reviewer so its edits are themselves audited; it runs *after* a ci/fixer pass because it must serve a working build to render it (a broken build can't be screenshotted). The trailing ci/fixer catches any build/type/test breakage the engine's edits introduced.

2. **Per-issue gate: the `ui` label.** The engine runs iff the issue carries `ui` (added to the canonical auto-created label set). Purely label-based — no diff-path heuristics. Project-level skipping is free: a project with no [[Visual rubric]] file never runs the engine regardless of labels.

3. **Targets from the issue body.** The route(s) to capture come from a `## Visual targets` section in the issue body, parsed like [`parseBlockedBy`](../../src/orchestrator/blocked-by.ts). Full-page screenshot, one per route per breakpoint (default 375/768/1440), no scripted interaction states in v1. Missing section on a `ui` issue degrades to capturing `/`, noted in the report.

4. **Editor, not rejecter.** The engine iterates `capture → critique → edit → recapture` to a ceiling of **3** (one batched edit + one rebuild per iteration). On success it leaves polished UI on the branch. On ceiling-fail it **commits its best effort** and the issue is parked at `needs-review` — it never routes through `handleRejection`, which would throw the polish away.

5. **Gating via the existing auto-merge conjunction.** The engine does **not** short-circuit the Code Reviewer, which still runs and may reject on code grounds (then the normal rejection flow applies). The visual verdict becomes a third conjunct on the auto-merge gate at [main.ts](../../src/orchestrator/main.ts) (today `commits > 0 && ciResult.ok && reviewerVerdict === 'PASS'`), adding `&& (visual not applicable || visual passed)`. A visual ceiling-fail therefore makes the issue "not land," which both blocks auto-merge and — via the existing `failedThisRun` machinery — skips any dependent issue naming it under `## Blocked by`. No new dependent-skipping code is required.

## Consequences

- **A visually-incomplete UI never auto-merges, but its polish is preserved** for a human to finish — the opposite of `handleRejection`'s discard. This is a deliberate divergence: a future reader will see the engine bypass the standard rejection path and should not "fix" it to match.
- **Three terminal outcomes for a `ui` issue:** (a) Code Reviewer FAIL → normal rejection (visual outcome irrelevant); (b) Code Reviewer PASS + visual PASS → auto-merge; (c) Code Reviewer PASS + visual ceiling-fail → `needs-review`, branch preserved, dependents skipped.
- **The `ui` label and the visual verdict are part of the public contract.** Per the README's versioning discipline, adding the visual verdict to the set of outcomes hosts can observe is a major-version change.
- **Ceiling is 3 to start**, deliberately low because each iteration carries a rebuild. Raising it is a one-line default change if 3 proves too shallow.
