/**
 * Fixer sub-agent invocation.
 *
 * Runs after the CI gate fails on the implementer's commits. Spawns a fresh
 * Sandcastle run on the same `agent/issue-N` branch, hands the agent the
 * failing CI excerpt + the diff pointer, and lets it commit a surgical fix.
 * The wrapper re-runs the CI gate after each fixer attempt; success is
 * decided by whether the re-gate goes green, not by what the agent reports.
 *
 * Mirrors `src/orchestrator/reviewer.ts` structurally — fresh sandbox per
 * call, identical staged-content mount, identical log-copy pattern — so the
 * supervision surface (timeouts, log paths, status comment lines) is
 * uniform across sub-agents.
 *
 * Owns:
 *   - `runFixer` — spawn the fixer run, capture stdout + log
 *   - `formatFixerSection` — render attempt outcomes for the status comment
 *   - `formatFixerComment` — render the per-attempt comment posted on the issue
 */
import { run, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STAGED_SANDBOX_PATH } from '../stage.js';
import { renderPrompt } from '../render-prompt.js';
import type { CiGateResult } from './ci-gate.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixerAttempt {
  /** 1-based attempt index. */
  attempt: number;
  /** Wrapper-owned path to this attempt's copied log file (undefined if the copy failed). */
  logFilePath: string | undefined;
  /** True when the fixer agent produced at least one new commit on the branch. */
  hadCommits: boolean;
  /** True when the CI gate ran after this attempt and reported green. */
  ciPassed: boolean;
  /** When the run threw or otherwise produced no result, the error message; otherwise undefined. */
  runError: string | undefined;
}

export interface RunFixerArgs {
  imageName: string;
  hostCredsPath: string;
  sandboxCredsPath: string;
  stagedHostPath: string;
  ghToken: string;
  issueNumber: number;
  branch: string;
  fixerLogPath: string;
  ciFailureExcerpt: string;
  lastCommitSha: string;
  idleTimeoutSeconds: number;
  wallClockTimeoutMs: number;
}

export interface FixerRunResult {
  /** Commits the fixer added on top of the implementer's commits. */
  newCommits: readonly { sha: string }[];
  stdout: string;
  /** Wrapper-owned copy of the sandcastle log, when copy succeeded. */
  logFilePath: string | undefined;
  /** Set when the fixer run threw or sandcastle returned no result. */
  runError: string | undefined;
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * Renders a single per-attempt comment posted on the issue right after the
 * fixer finishes. Surfaces what happened — committed / didn't / ran into an
 * error — and the CI verdict that decides whether we loop again.
 */
export function formatFixerComment(args: {
  attempt: number;
  maxAttempts: number;
  fixer: FixerRunResult;
  ciResult: CiGateResult;
}): string {
  const { attempt, maxAttempts, fixer, ciResult } = args;
  const hadCommits = fixer.newCommits.length > 0;
  const verdict = ciResult.ok ? 'green' : 'red';
  const verdictEmoji = ciResult.ok ? '✅' : '❌';
  const lines: string[] = [];
  lines.push(`**Fixer attempt ${attempt} of ${maxAttempts}:** ${verdictEmoji} CI ${verdict}`);
  lines.push('');
  if (fixer.runError !== undefined) {
    lines.push(`> Fixer run errored: ${fixer.runError}`);
    lines.push('');
  }
  lines.push(
    hadCommits
      ? `Fixer committed ${fixer.newCommits.length} new commit(s).`
      : `Fixer produced no new commits.`,
  );
  if (fixer.logFilePath) {
    lines.push('');
    lines.push(`**Fixer log:** \`${fixer.logFilePath}\``);
  }
  if (!ciResult.ok) {
    const failedRun = ciResult.runs.find((r) => r.exitCode !== 0);
    lines.push('');
    lines.push(`**CI still red** — \`${ciResult.packageManager} ${ciResult.failedCheck ?? 'unknown'}\` failed.`);
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
  }
  return lines.join('\n').trimEnd();
}

/**
 * Renders a multi-attempt summary block for the run's status comment. One
 * line per attempt — keeps the comment compact even when the fixer ran twice.
 */
export function formatFixerSection(attempts: readonly FixerAttempt[]): string {
  if (attempts.length === 0) return '';
  const lines: string[] = [];
  lines.push(`**Fixer:** ${attempts.length} attempt(s)`);
  for (const a of attempts) {
    const outcome = describeAttempt(a);
    lines.push(`- Attempt ${a.attempt}: ${outcome}`);
  }
  return lines.join('\n');
}

function describeAttempt(a: FixerAttempt): string {
  if (a.runError !== undefined) return `errored — ${a.runError}`;
  if (a.ciPassed) return a.hadCommits ? 'committed a fix → CI green' : 'no commits → CI green';
  if (a.hadCommits) return 'committed a fix → CI still red';
  return 'no commits → CI still red';
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Spawns the fixer Sandcastle run. The implementer's commits already exist on
 * `args.branch`; sandcastle's `branchStrategy: { type: 'branch', branch }`
 * reuses the branch (same pattern the reviewer uses) so the fixer's commits
 * land on top of the implementer's.
 *
 * Errors are swallowed and returned in `runError` rather than thrown so the
 * caller's loop can decide whether to retry or fall through to the CI-failure
 * follow-up path. Reading the post-run commits is the caller's job — this
 * function only owns the run + stdout + log copy.
 */
export async function runFixer(args: RunFixerArgs): Promise<FixerRunResult> {
  let result: Awaited<ReturnType<typeof run>> | undefined;
  let runError: unknown;
  try {
    const prompt = await renderPrompt('fixer', {
      ISSUE_NUMBER: String(args.issueNumber),
      BRANCH: args.branch,
      CI_FAILURE_EXCERPT: args.ciFailureExcerpt,
      LAST_COMMIT_SHA: args.lastCommitSha,
    });
    result = await run({
      agent: claudeCode('claude-opus-4-7'),
      sandbox: docker({
        imageName: args.imageName,
        mounts: [
          { hostPath: args.hostCredsPath, sandboxPath: args.sandboxCredsPath },
          { hostPath: args.stagedHostPath, sandboxPath: STAGED_SANDBOX_PATH, readonly: true },
        ],
        env: { GH_TOKEN: args.ghToken },
      }),
      prompt,
      branchStrategy: { type: 'branch', branch: args.branch },
      idleTimeoutSeconds: args.idleTimeoutSeconds,
      signal: AbortSignal.timeout(args.wallClockTimeoutMs),
    });
  } catch (err) {
    runError = err;
  }

  const stdout =
    result?.stdout ?? (runError instanceof Error ? runError.message : String(runError ?? ''));
  const newCommits = result?.commits ?? [];
  const sourceLogPath = result?.logFilePath;

  // Best-effort copy the sandcastle log to our well-known path so a fixer
  // post-mortem doesn't require chasing sandcastle's per-run scratch dir.
  let copiedLogPath: string | undefined;
  if (sourceLogPath !== undefined) {
    try {
      await mkdir(dirname(args.fixerLogPath), { recursive: true });
      await copyFile(sourceLogPath, args.fixerLogPath);
      copiedLogPath = args.fixerLogPath;
    } catch (err) {
      console.error(
        `[fixer] failed to copy log ${sourceLogPath} → ${args.fixerLogPath}:`,
        (err as Error).message,
      );
    }
  }

  return {
    newCommits,
    stdout,
    logFilePath: copiedLogPath,
    runError:
      runError !== undefined
        ? runError instanceof Error
          ? runError.message
          : String(runError)
        : undefined,
  };
}
