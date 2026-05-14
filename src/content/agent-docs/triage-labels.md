# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker, plus the workflow labels the Sandcastle wrapper auto-manages.

## Triage state labels

Used by the `triage` skill's state machine.

| Label in mattpocock/skills | Label in our tracker | Meaning                                 |
| -------------------------- | -------------------- | --------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue |
| `needs-info`               | `needs-info`         | Waiting for more information (see note) |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation           |
| `wontfix`                  | `wontfix`            | Will not be actioned                    |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

> **Note on `needs-info`:** the Sandcastle wrapper at `src/orchestrator/main.ts` also writes this label automatically whenever a run produces 0 commits — bail-out, timeout, or hard error. See the workflow section below. Same label, two writers (you, manually, and the wrapper).

## Sandcastle workflow labels

Eight labels that exist only for the Sandcastle wrapper at `src/orchestrator/main.ts`. `sandcastle`, `blocked`, and `retry` are user-applied; `in-progress`, `needs-review`, `priority`, `oversized`, and `skipped-this-run` are wrapper-managed — don't touch them by hand unless you're recovering from a crashed run.

| Label          | Applied when                                                                                                                                                                                                                      | Removed when                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sandcastle`   | Issue is queued for the agent. Apply manually.                                                                                                                                                                                    | Wrapper transitions the issue to `needs-review` or `needs-info`.                                                    |
| `in-progress`  | Wrapper picks up the issue at the start of a run.                                                                                                                                                                                 | Wrapper finishes the run (any outcome).                                                                             |
| `needs-review` | Wrapper finishes a run that produced commits — success OR partial work after timeout/abort, both go here.                                                                                                                         | Manually, after review.                                                                                             |
| `blocked`      | Skip this issue. Apply manually when blocked.                                                                                                                                                                                     | Manually, once unblocked.                                                                                           |
| `retry`        | You apply alongside `sandcastle` to discard a prior agent attempt and re-run.                                                                                                                                                     | Wrapper removes it as part of the retry handling on the next drain.                                                 |
| `priority`     | Wrapper applies to a rejection-loop follow-up issue (alongside `sandcastle`). The drain serves `priority`-labeled issues before unflagged ones, then by issue number. May also be applied manually to jump-the-queue urgent work. | Manually, after the issue is resolved or no longer urgent.                                                          |
| `oversized`    | Wrapper applies to a parent issue when its implementer wrote `.sandcastle/splits.json` during the run and the wrapper filed the listed follow-ups. Audit trail signal — see the **split protocol** section below.                 | Manually, when the follow-ups have all landed and the parent can be closed (or kept open as a tracker — your call). |
| `skipped-this-run` | Wrapper applies when a drain bypassed the issue without running the agent — blocked-by-failed-sibling, an existing `agent/issue-N` branch already in place, or the rate-limit tail of a curtailed drain. The accompanying comment names the reason. | Wrapper removes it at the start of the next outcome block so a successful run never carries a stale breadcrumb.       |

The wrapper also writes the triage-state `needs-info` label as one of the run outcomes — see the state machine below.

The wrapper drains in this order: `priority`-labeled `sandcastle` issues first (oldest by issue number), then unflagged `sandcastle` issues (oldest by issue number). Issues with `in-progress` or `blocked` are skipped at queue-fetch time.

## Outcome state machine

After every `sandcastle.run()`, the wrapper:

1. Posts a status comment on the issue containing the run's status string, branch name, commit count + SHAs, last ~50 lines of agent stdout in a `<details>` block, and the host-side log file path. This is best-effort; if `gh` fails, the run still proceeds.
2. Runs the CI gate, then the advisory reviewer sub-agent. Both produce comments on the issue.
3. Applies labels:

   | Run outcome                                                        | Label change                                                                                                                                                                                                                                    |
   | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Commits + CI green + reviewer `PASS` → wrapper auto-ships + sweeps | remove `in-progress` + `sandcastle` (issue auto-closed by squash-merge `Closes #N`)                                                                                                                                                             |
   | Commits + reviewer `FAIL` → rejection loop                         | remove `in-progress` + `sandcastle`; tag `rejected/issue-N-attempt-K`; discard branch; open a follow-up issue with `sandcastle` + `priority`; comment on the original. The original gets no new label — the follow-up carries the work forward. |
   | Commits + CI green + reviewer parse error / throw                  | remove `in-progress` + `sandcastle`, add `needs-review` (branch and worktree remain)                                                                                                                                                            |
   | Commits + CI red                                                   | remove `in-progress` + `sandcastle`, add `needs-info`                                                                                                                                                                                           |
   | No commits (bail-out, timeout, hard error — any 0-commit outcome)  | remove `in-progress` + `sandcastle`, add `needs-info`                                                                                                                                                                                           |

   The wrapper never leaves `sandcastle` on the issue after a run — silent re-queue is a footgun. To re-run, you re-apply `sandcastle` (with `retry` to discard the prior branch) explicitly.

   **Auto-merge fallback.** If `npm run ship <N>` itself errors out (merge conflict, missing main protection, gh auth lapse), the wrapper logs the failure and falls back to the `needs-review` path so the slice is recoverable by hand. If ship succeeded but sweep failed, the merge is on main and the issue auto-closed — only the local worktree / branch leaks, and `npm run sweep <N>` cleans them up.

4. Defensive check: verifies the agent didn't push the branch (`git rev-parse --verify origin/agent/issue-<N>` should fail). If it succeeded, flags a warning in the status comment but doesn't fail the run. The auto-merge path at step 3 pushes from the wrapper, not the agent — `gh pr merge` runs _after_ `git push -u origin <branch>` and is unrelated to this defensive check.

## The reviewer-rejection flow

When the reviewer returns `FAIL` on commits, the wrapper closes out the run automatically rather than parking the issue for human review:

1. Tags the branch tip as `rejected/issue-N-attempt-K`. `K` increments per rejection on the same issue — `git tag --list 'rejected/issue-N-attempt-*'` counts the prior attempts.
2. Discards the local branch (`git branch -D agent/issue-N`).
3. Files a new issue titled `[follow-up #N] <original title>` with labels `sandcastle` + `priority`. The body links back to the original, includes the reviewer's findings as a checklist, lists the files and commit titles from the prior attempt, and points at the `rejected/issue-N-attempt-K` tag so the next implementer can `git diff main..rejected/issue-N-attempt-K` for context.
4. Comments on the original issue with a pointer to the follow-up.

The next drain iteration picks up the follow-up first (because of `priority`). To inspect a rejected attempt: `git show rejected/issue-N-attempt-K` for the annotated message, or `git diff main..rejected/issue-N-attempt-K` for the full diff.

## The `retry` flow

When the agent's branch is wrong-headed and you want a fresh attempt:

1. Comment on the issue explaining what was wrong (this comment becomes input to the next agent run, since the prompt pulls all comments).
2. Swap `needs-review` for `sandcastle` AND add `retry`.
3. Next drain: the wrapper sees `sandcastle` + `retry`, runs `git branch -D agent/issue-<N>`, removes `retry`, and processes the issue normally.

The wrapper only honors `retry` alongside `sandcastle`, never on `needs-review`. Adding `retry` to a `needs-review` issue does nothing destructive.

If the branch is mostly right but needs only minor tweaks, **don't use `retry`** — just `git checkout agent/issue-<N>`, edit, commit, push, and open a PR yourself. No agent involvement, no label changes needed. The agent has no memory between runs anyway, so a retry starts fresh from `main` with only the issue body and comments as feedback — re-running for small tweaks is much more expensive than fixing them by hand.

## The split protocol

When the implementer realises mid-run that an issue's acceptance criteria don't fit under the 150k context ceiling, it commits what does fit and writes a list of follow-up issues into `.sandcastle/splits.json` at the worktree root. The wrapper acts on the file after the implementer run completes:

1. Reads + validates the file (array of `{ title, body }`, 1 to 10 entries).
2. Files each entry as a new GitHub issue with `sandcastle` + `priority` labels. The next drain iteration picks them up before unflagged work — matching the rejection-loop precedent.
3. Comments on the parent issue with a checklist linking the follow-ups.
4. Applies the `oversized` label to the parent.
5. Refetches the drain queue so the new follow-ups land at the front of the remaining queue.

The parent issue's foundation commits still flow through the normal `needs-review` / auto-merge / rejection path — splitting does not throw away the work the implementer did finish. Rejection takes precedence: if the reviewer FAILs on the run, the rejection-loop follow-up subsumes any split intent and the split flow is skipped.

The implementer prompt (`src/prompts/implementer.md`) documents the file shape and rules. `.sandcastle/splits.json` is gitignored so a sloppy `git add -A` doesn't capture it.

---

Edit any of these tables to match whatever vocabulary you actually use. If you change a label string, also update the wrapper at [`src/orchestrator/main.ts`](../../orchestrator/main.ts) and any references in [`README.md`](../../../README.md).
