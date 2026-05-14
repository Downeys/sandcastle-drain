/**
 * Pushes an `agent/issue-N` branch, opens a PR, and merges it (squash + delete
 * remote branch). The PR body is explicitly set to include `Closes #N` so the
 * merge auto-closes the issue regardless of what the agent's commit messages
 * looked like.
 *
 * Invoked by `src/cli.ts` as `sandcastle ship <issue>`. After this completes
 * successfully, the user runs `sandcastle sweep <issue>` to clean up the
 * local worktree, branch, and pull main. The drain orchestrator (`main.ts`)
 * also calls `shipBranch` inline when the CI gate and reviewer both pass.
 */
import { execa } from 'execa';
import { REPO_ROOT } from './prereqs.js';

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  opts: { reject?: boolean } = {},
): Promise<RunResult> {
  const r = await execa(cmd, args, { cwd: REPO_ROOT, reject: opts.reject ?? true });
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
}

export class ShipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShipError';
  }
}

export interface ShipBranchArgs {
  issue: number;
}

export interface ShipBranchResult {
  branch: string;
  prUrl: string | undefined;
}

/**
 * Pushes `agent/issue-N`, opens (or reuses) a PR with an explicit `Closes #N`
 * body, squash-merges it, and deletes the remote branch. Throws `ShipError`
 * with a human-readable message on any step that can't be recovered. Idempotent
 * to the extent that re-running after a partial failure picks up where it left
 * off — push is a no-op when up-to-date, an already-open PR is reused.
 */
export async function shipBranch(args: ShipBranchArgs): Promise<ShipBranchResult> {
  const branch = `agent/issue-${args.issue}`;

  const branchCheck = await run('git', ['rev-parse', '--verify', branch], { reject: false });
  if (branchCheck.exitCode !== 0) {
    throw new ShipError(
      `Branch \`${branch}\` not found locally. Did you already ship this issue, or has \`sandcastle drain\` run yet?`,
    );
  }

  console.log(`[ship] Pushing ${branch} to origin...`);
  await run('git', ['push', '-u', 'origin', branch]);

  const titleResult = await run('git', ['log', '-1', '--pretty=%s', branch]);
  const title = titleResult.stdout.trim();

  // Explicit `Closes #N` so the squash-merge auto-closes the issue regardless of
  // what's in commit messages — `gh pr create --fill` only reads the first
  // commit's body, which is fragile when an agent makes multiple commits.
  const body = `Closes #${args.issue}\n\n_Created via \`sandcastle ship ${args.issue}\`._`;

  console.log(`[ship] Creating PR for ${branch}...`);
  const prCreate = await run(
    'gh',
    ['pr', 'create', '--head', branch, '--base', 'main', '--title', title, '--body', body],
    { reject: false },
  );

  let prUrl: string | undefined;
  if (prCreate.exitCode === 0) {
    prUrl = prCreate.stdout.trim().split(/\s+/).pop();
  } else {
    // A PR may already exist for this branch (e.g. ship was re-run after a
    // merge failure). Surface the existing one and continue to the merge.
    const list = await run(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'],
      { reject: false },
    );
    const open = JSON.parse(list.stdout || '[]') as Array<{ number: number; url: string }>;
    if (open.length === 0) {
      throw new ShipError(
        `gh pr create failed and no open PR exists for ${branch}.\n${prCreate.stderr}`,
      );
    }
    prUrl = open[0].url;
    console.log(`[ship] PR already open: ${prUrl}`);
  }

  // Squash keeps main's history one-commit-per-slice. We do NOT use
  // `gh pr merge --delete-branch` because that flag tries to delete the
  // *local* branch too, which always fails at ship time — the branch is
  // checked out in the worktree. Explicit remote-only delete follows.
  console.log(`[ship] Merging (squash)...`);
  await run('gh', ['pr', 'merge', branch, '--squash']);

  console.log(`[ship] Deleting remote branch...`);
  await run('git', ['push', 'origin', '--delete', branch]);

  console.log(
    `[ship] Done. Run \`sandcastle sweep ${args.issue}\` to clean up the local worktree and branch.`,
  );
  return { branch, prUrl };
}
