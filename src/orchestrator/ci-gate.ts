/**
 * CI gate: runs `pnpm typecheck`, `pnpm lint`, `pnpm test` against the agent's
 * worktree after a successful run, before applying the run-outcome label.
 *
 * If the agent's original worktree dir still exists (the Windows-teardown path
 * where sandcastle.run() threw with node_modules intact), we reuse it. On Linux
 * sandcastle removes the worktree on success, so we create a fresh git worktree
 * for the branch, run `pnpm install --frozen-lockfile`, then the checks. The
 * temp worktree is removed when we're done.
 *
 * Pure logic (decision, formatting) is split from the execa orchestration so
 * the decisions are unit-testable without spinning a real install.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { removeWorktreeDir } from './worktree-cleanup.js';

export type CiCheck = 'install' | 'typecheck' | 'lint' | 'test';

export interface CiCheckRun {
  check: CiCheck;
  exitCode: number;
  output: string;
}

export interface CiGateResult {
  ok: boolean;
  failedCheck?: CiCheck;
  runs: CiCheckRun[];
  logPath: string;
}

const REQUIRED_CHECKS: readonly CiCheck[] = ['typecheck', 'lint', 'test'];

export function determineCiOk(runs: readonly CiCheckRun[]): {
  ok: boolean;
  failedCheck?: CiCheck;
} {
  for (const run of runs) {
    if (run.exitCode !== 0) return { ok: false, failedCheck: run.check };
  }
  return { ok: true };
}

// pnpm writes .modules.yaml at the END of a successful install. Plain
// existsSync('node_modules') is too lenient: on Windows after sandcastle's
// teardown ENOSYS, the dir survives without the marker and the symlink farm
// is broken — reusing it without reinstall yields false TS2307 failures.
export function needsInstall(dir: string): boolean {
  return !existsSync(join(dir, 'node_modules', '.modules.yaml'));
}

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export function formatCiSection(result: CiGateResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push('**CI gate:** PASS (typecheck, lint, test)');
    return lines.join('\n');
  }
  lines.push(`**CI gate:** FAIL — \`pnpm ${result.failedCheck ?? 'unknown'}\` exited non-zero`);
  lines.push(`**CI log:** \`${result.logPath}\``);
  const failedRun = result.runs.find((r) => r.exitCode !== 0);
  if (failedRun) {
    lines.push('');
    lines.push('<details><summary>Last ~50 lines of CI output</summary>');
    lines.push('');
    lines.push('```');
    lines.push(lastLines(failedRun.output, 50));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

async function runCheck(check: CiCheck, args: readonly string[], cwd: string): Promise<CiCheckRun> {
  const result = await execa('pnpm', args.slice(), {
    cwd,
    reject: false,
    all: true,
    env: { ...process.env, CI: 'true' },
  });
  const output =
    result.all ?? [result.stdout, result.stderr].filter((s): s is string => Boolean(s)).join('\n');
  return { check, exitCode: result.exitCode ?? -1, output };
}

async function prepareCiWorktree(args: {
  branch: string;
  repoRoot: string;
  worktreePath: string;
  ciGateRoot: string;
  issue: number;
}): Promise<{ dir: string; createdTempWorktree: boolean }> {
  const { branch, repoRoot, worktreePath, ciGateRoot, issue } = args;
  if (existsSync(worktreePath)) {
    return { dir: worktreePath, createdTempWorktree: false };
  }
  const dir = join(ciGateRoot, `issue-${issue}`);
  if (existsSync(dir)) {
    // Stale ci-gate worktree from a prior aborted run — remove it before re-adding.
    await execa('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, reject: false });
    await removeWorktreeDir(dir);
    await execa('git', ['worktree', 'prune'], { cwd: repoRoot, reject: false });
  }
  await mkdir(ciGateRoot, { recursive: true });
  await execa('git', ['worktree', 'add', dir, branch], { cwd: repoRoot });
  return { dir, createdTempWorktree: true };
}

async function teardownCiWorktree(dir: string, repoRoot: string): Promise<void> {
  // Best-effort: a leaked ci-gate worktree gets cleaned up by the next run's
  // pre-flight orphan sweep, so don't throw if removal fails.
  try {
    await execa('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, reject: false });
    await removeWorktreeDir(dir);
    await execa('git', ['worktree', 'prune'], { cwd: repoRoot, reject: false });
  } catch (err) {
    console.error(`[wrapper] ci-gate worktree cleanup failed for ${dir}:`, err);
  }
}

function formatLogFile(runs: readonly CiCheckRun[]): string {
  return runs
    .map((r) => `$ pnpm ${r.check}\n(exit ${r.exitCode})\n${r.output}`)
    .join('\n\n---\n\n');
}

export async function runCiGate(args: {
  issue: number;
  branch: string;
  repoRoot: string;
  worktreePath: string;
}): Promise<CiGateResult> {
  const { issue, branch, repoRoot, worktreePath } = args;

  const logsDir = join(repoRoot, '.sandcastle', 'logs');
  await mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, `issue-${issue}-ci.log`);

  const ciGateRoot = join(repoRoot, '.sandcastle', 'ci-gate');
  const { dir, createdTempWorktree } = await prepareCiWorktree({
    branch,
    repoRoot,
    worktreePath,
    ciGateRoot,
    issue,
  });

  const runs: CiCheckRun[] = [];
  try {
    if (needsInstall(dir)) {
      const install = await runCheck('install', ['install', '--frozen-lockfile'], dir);
      runs.push(install);
      if (install.exitCode !== 0) {
        await writeFile(logPath, formatLogFile(runs));
        return { ...determineCiOk(runs), runs, logPath };
      }
    }
    for (const check of REQUIRED_CHECKS) {
      const result = await runCheck(check, [check], dir);
      runs.push(result);
      if (result.exitCode !== 0) {
        await writeFile(logPath, formatLogFile(runs));
        return { ...determineCiOk(runs), runs, logPath };
      }
    }
    await writeFile(logPath, formatLogFile(runs));
    return { ...determineCiOk(runs), runs, logPath };
  } finally {
    if (createdTempWorktree) {
      await teardownCiWorktree(dir, repoRoot);
    }
  }
}
