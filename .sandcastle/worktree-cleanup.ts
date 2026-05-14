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
