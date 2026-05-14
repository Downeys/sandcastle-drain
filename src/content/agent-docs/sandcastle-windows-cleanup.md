# Sandcastle on Windows: worktree teardown is the success path

## Behavior

On Windows, `sandcastle.run()` throws `error: failed to delete '.sandcastle/worktrees/agent-issue-N': Function not implemented` _after_ the agent has committed. This is the **expected** exit path for any drain that runs `pnpm install`, not a failure mode. The wrapper:

1. Catches the throw, recording `runError`. `result` is undefined.
2. Reads `git log main..agent/issue-N` (via [`src/orchestrator/teardown.ts`](../../orchestrator/teardown.ts)) to recover the commit list directly from the branch.
3. Labels the run `ok (windows-teardown)` in [`src/orchestrator/status.ts`](../../orchestrator/status.ts) — a success-tier status that sits alongside `completed` and `partial-work` under needs-review.

The teardown throw and the wrapper's post-hoc recovery are now considered routine Windows behavior. The status name makes it visible in the per-run GitHub comment so reviewers know what happened, without implying anything went wrong.

## Cause

pnpm's `node_modules/.pnpm/` symlink farm defeats Windows recursive deletion (Node's `fs.rm`, `Remove-Item`, `rmdir /s`, and git's own worktree teardown — git surfaces `Function not implemented` from the kernel). Sandcastle's internal `WorktreeManager.remove` runs in the success path and trips this.

The wrapper's own `removeWorktreeDir` mitigation (`robocopy /MIR` in [`src/orchestrator/worktree-cleanup.ts`](../../orchestrator/worktree-cleanup.ts)) handles the same root cause for the _next-run_ orphan cleanup — but it cannot run inside sandcastle's lifecycle, because sandcastle owns its own worktree teardown.

## What we tried (for context)

Probed sandcastle 0.5.7's public API for a way to disable internal worktree cleanup so the wrapper could own it:

- `RunOptions` in `node_modules/@ai-hero/sandcastle/dist/run.d.ts` — no `cleanupWorktree`, `keepWorktree`, or equivalent flag.
- `SandboxHooks` in `dist/SandboxLifecycle.d.ts` — only `onWorktreeReady` / `onSandboxReady` setup hooks; no teardown hook.
- `WorktreeManager.remove` exists in `dist/WorktreeManager.d.ts` but is internal — not callable from the wrapper without forking.
- One escape hatch: `RunOptions.signal` docs say "The worktree is preserved on disk after abort (error-path behavior)." Aborting works, but defeats the purpose — we want a normal completion that doesn't tear down.

## Decision

We accept the throw-then-read flow as the durable Windows path until sandcastle exposes a cleanup-ownership hook. It is the success path, not an error path. The pre-run cleanup at `processIssue` step (b.5) calls `removeWorktreeDir` against any orphaned dir from a prior drain so the symlink farm doesn't accumulate.

## When to revisit

When sandcastle ships a release that:

- Adds a `cleanupWorktree: false` (or similarly-named) option to `RunOptions`, **or**
- Adds a `beforeWorktreeRemove` / `onTeardown` hook to `SandboxHooks`, **or**
- Switches its own teardown to use long-path-aware Win32 APIs (e.g. invokes our same `robocopy /MIR` trick or `RemoveDirectoryW` with `FILE_FLAG_BACKUP_SEMANTICS`).

At that point, take ownership of cleanup in the wrapper and remove the `ok (windows-teardown)` status — runs will exit cleanly as `completed`.

## Do not

- Fork sandcastle to add the option (per memory `sandcastle_api_drift_v0_5_7.md`).
- Pre-empt sandcastle's cleanup by deleting `node_modules/.pnpm/` ourselves before `run()` returns — that races sandcastle's lifecycle and corrupts the agent's workspace.
