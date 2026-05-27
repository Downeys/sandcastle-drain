# Working on issue #{{ISSUE_NUMBER}}

You are working on GitHub issue **#{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}** in this repository. Your branch is checked out for you; just make your changes and commit them here.

{{SIBLING_CONTEXT}}

## Principles you must follow

Before starting work, read [.sandcastle-drain/staged/principles/README.md](.sandcastle-drain/staged/principles/README.md) and the principle files relevant to the change. Two are mandatory in autonomous Sandcastle-drain runs regardless of topic:

- [.sandcastle-drain/staged/principles/claude-code-modes.md](.sandcastle-drain/staged/principles/claude-code-modes.md) — universal rules + the autonomous-only deltas (token budget, summarize-don't-paste, no-push, no clarification questions, etc.)
- [.sandcastle-drain/staged/principles/context-budget.md](.sandcastle-drain/staged/principles/context-budget.md) — 100k target / 150k ceiling, summarize-don't-paste detail

If your work touches a layer or topic the issue doesn't make obvious, also read the relevant principle file (e.g. domain code → [.sandcastle-drain/staged/principles/domain-modeling.md](.sandcastle-drain/staged/principles/domain-modeling.md), tests → [.sandcastle-drain/staged/principles/testing.md](.sandcastle-drain/staged/principles/testing.md)).

If the issue asks for something the principles forbid (e.g. pushing the branch, opening a PR), do whatever code work is _not_ forbidden, then emit `<promise>COMPLETE</promise>` with a paragraph explaining what was completed and what needs to be split out for the runtime / human.

If the issue is genuinely too big for one run, see the **Splitting a too-big issue** section below — you can hand the wrapper a list of follow-ups to file rather than stopping with a paragraph.

## The issue

The full body and every comment, including any reviewer feedback from a prior attempt:

!`gh issue view {{ISSUE_NUMBER}} --json title,body,labels,comments`

## How to decide what to do

Read the issue carefully and decide what kind of work it requires:

- A code change with behavior the user can observe → use the `tdd` skill (red → green → refactor; commit after each green).
- An open-ended bug or performance regression → use the `diagnose` skill.
- Documentation, configuration, or trivial fixes (one-line, type-only, formatting) → just make the change and commit. Don't invent tests for work that doesn't have testable behavior.
- Anything ambiguous: emit `<promise>COMPLETE</promise>` with a brief explanation of what you'd want clarified, and stop.

If the issue is genuinely too big for a single run, commit what does fit and write the rest into `.sandcastle-drain/splits.json` — see **Splitting a too-big issue** below. Don't half-solve it.

## Tests you run vs. tests the wrapper runs

Targeted only. When you add or change a test, run **just that test file** (e.g. `npx vitest run path/to/added.test.ts`) to confirm it does what you intended. That's it.

**Do not run the full project test suite.** No `npm test`, no `pnpm test`, no bare `vitest`, no `npm run test`. The wrapper runs `typecheck` + `lint` + the full `test` suite in a clean worktree after you emit `<promise>COMPLETE</promise>` — that's the canonical broad-impact check. Running it again here is redundant, eats the idle budget, and is the most common reason a run times out before it can land.

If your scoped test passes and you'd otherwise reach for the full suite "just to be sure," stop and commit instead. The CI gate is the safety net. (This is the autonomous-only tightening of [.sandcastle-drain/staged/principles/claude-code-modes.md](.sandcastle-drain/staged/principles/claude-code-modes.md) "Running tests before commit".)

## Commit messages

Use a Conventional Commits prefix that fits the work — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` — and put `Closes #{{ISSUE_NUMBER}}` in the message body so the merge auto-closes the issue:

```
<prefix>: <short description>

Closes #{{ISSUE_NUMBER}}
```

If you make multiple commits, only the last one needs the `Closes #...` line. Don't always use `feat:` — pick the prefix that matches the actual change.

## Splitting a too-big issue

The 150k context ceiling is real. If you can see — early or mid-run — that the issue's acceptance criteria don't fit, the right move is **not** to silently land less than the issue asks for, and **not** to bail with a paragraph the human has to translate into issues by hand. Instead:

1. Commit whatever scope **does** fit. Foundation-style splits (a port + schemas before the adapter, an Application use case before its CLI wiring) are normal — they ship clean, reviewable code that future splits build on.
2. Before emitting `<promise>COMPLETE</promise>`, write `.sandcastle-drain/splits.json` at the worktree root. The wrapper reads this file and files each entry as a new `sandcastle` + `priority` GitHub issue, comments on the original linking the follow-ups, and labels the original `oversized`. The next drain picks the follow-ups up automatically.

Shape — a JSON array, 1 to 10 entries, each with `title` and `body`:

```json
[
  {
    "title": "PRD-5 slice 3A: Researcher SDK adapter + Anthropic record/replay fixtures",
    "body": "## Parent\n\nSplit out of #N — the foundation landed in commit ...\n\n## What to build\n\n...\n\n## Acceptance criteria\n\n- [ ] ...\n\n## Blocked by\n\n- #N foundation must merge first."
  }
]
```

Rules:

- The `body` is plain markdown — write it the way you'd write any issue body. Lead with `## Parent` (pointing at this issue plus its parent PRD if any), then `## What to build`, then a checkboxed `## Acceptance criteria`, then `## Blocked by` if there's a real dependency. The next implementer's only context is what you write here.
- Don't repeat the entire parent issue's body. Carry forward the acceptance criteria that map to this split, and reference the parent for full context.
- If splits depend on each other, list each predecessor in the `## Blocked by` section by the title of the prior split (the wrapper files them in array order, so a later split can reference an earlier one). Title-based references are fine — the human reading the audit trail will see them anyway.
- 10 entries max. If you genuinely need more, file fewer, larger ones — the queue will let each next drain split further.
- The file must contain a top-level JSON array. No `{ "splits": [...] }` wrapper.

The classic example: commit `c337feb` on `agent/issue-49` landed the Researcher port + system prompt + Zod schemas and named splits A / B / C in its commit message. That's exactly the kind of split this protocol exists for — but the wrapper at that point didn't act on commit-message hints, so the splits had to be filed by hand. Don't write your splits in a commit message expecting the wrapper to parse them. Write them in `.sandcastle-drain/splits.json`.

After writing the file, emit `<promise>COMPLETE</promise>` as usual.

## Do not push or open PRs

Do not run `git push`, `gh pr create`, or any command that publishes work outside this worktree. Your branch stays local — the human will review and push it after the run. (`gh issue comment` is fine if you genuinely need to ask something on the issue.)

## When you are done

Emit `<promise>COMPLETE</promise>` once, on its own line, after your final commit. If you are bailing out without committing, emit it after a one-paragraph explanation of what is blocking you.
