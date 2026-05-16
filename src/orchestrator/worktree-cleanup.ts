/**
 * Cross-platform recursive removal of a sandcastle worktree directory.
 *
 * Windows-specific quirk: pnpm's `node_modules/.pnpm/<long-hash>/...` symlink
 * farm defeats standard recursive deletion (Node's `fs.rm`, PowerShell
 * `Remove-Item`, `rmdir /s`, even git's own worktree cleanup — git surfaces
 * `Function not implemented` from the kernel). `robocopy /MIR` against an
 * empty source mirror-deletes everything in the target using long-path-aware
 * Win32 APIs that handle the symlink chain.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Parses `git worktree list --porcelain` output and returns the filesystem
// paths of any worktrees that have `branch` checked out.
//
// Porcelain format: blank-line-separated records, each starting with
// `worktree <path>` followed by attribute lines like `HEAD <sha>`,
// `branch refs/heads/<name>`, or `detached`.
export function parseWorktreeListPorcelain(stdout: string, branch: string): string[] {
  const target = `refs/heads/${branch}`;
  const paths: string[] = [];
  let currentPath: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === target) {
      if (currentPath) paths.push(currentPath);
    } else if (line === '') {
      currentPath = undefined;
    }
  }
  return paths;
}

// Returns the filesystem paths of all worktrees git has registered against
// `branch`. Empty array if git itself fails (treated as "nothing to clean").
export async function worktreePathsForBranch(
  repoRoot: string,
  branch: string,
): Promise<string[]> {
  const result = await execa('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return parseWorktreeListPorcelain(result.stdout, branch);
}

export async function removeWorktreeDir(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;

  if (process.platform !== 'win32') {
    await rm(worktreePath, { recursive: true, force: true });
    return;
  }

  // PID + basename keeps concurrent calls from colliding on the empty source.
  const emptyDir = join(tmpdir(), `sandcastle-empty-${basename(worktreePath)}-${process.pid}`);
  await mkdir(emptyDir, { recursive: true });
  try {
    const robo = await execa(
      'robocopy',
      [emptyDir, worktreePath, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS'],
      { reject: false },
    );
    // robocopy exit codes: 0-7 are success-ish, 8+ is an actual failure.
    if ((robo.exitCode ?? 0) >= 8) {
      throw new Error(
        `robocopy failed with code ${robo.exitCode} on ${worktreePath}.\n${robo.stderr}`,
      );
    }
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
  // Worktree dir is now empty — remove the dir itself.
  await rm(worktreePath, { recursive: true, force: true });
}
