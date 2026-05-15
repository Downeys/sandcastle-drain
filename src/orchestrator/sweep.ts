/**
 * Post-merge cleanup for an `agent/issue-N` slice: pulls main, removes the
 * worktree directory (Windows-safe via the shared helper), prunes git's
 * worktree metadata, and deletes the local branch.
 *
 * Invoked by `src/cli.ts` as `sandcastle-drain sweep <issue>`. Refuses to run unless
 * a MERGED PR exists for the branch — sweep is post-merge cleanup, not a way
 * to discard in-flight work. To discard a still-open branch intentionally,
 * use `git worktree remove` and `git branch -D` directly. The drain
 * orchestrator (`main.ts`) also calls `sweepBranch` inline after a successful
 * auto-ship.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './prereqs.js';
import { removeWorktreeDir } from './worktree-cleanup.js';

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  opts: { reject?: boolean; cwd?: string } = {},
): Promise<RunResult> {
  const r = await execa(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, reject: opts.reject ?? true });
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
}

export class SweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepError';
  }
}

interface PrInfo {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
}

async function findMergedPr(branch: string): Promise<PrInfo | undefined> {
  const result = await run(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url'],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    throw new SweepError(`gh pr list failed: ${result.stderr}`);
  }
  const prs = JSON.parse(result.stdout || '[]') as PrInfo[];
  return prs.find((p) => p.state === 'MERGED');
}

export interface SweepBranchArgs {
  issue: number;
}

export interface SweepBranchResult {
  branch: string;
  prUrl: string;
}

/**
 * Pulls main, removes the per-issue worktree, prunes worktree metadata, and
 * deletes the local branch. Throws `SweepError` if no MERGED PR exists for the
 * branch — that guard is the only safety net keeping a sweep from discarding
 * in-flight work.
 */
export async function sweepBranch(args: SweepBranchArgs): Promise<SweepBranchResult> {
  const branch = `agent/issue-${args.issue}`;
  const worktreePath = resolve(REPO_ROOT, '.sandcastle-drain', 'worktrees', `agent-issue-${args.issue}`);

  console.log(`[sweep] Checking that PR for ${branch} is merged...`);
  const merged = await findMergedPr(branch);
  if (!merged) {
    throw new SweepError(
      `No MERGED PR found for ${branch}. Sweep is post-merge cleanup only — run \`sandcastle-drain ship ${args.issue}\` first, or remove the worktree manually if you want to discard the branch without merging.`,
    );
  }
  console.log(`[sweep] Found merged PR: ${merged.url}`);

  // Pull main so the local main has the squash commit. (Without this, the
  // `git branch -d` step below refuses with "not yet merged to HEAD".)
  console.log(`[sweep] Pulling main...`);
  await run('git', ['checkout', 'main']);
  await run('git', ['pull', 'origin', 'main']);

  if (existsSync(worktreePath)) {
    console.log(`[sweep] Removing worktree...`);
    await removeWorktreeDir(worktreePath);
  } else {
    console.log(`[sweep] Worktree already gone — skipping.`);
  }

  await run('git', ['worktree', 'prune']);

  // -D = force. -d would refuse because we squash-merge: the branch tip never
  // becomes an ancestor of main, so git's "not fully merged" check fires even
  // though the work IS on main under a different SHA. The PR-merge check above
  // is the real safety net — if we got here, the work is upstream.
  const branchCheck = await run('git', ['rev-parse', '--verify', branch], { reject: false });
  if (branchCheck.exitCode === 0) {
    console.log(`[sweep] Deleting local branch ${branch}...`);
    await run('git', ['branch', '-D', branch]);
  } else {
    console.log(`[sweep] Local branch ${branch} already gone — skipping.`);
  }

  console.log(`[sweep] Done. #${args.issue} is fully cleaned up.`);
  return { branch, prUrl: merged.url };
}
