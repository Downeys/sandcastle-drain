/**
 * Windows teardown handling for sandcastle worktrees.
 *
 * On Windows, sandcastle's internal `WorktreeManager.remove()` throws after a
 * successful agent run because pnpm's `node_modules/.pnpm/` symlink farm
 * defeats git's recursive teardown ("Function not implemented"). That throw is
 * the expected exit path for any Windows drain that runs `pnpm install`, not
 * an error — the agent's commits are already on the branch. We read them back
 * here and let the wrapper label the run as `ok (windows-teardown)`.
 *
 * See src/content/agent-docs/sandcastle-windows-cleanup.md for background.
 */
import { execa } from 'execa';

async function branchExists(branch: string, cwd: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--verify', branch], { cwd, reject: false });
  return result.exitCode === 0;
}

export async function recoverCommitsFromBranch(
  branch: string,
  cwd: string,
): Promise<{ sha: string }[]> {
  if (!(await branchExists(branch, cwd))) return [];
  const result = await execa('git', ['log', 'main..' + branch, '--format=%H'], {
    cwd,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((sha) => ({ sha }));
}

export async function tryRecoverCommits(args: {
  result: unknown;
  runError: unknown;
  branch: string;
  cwd: string;
}): Promise<{ sha: string }[]> {
  if (args.result !== undefined || args.runError === undefined) return [];
  const recovered = await recoverCommitsFromBranch(args.branch, args.cwd);
  if (recovered.length > 0) {
    console.log(
      `[wrapper] read ${recovered.length} commit(s) from ${args.branch} after sandcastle.run() threw on Windows teardown`,
    );
  }
  return recovered;
}
