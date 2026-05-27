/**
 * CI gate: runs the host project's typecheck, lint, and test scripts against
 * the agent's worktree after a successful run, before applying the
 * run-outcome label.
 *
 * If the agent's original worktree dir still exists (the Windows-teardown path
 * where sandcastle.run() threw with node_modules intact), we reuse it. On Linux
 * sandcastle removes the worktree on success, so we create a fresh git worktree
 * for the branch, run the package manager's frozen-install, then the checks.
 * The temp worktree is removed when we're done.
 *
 * Package manager is detected from lockfiles / `packageManager` field so the
 * wrapper works on npm, pnpm, and yarn-classic projects without configuration.
 *
 * Pure logic (decision, formatting, PM detection) is split from the execa
 * orchestration so the decisions are unit-testable without spinning a real
 * install.
 */
import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { removeWorktreeDir } from './worktree-cleanup.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

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
  packageManager: PackageManager;
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

// Reuse-the-existing-install heuristic. For pnpm we require `.modules.yaml`
// (pnpm writes it at the END of a successful install; on Windows after
// sandcastle's teardown ENOSYS, the dir survives without the marker and the
// symlink farm is broken — reusing it without reinstall yields false TS2307
// failures). npm and yarn-classic both write a flat `node_modules` and don't
// have a comparable end-of-install marker; presence is good enough.
export function needsInstall(dir: string, pm: PackageManager): boolean {
  if (pm === 'pnpm') {
    return !existsSync(join(dir, 'node_modules', '.modules.yaml'));
  }
  return !existsSync(join(dir, 'node_modules'));
}

// Detect the project's package manager by precedence:
//   1. lockfile on disk (most authoritative)
//   2. `packageManager` field in package.json (corepack convention)
//   3. default to npm
// Pure: takes a repo root, returns a tag. No execa, no network, no side effects.
export function detectPackageManager(repoRoot: string): PackageManager {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoRoot, 'package-lock.json'))) return 'npm';
  const pkgPath = join(repoRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { packageManager?: string };
      const field = pkg.packageManager;
      if (typeof field === 'string') {
        const name = field.split('@')[0];
        if (name === 'pnpm' || name === 'yarn' || name === 'npm') return name;
      }
    } catch {
      // Malformed package.json: fall through to default rather than crash the gate.
    }
  }
  return 'npm';
}

// Frozen-install args per package manager. The intent across all three is the
// same: refuse to install if the lockfile is out of date.
export function installArgs(pm: PackageManager): readonly string[] {
  switch (pm) {
    case 'npm':
      return ['ci'];
    case 'pnpm':
      return ['install', '--frozen-lockfile'];
    case 'yarn':
      // Yarn classic. Yarn berry (v2+) uses `--immutable` and would need a
      // `.yarnrc.yml` check to detect; deferring berry support until needed.
      return ['install', '--frozen-lockfile'];
  }
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
  lines.push(
    `**CI gate:** FAIL — \`${result.packageManager} ${result.failedCheck ?? 'unknown'}\` exited non-zero`,
  );
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

async function runCheck(
  pm: PackageManager,
  check: CiCheck,
  args: readonly string[],
  cwd: string,
): Promise<CiCheckRun> {
  const result = await execa(pm, args.slice(), {
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

function formatLogFile(pm: PackageManager, runs: readonly CiCheckRun[]): string {
  return runs
    .map((r) => `$ ${pm} ${r.check}\n(exit ${r.exitCode})\n${r.output}`)
    .join('\n\n---\n\n');
}

export async function runCiGate(args: {
  issue: number;
  branch: string;
  repoRoot: string;
  worktreePath: string;
}): Promise<CiGateResult> {
  const { issue, branch, repoRoot, worktreePath } = args;

  const logsDir = join(repoRoot, '.sandcastle-drain', 'logs');
  await mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, `issue-${issue}-ci.log`);

  const ciGateRoot = join(repoRoot, '.sandcastle-drain', 'ci-gate');
  const { dir, createdTempWorktree } = await prepareCiWorktree({
    branch,
    repoRoot,
    worktreePath,
    ciGateRoot,
    issue,
  });

  // Detect from the agent's worktree, not the host repo, so a branch that
  // changes lockfiles (e.g. adopting pnpm) is treated correctly.
  const pm = detectPackageManager(dir);

  const runs: CiCheckRun[] = [];
  try {
    if (needsInstall(dir, pm)) {
      const install = await runCheck(pm, 'install', installArgs(pm), dir);
      runs.push(install);
      if (install.exitCode !== 0) {
        await writeFile(logPath, formatLogFile(pm, runs));
        return { ...determineCiOk(runs), runs, logPath, packageManager: pm };
      }
    }
    for (const check of REQUIRED_CHECKS) {
      const result = await runCheck(pm, check, ['run', check], dir);
      runs.push(result);
      if (result.exitCode !== 0) {
        await writeFile(logPath, formatLogFile(pm, runs));
        return { ...determineCiOk(runs), runs, logPath, packageManager: pm };
      }
    }
    await writeFile(logPath, formatLogFile(pm, runs));
    return { ...determineCiOk(runs), runs, logPath, packageManager: pm };
  } finally {
    if (createdTempWorktree) {
      await teardownCiWorktree(dir, repoRoot);
    }
  }
}
