/**
 * Drains the queue of `sandcastle`-labeled GitHub issues by running the agent
 * once per issue. See README.md for the wrapper design and
 * src/content/agent-docs/triage-labels.md for the label state machine.
 *
 * Invoked by `src/cli.ts` as the `drain` subcommand. `runDrain` is the only
 * export the CLI calls; the rest of the file is internal to drain orchestration.
 */
import { run, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_CREDS_PATH,
  IMAGE_NAME,
  REPO_ROOT,
  SANDBOX_CREDS_PATH,
} from './prereqs.js';
import { STAGED_DIR_RELATIVE, STAGED_SANDBOX_PATH } from '../stage.js';
import { renderPrompt } from '../render-prompt.js';
import {
  containsRateLimit,
  determineRunStatus,
  isRateLimitError,
  type RunStatus,
} from './status.js';
import {
  buildSiblingContextBlock,
  estimateTokens,
  summarizeBranch,
  type SiblingSummary,
} from './sibling-context.js';
import { formatSummary, type RunSummary } from './summary.js';
import { tryRecoverCommits } from './teardown.js';
import { removeWorktreeDir, worktreePathsForBranch } from './worktree-cleanup.js';
import { formatReviewerComment, formatReviewerErrorComment, runReviewer } from './reviewer.js';
import type { ReviewerOutput, ReviewerVerdict } from './reviewer.js';
import { detectPackageManager, formatCiSection, runCiGate, type CiGateResult } from './ci-gate.js';
import { shipBranch } from './ship.js';
import { sweepBranch } from './sweep.js';
import {
  buildFollowUpBody,
  buildFollowUpTitle,
  buildOriginalIssueRejectionComment,
  createRejectionTag,
  listRejectionTagsForIssue,
  nextAttemptNumber,
  PRIORITY_LABEL,
  rejectionTagName,
  sortQueue,
} from './rejection.js';
import { parseBlockedBy } from './blocked-by.js';
import {
  buildOriginalIssueSplitComment,
  buildSplitErrorComment,
  formatSplitsLogLine,
  OVERSIZED_LABEL,
  readSplitsFile,
  type CreatedSplit,
  type Split,
  type SplitsParseResult,
} from './splits.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_LABEL = 'sandcastle';
const IN_PROGRESS_LABEL = 'in-progress';
const BLOCKED_LABEL = 'blocked';
const RETRY_LABEL = 'retry';
const NEEDS_REVIEW_LABEL = 'needs-review';
const NEEDS_INFO_LABEL = 'needs-info';
const SKIPPED_THIS_RUN_LABEL = 'skipped-this-run';

// Idle timeout: 10 minutes of silence kills the run. Wall-clock cap: 90 minutes.
const IDLE_TIMEOUT_SECONDS = 600;
const WALL_CLOCK_TIMEOUT_MS = 90 * 60 * 1000;

// One initial attempt + one auto-retry on idle/wall-clock timeout with no
// commits. Idle/abort failures are typically transient (model blip, network
// stall); retrying once handles them without the human having to re-queue.
// Anything other than `failed (timeout)` does not retry — see processIssue.
const MAX_ATTEMPTS_PER_ISSUE = 2;

// Reviewer is read-only and bounded to a tighter budget than the implementer:
// reading the principles + diff + emitting a verdict shouldn't take 90 minutes.
const REVIEWER_IDLE_TIMEOUT_SECONDS = 300;
const REVIEWER_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Issue {
  number: number;
  title: string;
  labels: string[];
  body: string;
}

// ---------------------------------------------------------------------------
// gh helpers — best-effort, never abort the loop on label or comment failure
// ---------------------------------------------------------------------------

async function gh(args: string[], options: { input?: string } = {}): Promise<string> {
  const result = await execa('gh', args, {
    cwd: REPO_ROOT,
    input: options.input,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function tryGh(
  args: string[],
  context: string,
  options: { input?: string } = {},
): Promise<void> {
  try {
    await gh(args, options);
  } catch (err) {
    console.error(`[wrapper] ${context} failed (continuing):`, (err as Error).message);
  }
}

async function fetchQueue(): Promise<Issue[]> {
  const raw = await gh([
    'issue',
    'list',
    '--label',
    QUEUE_LABEL,
    '--state',
    'open',
    '--json',
    'number,title,labels,body',
    '--limit',
    '200',
  ]);
  const issues = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    body: string;
  }>;
  const mapped = issues
    .map((i) => ({
      number: i.number,
      title: i.title,
      labels: i.labels.map((l) => l.name),
      body: i.body ?? '',
    }))
    .filter((i) => !i.labels.includes(IN_PROGRESS_LABEL) && !i.labels.includes(BLOCKED_LABEL));
  // `priority`-labeled issues run first so a rejection-loop follow-up jumps
  // ahead of pending queue work. Tie-broken by issue number for stability.
  return sortQueue(mapped);
}

async function addLabel(issue: number, label: string): Promise<void> {
  await tryGh(
    ['issue', 'edit', String(issue), '--add-label', label],
    `add label "${label}" to #${issue}`,
  );
}

async function removeLabel(issue: number, label: string): Promise<void> {
  await tryGh(
    ['issue', 'edit', String(issue), '--remove-label', label],
    `remove label "${label}" from #${issue}`,
  );
}

async function postComment(issue: number, body: string): Promise<void> {
  await tryGh(['issue', 'comment', String(issue), '--body-file', '-'], `comment on #${issue}`, {
    input: body,
  });
}

async function closeIssue(issue: number): Promise<void> {
  await tryGh(['issue', 'close', String(issue)], `close #${issue}`);
}

// Surfaces a skip decision on the GitHub issue so the user doesn't have to
// read the orchestrator transcript to discover what happened. Best-effort —
// every step routes through `tryGh`, so a single failure (label race, network
// blip) is logged and the drain continues. `removeSandcastle` is opt-in
// because most skip paths leave the queue label on so the next drain retries.
async function markSkipped(
  issue: number,
  reason: string,
  opts: { removeSandcastle: boolean },
): Promise<void> {
  await postComment(issue, `**Sandcastle-drain skipped this issue.** ${reason}`);
  await addLabel(issue, SKIPPED_THIS_RUN_LABEL);
  if (opts.removeSandcastle) {
    await removeLabel(issue, QUEUE_LABEL);
  }
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

async function branchExists(branch: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--verify', branch], {
    cwd: REPO_ROOT,
    reject: false,
  });
  return result.exitCode === 0;
}

// A "branch with zero commits ahead of main" carries no work to preserve, so
// the conservative skip-on-existing-branch path can safely discard it. Used
// to auto-recover from a prior drain that created the branch but died before
// committing anything.
async function branchIsEmpty(branch: string): Promise<boolean> {
  const result = await execa('git', ['rev-list', '--count', `main..${branch}`], {
    cwd: REPO_ROOT,
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim() === '0';
}

async function remoteBranchExists(branch: string): Promise<boolean> {
  // Defensive check: if the agent ignored its instructions and pushed, this
  // succeeds. We don't fetch first — just check what's already in
  // `refs/remotes/origin/` locally. If the agent ran `git push` from the
  // sandbox, it will have updated the local remote ref via the same shared
  // .git directory.
  const result = await execa('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
    cwd: REPO_ROOT,
    reject: false,
  });
  return result.exitCode === 0;
}

// Idempotent reset of all git state for `branch`: drops any worktree git has
// registered against it (at any path, not just our expected one), prunes
// dangling metadata, then force-deletes the branch. Throws if the branch is
// still present at the end — surfaces residual state instead of silently
// proceeding.
//
// Plain `git branch -D` is insufficient on its own: git refuses to delete a
// branch checked out in a registered worktree, and a drain killed mid-run
// leaves the worktree registered. The fix uses `git worktree list --porcelain`
// to find the real path (which may not match the wrapper's expected location
// if the working-dir was renamed between runs) and removes the worktree first.
async function resetIssueState(branch: string): Promise<void> {
  const linkedPaths = await worktreePathsForBranch(REPO_ROOT, branch);
  if (linkedPaths.length > 0) {
    console.log(
      `[wrapper] resetting ${branch}: removing worktree(s) at ${linkedPaths.join(', ')}`,
    );
  }
  for (const path of linkedPaths) {
    const removed = await execa('git', ['worktree', 'remove', '--force', path], {
      cwd: REPO_ROOT,
      reject: false,
    });
    if (removed.exitCode !== 0) {
      // Most common Windows failure: pnpm symlink farm defeats git's recursive
      // delete with "Function not implemented". `cleanupWorktree` uses the
      // robocopy /MIR workaround and then `git worktree prune` picks up the
      // dangling registration on the next call below.
      console.log(
        `[wrapper] git worktree remove failed for ${path} (exit ${removed.exitCode}); falling back to direct cleanup`,
      );
      await cleanupWorktree(path);
    }
  }

  await execa('git', ['worktree', 'prune'], { cwd: REPO_ROOT, reject: false });

  if (await branchExists(branch)) {
    const del = await execa('git', ['branch', '-D', branch], { cwd: REPO_ROOT, reject: false });
    if (del.exitCode !== 0 || (await branchExists(branch))) {
      throw new Error(
        `Failed to reset state for ${branch}: git branch -D exited ${del.exitCode}.\n` +
          `stderr: ${del.stderr || '(empty)'}\n` +
          `Manual recovery: run \`git worktree list\`, then \`git worktree remove --force <path>\` ` +
          `for any worktree on ${branch}, then \`git branch -D ${branch}\`.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Per-issue flow
// ---------------------------------------------------------------------------

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function buildStatusComment(args: {
  status: RunStatus;
  branch?: string;
  commits: { sha: string }[];
  stdout: string;
  logFilePath?: string;
  pushedWarning: boolean;
  siblingContext?: { count: number; tokens: number };
  ciResult?: CiGateResult;
  attempts?: { current: number; max: number };
}): string {
  const {
    status,
    branch,
    commits,
    stdout,
    logFilePath,
    pushedWarning,
    siblingContext,
    ciResult,
    attempts,
  } = args;
  const lines: string[] = [];
  lines.push(`**sandcastle-drain run:** \`${status}\``);
  if (attempts && attempts.current > 1) {
    lines.push(`**Attempts:** ${attempts.current} of ${attempts.max}`);
  }
  if (branch) lines.push(`**Branch:** \`${branch}\``);
  lines.push(
    `**Commits:** ${commits.length}${commits.length > 0 ? ` (${commits.map((c) => `\`${c.sha.slice(0, 7)}\``).join(', ')})` : ''}`,
  );
  if (siblingContext && siblingContext.count > 0) {
    lines.push(
      `**Sibling context:** ${siblingContext.count} sibling(s), ~${siblingContext.tokens} tokens`,
    );
  }
  if (logFilePath) lines.push(`**Log:** \`${logFilePath}\``);
  if (ciResult) {
    lines.push('');
    lines.push(formatCiSection(ciResult));
  }
  if (pushedWarning) {
    lines.push('');
    lines.push(
      '> :warning: **The agent pushed this branch to the remote.** It was instructed not to. Investigate before merging — this is a wrapper or prompt regression.',
    );
  }
  lines.push('');
  lines.push('<details><summary>Last ~50 lines of agent output</summary>');
  lines.push('');
  lines.push('```');
  lines.push(lastLines(stdout, 50));
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

// Removes the per-issue worktree dir from disk. Safe to call when the dir
// doesn't exist. Failures are logged, never thrown — cleanup must not mask the
// real run outcome. Used both for pre-flight orphan removal and post-run
// cleanup so a clean run leaves no disk residue.
async function cleanupWorktree(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  try {
    await removeWorktreeDir(worktreePath);
    await execa('git', ['worktree', 'prune'], { cwd: REPO_ROOT, reject: false });
  } catch (err) {
    console.error(`[wrapper] worktree cleanup failed for ${worktreePath}:`, err);
  }
}

async function runAndPostReviewer(args: {
  issueNumber: number;
  branch: string;
  ghToken: string;
}): Promise<ReviewerOutput | undefined> {
  const reviewerLogPath = join(
    REPO_ROOT,
    '.sandcastle-drain',
    'logs',
    `issue-${args.issueNumber}-reviewer.log`,
  );
  console.log(`[wrapper] invoking reviewer for #${args.issueNumber} on ${args.branch}`);
  let runResult;
  try {
    runResult = await runReviewer({
      imageName: IMAGE_NAME,
      hostCredsPath: HOST_CREDS_PATH,
      sandboxCredsPath: SANDBOX_CREDS_PATH,
      stagedHostPath: join(REPO_ROOT, STAGED_DIR_RELATIVE),
      ghToken: args.ghToken,
      issueNumber: args.issueNumber,
      branch: args.branch,
      reviewerLogPath,
      idleTimeoutSeconds: REVIEWER_IDLE_TIMEOUT_SECONDS,
      wallClockTimeoutMs: REVIEWER_WALL_CLOCK_TIMEOUT_MS,
    });
  } catch (err) {
    // Defensive: runReviewer already catches its own throws, but never let a
    // reviewer failure mask the implementer's commits or block label cleanup.
    console.error(`[wrapper] reviewer threw unexpectedly:`, (err as Error).message);
    await postComment(
      args.issueNumber,
      formatReviewerErrorComment({ reason: `reviewer wrapper threw: ${(err as Error).message}` }),
    );
    return undefined;
  }

  if (runResult.output !== undefined) {
    await postComment(args.issueNumber, formatReviewerComment(runResult.output));
    console.log(
      `[wrapper] reviewer for #${args.issueNumber}: ${runResult.output.verdict} (${runResult.output.findings.length} findings)`,
    );
    return runResult.output;
  }
  await postComment(
    args.issueNumber,
    formatReviewerErrorComment({
      reason: runResult.parseError ?? 'unknown',
      logFilePath: runResult.logFilePath,
    }),
  );
  console.error(
    `[wrapper] reviewer for #${args.issueNumber} produced no verdict: ${runResult.parseError ?? 'unknown'}`,
  );
  return undefined;
}

/**
 * Reads the diff for the branch — both the list of touched files and the
 * commit titles — for inclusion in the follow-up issue body. Returns empty
 * arrays on git failure rather than throwing; the follow-up still goes out
 * with less context, which is better than no follow-up at all.
 */
async function summarizeBranchForRejection(branch: string): Promise<{
  changedFiles: string[];
  commitTitles: string[];
}> {
  const namesResult = await execa('git', ['diff', '--name-only', `main..${branch}`], {
    cwd: REPO_ROOT,
    reject: false,
  });
  const changedFiles =
    namesResult.exitCode === 0 ? namesResult.stdout.split(/\r?\n/).filter((s) => s.length > 0) : [];

  const logResult = await execa('git', ['log', `main..${branch}`, '--format=%s'], {
    cwd: REPO_ROOT,
    reject: false,
  });
  const commitTitles =
    logResult.exitCode === 0 ? logResult.stdout.split(/\r?\n/).filter((s) => s.length > 0) : [];

  return { changedFiles, commitTitles };
}

interface CreatedFollowUp {
  number: number;
  url: string;
}

/**
 * Creates the follow-up issue via `gh issue create`. Returns the new issue's
 * number + URL on success, or `undefined` if the create failed (in which case
 * the wrapper still tags + discards the branch — the human can re-file from
 * the comment trail).
 */
async function createFollowUpIssue(args: {
  title: string;
  body: string;
}): Promise<CreatedFollowUp | undefined> {
  try {
    const stdout = await gh(
      [
        'issue',
        'create',
        '--title',
        args.title,
        '--body-file',
        '-',
        '--label',
        QUEUE_LABEL,
        '--label',
        PRIORITY_LABEL,
      ],
      { input: args.body },
    );
    // `gh issue create` prints the URL of the new issue on the last line.
    const url = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .pop();
    if (!url) return undefined;
    const m = /\/issues\/(\d+)$/.exec(url);
    if (!m) return undefined;
    return { number: Number(m[1]), url };
  } catch (err) {
    console.error(`[wrapper] gh issue create failed:`, (err as Error).message);
    return undefined;
  }
}

/**
 * Reviewer-FAIL outcome: tag the work, discard the branch, file a priority
 * follow-up, comment on the original. Returns `true` if the tag landed —
 * which is the load-bearing step. Follow-up creation failing is logged but
 * doesn't unwind the tag/discard: the commits are preserved at the tag and
 * the human can re-file by hand.
 */
async function handleRejection(args: {
  issue: Issue;
  branch: string;
  commits: readonly { sha: string }[];
  reviewerOutput: ReviewerOutput;
}): Promise<boolean> {
  const existingTags = await listRejectionTagsForIssue(args.issue.number, REPO_ROOT);
  const attempt = nextAttemptNumber(args.issue.number, existingTags);
  const tag = rejectionTagName(args.issue.number, attempt);

  try {
    await createRejectionTag({
      tag,
      branch: args.branch,
      cwd: REPO_ROOT,
      message: `Rejected by sandcastle-drain reviewer (attempt ${attempt}, issue #${args.issue.number}). ${args.reviewerOutput.summary}`,
    });
    console.log(`[wrapper] tagged ${args.branch} as ${tag}`);
  } catch (err) {
    console.error(
      `[wrapper] failed to tag rejected branch ${args.branch} as ${tag}:`,
      (err as Error).message,
    );
    return false;
  }

  // Capture diff/log summary *before* deleting the branch — main..branch
  // ranges resolve through the branch ref. The tag works just as well, but
  // pulling it from the branch keeps the helper independent of tagging order.
  const branchSummary = await summarizeBranchForRejection(args.branch);

  if (await branchExists(args.branch)) {
    await resetIssueState(args.branch);
    console.log(`[wrapper] discarded branch ${args.branch}`);
  }

  const followUpBody = buildFollowUpBody({
    originalIssueNumber: args.issue.number,
    rejectionTag: tag,
    attempt: attempt + 1,
    reviewerOutput: args.reviewerOutput,
    changedFiles: branchSummary.changedFiles,
    commitTitles: branchSummary.commitTitles,
  });
  const followUpTitle = buildFollowUpTitle(args.issue.number, args.issue.title);
  const followUp = await createFollowUpIssue({ title: followUpTitle, body: followUpBody });
  if (followUp) {
    console.log(`[wrapper] filed follow-up #${followUp.number} for rejected #${args.issue.number}`);
  }

  await postComment(
    args.issue.number,
    buildOriginalIssueRejectionComment({
      rejectionTag: tag,
      attempt,
      reviewerSummary: args.reviewerOutput.summary,
      followUpIssueNumber: followUp?.number,
      followUpIssueUrl: followUp?.url,
    }),
  );

  // Close the original — the follow-up is the active work item. If the
  // follow-up create failed, leave the original open so a human can re-file
  // by hand from the comment trail.
  if (followUp) {
    await closeIssue(args.issue.number);
    console.log(`[wrapper] closed #${args.issue.number} (superseded by #${followUp.number})`);
  }

  return true;
}

/**
 * Files a single split as a new GitHub issue with `sandcastle` + `priority`
 * labels, mirroring `createFollowUpIssue()`. Returns the created issue's
 * number + URL on success, or `undefined` on `gh` failure (logged, never
 * thrown — partial split filing is better than no split filing).
 */
async function createSplitIssue(args: {
  parentIssue: number;
  split: Split;
}): Promise<CreatedSplit | undefined> {
  try {
    const stdout = await gh(
      [
        'issue',
        'create',
        '--title',
        args.split.title,
        '--body-file',
        '-',
        '--label',
        QUEUE_LABEL,
        '--label',
        PRIORITY_LABEL,
      ],
      { input: args.split.body },
    );
    const url = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .pop();
    if (!url) return undefined;
    const m = /\/issues\/(\d+)$/.exec(url);
    if (!m) return undefined;
    return { number: Number(m[1]), url, title: args.split.title };
  } catch (err) {
    console.error(
      `[wrapper] gh issue create (split for #${args.parentIssue}) failed:`,
      (err as Error).message,
    );
    return undefined;
  }
}

/**
 * Split-protocol outcome: file each entry from `.sandcastle-drain/splits.json` as a
 * priority follow-up, comment on the parent linking them, apply `oversized`.
 * Returns the count + follow-up numbers, or `undefined` when the splits file
 * was malformed or every gh-create failed.
 *
 * Suppressed by the caller when the rejection loop fires — a rejected run's
 * follow-up subsumes any split intent on the same partial work.
 */
async function processSplits(args: {
  parentIssue: number;
  splitsResult: SplitsParseResult;
}): Promise<{ count: number; followUpNumbers: number[] } | undefined> {
  if (!args.splitsResult.ok) {
    await postComment(
      args.parentIssue,
      buildSplitErrorComment({ reason: args.splitsResult.reason }),
    );
    console.error(
      `[wrapper] splits.json on #${args.parentIssue} was malformed: ${args.splitsResult.reason}`,
    );
    return undefined;
  }

  const created: CreatedSplit[] = [];
  for (const split of args.splitsResult.value) {
    const result = await createSplitIssue({ parentIssue: args.parentIssue, split });
    if (result) created.push(result);
  }

  if (created.length === 0) {
    console.error(
      `[wrapper] all split issue creates failed for #${args.parentIssue}; skipping comment/label`,
    );
    return undefined;
  }

  await postComment(
    args.parentIssue,
    buildOriginalIssueSplitComment({ parentIssue: args.parentIssue, splits: created }),
  );
  await addLabel(args.parentIssue, OVERSIZED_LABEL);
  console.log(formatSplitsLogLine({ parentIssue: args.parentIssue, splits: created }));

  return {
    count: created.length,
    followUpNumbers: created.map((c) => c.number),
  };
}

/**
 * Auto-merge the slice: push, open PR, squash, then sweep the worktree.
 * Returns true on success. Any failure falls back to the manual `needs-review`
 * path — push errors, merge conflicts, and sweep failures are noisy in the log
 * but do not abort the drain. The branch is left in place so the human can
 * inspect / retry with `npm run ship <N>`.
 */
async function tryAutoMerge(issueNumber: number): Promise<boolean> {
  try {
    console.log(`[wrapper] auto-ship #${issueNumber}`);
    await shipBranch({ issue: issueNumber });
  } catch (err) {
    console.error(`[wrapper] auto-ship failed for #${issueNumber}:`, (err as Error).message);
    return false;
  }
  try {
    console.log(`[wrapper] auto-sweep #${issueNumber}`);
    await sweepBranch({ issue: issueNumber });
  } catch (err) {
    // Ship succeeded → merge is on main, the issue auto-closed via `Closes #N`.
    // Sweep failing is local-cleanup-only; the user can rerun `npm run sweep`.
    console.error(
      `[wrapper] auto-sweep failed for #${issueNumber} (ship succeeded, branch is merged):`,
      (err as Error).message,
    );
  }
  return true;
}

async function processIssue(
  issue: Issue,
  ghToken: string,
  siblings: readonly SiblingSummary[],
  failedThisRun: ReadonlySet<number>,
): Promise<RunSummary> {
  const branch = `agent/issue-${issue.number}`;
  console.log(`\n[wrapper] === Issue #${issue.number}: ${issue.title} ===`);

  // (a.pre) Dependency skip: if this issue's `## Blocked by` section names any
  // issue that failed to land earlier in *this* drain run, mark it skipped on
  // GitHub and leave `sandcastle` on so the next drain retries once the blocker
  // is resolved. Only failures from this run count; stale references to long-
  // closed issues never enter `failedThisRun`.
  if (failedThisRun.size > 0) {
    const blockers = parseBlockedBy(issue.body);
    const failedBlockers = blockers.filter((n) => failedThisRun.has(n));
    if (failedBlockers.length > 0) {
      const first = failedBlockers[0];
      console.log(`[wrapper] skipping #${issue.number} — blocked by failed #${first} this run`);
      await markSkipped(
        issue.number,
        `Blocked by #${first}, which did not land in this drain run. Re-queue after the blocker is resolved.`,
        { removeSandcastle: false },
      );
      return {
        issue: issue.number,
        status: `skipped (blocked by #${first})`,
        commitCount: 0,
      };
    }
  }

  // (a) Honor `retry` — reset all state for the branch (including any
  // worktree git still has registered against it from a killed prior run) and
  // clear the label so the next queue fetch doesn't keep re-triggering it.
  if (issue.labels.includes(RETRY_LABEL)) {
    console.log(`[wrapper] retry label set; resetting state for ${branch}`);
    await resetIssueState(branch);
    await removeLabel(issue.number, RETRY_LABEL);
  }

  // (b) Existing-branch handling — preserve possibly-good prior work, but
  // auto-discard a branch with zero commits ahead of main (no work to lose).
  // A prior drain that created the branch and died before its first commit
  // would otherwise sit stuck until the user applied `retry` manually.
  if (await branchExists(branch)) {
    if (await branchIsEmpty(branch)) {
      await resetIssueState(branch);
      console.log(`[wrapper] discarded empty stale branch ${branch} from prior run`);
    } else {
      console.log(
        `[wrapper] branch ${branch} already exists; skipping (add 'retry' label to discard and re-run)`,
      );
      await markSkipped(
        issue.number,
        `Branch \`${branch}\` already exists from a prior run — preserved to avoid losing possibly-good work. Add the \`retry\` label alongside \`sandcastle\` to discard the branch and re-run.`,
        { removeSandcastle: false },
      );
      return { issue: issue.number, status: 'skipped (existing branch)', commitCount: 0 };
    }
  }

  // (b.5) Clean up any orphaned worktree dir from a prior failed run. Without
  // this, sandcastle's WorktreeManager hits "Function not implemented" on
  // Windows when git tries to delete a pnpm-installed worktree dir.
  const worktreePath = join(REPO_ROOT, '.sandcastle-drain', 'worktrees', `agent-issue-${issue.number}`);
  if (existsSync(worktreePath)) {
    console.log(`[wrapper] cleaning orphaned worktree dir ${worktreePath}`);
    await cleanupWorktree(worktreePath);
  }

  // (c) Mark in-progress.
  await addLabel(issue.number, IN_PROGRESS_LABEL);

  // Build the sibling-context block once so we can both pass it to the agent
  // and surface its size in logs / status comment for bloat monitoring.
  const siblingContextBlock = buildSiblingContextBlock(siblings);
  const siblingContextTokens = estimateTokens(siblingContextBlock);
  if (siblings.length > 0) {
    console.log(
      `[wrapper] sibling context: ${siblings.length} sibling(s), ~${siblingContextTokens} tokens`,
    );
  }

  // (d) Run the agent — with one auto-retry on idle/wall-clock timeout. The
  // retry condition is narrow on purpose: only `failed (timeout)` retries.
  // Bail-outs, unknown errors, and rate limits are not transient and must not
  // re-burn quota. Each attempt re-creates the branch from scratch.
  let result: Awaited<ReturnType<typeof run>> | undefined;
  let runError: unknown;
  let commits: { sha: string }[] = [];
  let completionSignal: string | undefined;
  let stdout = '';
  let logFilePath: string | undefined;
  let windowsTeardownThrew = false;
  let status: RunStatus = 'failed (unknown)';
  let attempt = 1;

  while (attempt <= MAX_ATTEMPTS_PER_ISSUE) {
    if (attempt > 1) {
      console.log(
        `[wrapper] Issue #${issue.number} attempt ${attempt}/${MAX_ATTEMPTS_PER_ISSUE}: prior attempt failed (timeout), retrying`,
      );
    }

    result = undefined;
    runError = undefined;
    try {
      const prompt = await renderPrompt('implementer', {
        ISSUE_NUMBER: String(issue.number),
        ISSUE_TITLE: issue.title,
        SIBLING_CONTEXT: siblingContextBlock,
      });
      result = await run({
        agent: claudeCode('claude-opus-4-7'),
        sandbox: docker({
          imageName: IMAGE_NAME,
          mounts: [
            { hostPath: HOST_CREDS_PATH, sandboxPath: SANDBOX_CREDS_PATH },
            {
              hostPath: join(REPO_ROOT, STAGED_DIR_RELATIVE),
              sandboxPath: STAGED_SANDBOX_PATH,
              readonly: true,
            },
          ],
          // GH_TOKEN gives the in-sandbox `gh` (used by the prompt's
          // `!gh issue view ...` block, and by any agent-side `gh issue comment`)
          // the same auth as the host. Without it, gh inside the container
          // hits its "please run gh auth login" path.
          env: { GH_TOKEN: ghToken },
        }),
        prompt,
        branchStrategy: { type: 'branch', branch },
        idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
        signal: AbortSignal.timeout(WALL_CLOCK_TIMEOUT_MS),
      });
    } catch (err) {
      runError = err;
      console.error(`[wrapper] sandcastle.run() threw:`, err);
    }

    commits = result?.commits ?? [];
    completionSignal = result?.completionSignal;
    stdout =
      result?.stdout ?? (runError instanceof Error ? runError.message : String(runError ?? ''));
    // sandcastle may overwrite the same log file across attempts on the same
    // drain. We surface only the latest attempt's logFilePath in the status
    // comment — the wrapper stdout's `attempt 2/2` boundary marks where in
    // the file the second attempt begins.
    logFilePath = result?.logFilePath;

    // Windows teardown path: sandcastle.run() throws *after* the agent commits
    // because its WorktreeManager hits the pnpm-symlinks "Function not
    // implemented" landmine. `result` is undefined but the commits are on the
    // branch — read them back so this run is labeled ok (windows-teardown).
    const recovered = await tryRecoverCommits({ result, runError, branch, cwd: REPO_ROOT });
    if (recovered.length > 0) commits = recovered;
    windowsTeardownThrew = recovered.length > 0;

    status = determineRunStatus({
      commits,
      completionSignal,
      runError,
      stdout,
      windowsTeardownThrew,
    });

    // Retry decision: only on `failed (timeout)` with no commits, and only
    // when we have attempts left. Rate-limit short-circuits below; everything
    // else is terminal for this issue.
    const shouldRetry =
      status === 'failed (timeout)' &&
      attempt < MAX_ATTEMPTS_PER_ISSUE &&
      !isRateLimitError(runError) &&
      !containsRateLimit(stdout);
    if (!shouldRetry) break;

    // Between-attempt cleanup mirrors the manual `retry` label path: reset
    // all state for the branch (worktree git has registered + the branch
    // itself) so attempt 2 starts from a fresh checkout off main. Also wipe
    // the on-disk path in case the worktree was created somewhere
    // resetIssueState didn't find via git (e.g. an old-path leftover).
    if (await branchExists(branch)) await resetIssueState(branch);
    await cleanupWorktree(worktreePath);
    attempt += 1;
  }

  // (f.5) Capture `.sandcastle-drain/splits.json` from the worktree BEFORE any
  // cleanup destroys it. The implementer writes this file when the issue
  // didn't fit in one run and named follow-ups for the wrapper to file. We
  // only read it here; the actual issue-filing happens after the reviewer
  // comment posts so the audit trail is in order.
  const splitsResult = await readSplitsFile(worktreePath);

  // (g) Defensive push check.
  const pushed = await remoteBranchExists(branch);

  // (g.4) Pre-gate cleanup. Sandcastle's worktree teardown hits ENOSYS on
  // Windows pnpm symlink farms, leaving the dir + a half-broken node_modules
  // behind. Cleaning before the gate forces it down the fresh-worktree +
  // pnpm install path, and also clears the way for the reviewer at (e.5).
  if (commits.length > 0) {
    await cleanupWorktree(worktreePath);
  }

  // (g.5) CI gate — runs only when commits exist. On failure the issue goes
  // to `needs-info` instead of `needs-review`, with the CI output attached.
  let ciResult: CiGateResult | undefined;
  if (commits.length > 0) {
    console.log(`[wrapper] running CI gate for #${issue.number}`);
    try {
      ciResult = await runCiGate({
        issue: issue.number,
        branch,
        repoRoot: REPO_ROOT,
        worktreePath,
      });
      console.log(
        `[wrapper] CI gate: ${ciResult.ok ? 'PASS' : `FAIL (${ciResult.packageManager} ${ciResult.failedCheck})`}`,
      );
    } catch (err) {
      console.error(`[wrapper] CI gate threw — treating as failure:`, err);
      ciResult = {
        ok: false,
        failedCheck: 'install',
        runs: [],
        logPath: '<ci-gate threw before logging>',
        packageManager: detectPackageManager(REPO_ROOT),
      };
    }
  }

  // (e) Status comment — best effort, posted regardless of outcome.
  const comment = buildStatusComment({
    status,
    branch: commits.length > 0 ? branch : undefined,
    commits,
    stdout,
    logFilePath,
    pushedWarning: pushed,
    siblingContext: { count: siblings.length, tokens: siblingContextTokens },
    ciResult,
    attempts: { current: attempt, max: MAX_ATTEMPTS_PER_ISSUE },
  });
  await postComment(issue.number, comment);

  // (e.5) Reviewer pass — only when the implementer made commits and the run
  // didn't hit a rate limit. The reviewer is advisory for the rubric, but its
  // PASS verdict combined with a green CI gate also unlocks the auto-merge
  // path at (e.6). Skipped on rate-limit to avoid burning more quota; skipped
  // on no-commits because there's nothing to review.
  let reviewerOutput: ReviewerOutput | undefined;
  if (commits.length > 0 && !isRateLimitError(runError) && !containsRateLimit(stdout)) {
    reviewerOutput = await runAndPostReviewer({
      issueNumber: issue.number,
      branch,
      ghToken,
    });
  }
  const reviewerVerdict: ReviewerVerdict | undefined = reviewerOutput?.verdict;

  // (e.6) Auto-merge gate: CI green AND reviewer PASS → push, merge, sweep.
  // Any other combination (reviewer FAIL, parse error, throw, CI red) falls
  // through to the manual `needs-review` / `needs-info` label paths below.
  let autoMerged = false;
  if (commits.length > 0 && ciResult?.ok === true && reviewerVerdict === 'PASS') {
    autoMerged = await tryAutoMerge(issue.number);
  }

  // (e.7) Rejection loop: reviewer FAIL on commits → tag the work as
  // `rejected/issue-N-attempt-K`, discard the branch, and file a priority
  // follow-up issue carrying the reviewer findings forward. The original
  // issue is closed out with a pointer comment.
  let rejected = false;
  if (commits.length > 0 && reviewerOutput?.verdict === 'FAIL') {
    rejected = await handleRejection({
      issue,
      branch,
      commits,
      reviewerOutput,
    });
  }

  // (e.8) Split protocol: act on `.sandcastle-drain/splits.json` captured at (f.5).
  // Files each entry as a `sandcastle` + `priority` follow-up so the next
  // drain iteration picks them up. Suppressed when rejection fired — the
  // rejection follow-up already subsumes any split intent on rejected work.
  let split: { count: number; followUpNumbers: number[] } | undefined;
  if (!rejected && splitsResult !== undefined) {
    split = await processSplits({
      parentIssue: issue.number,
      splitsResult,
    });
  }

  // (f) Apply outcome labels. Always remove `sandcastle` so the wrapper
  // never silently re-queues the issue — the user re-applies `sandcastle`
  // (with `retry` for fresh-start) when they're ready.
  await removeLabel(issue.number, SKIPPED_THIS_RUN_LABEL);
  await removeLabel(issue.number, IN_PROGRESS_LABEL);
  await removeLabel(issue.number, QUEUE_LABEL);
  if (autoMerged) {
    // Squash-merge with `Closes #N` body has auto-closed the issue. No further
    // labels needed — `needs-review` would be misleading since there's nothing
    // left to review.
  } else if (rejected) {
    // Rejection loop already commented on the original issue and filed a
    // follow-up. The original needs no further state — the follow-up is now
    // the active work item.
  } else if (commits.length > 0 && ciResult?.ok === true) {
    await addLabel(issue.number, NEEDS_REVIEW_LABEL);
  } else {
    // Three paths funnel here:
    //   1. No commits + bail-out (COMPLETE without commits) or hard failure.
    //   2. Commits exist but the CI gate is red.
    //   3. Commits exist but the CI gate threw before deciding.
    // All want a human eye.
    await addLabel(issue.number, NEEDS_INFO_LABEL);
  }

  // (h) Post-run worktree cleanup. The git branch is the durable artifact;
  // the worktree dir is a build cache that, on Windows + pnpm, accumulates
  // symlink farms that defeat next-run cleanup. Run before the rate-limit
  // throw so cleanup happens even when the loop is about to abort.
  await cleanupWorktree(worktreePath);

  // Surface rate-limit upstream so the loop can break — even when commits
  // exist (status is partial-work, but we still don't drain the next issue).
  if (isRateLimitError(runError) || containsRateLimit(stdout)) {
    throw new RateLimitError();
  }

  return {
    issue: issue.number,
    status,
    // After auto-merge or rejection, the branch is gone — omit it from the
    // summary so the per-issue line and review hint don't point at a
    // dangling ref.
    branch: commits.length > 0 && !autoMerged && !rejected ? branch : undefined,
    commitCount: commits.length,
    ciOk: ciResult?.ok,
    autoMerged,
    rejected,
    split,
    attempt,
  };
}

class RateLimitError extends Error {
  constructor() {
    super('rate-limit detected; ending drain');
    this.name = 'RateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printSummary(summaries: RunSummary[]): void {
  console.log(formatSummary(summaries));
}

async function drainQueue(initial: Issue[], ghToken: string): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];
  const siblings: SiblingSummary[] = [];
  // Issues that did not auto-merge this run. Dependents named in their bodies'
  // `## Blocked by` section will be skipped — we won't build on a foundation
  // that didn't land. Survives the mid-loop refetch below.
  const failedThisRun = new Set<number>();
  let queue: Issue[] = [...initial];
  let i = 0;

  while (i < queue.length) {
    const issue = queue[i];
    try {
      const summary = await processIssue(issue, ghToken, siblings, failedThisRun);
      summaries.push(summary);

      // "Did not land" = anything except a clean auto-merge. Rejected,
      // needs-review, needs-info, CI-red, timeout — all block dependents this
      // run. Skipped issues themselves don't poison the set: they never ran.
      if (!summary.autoMerged && !summary.status.startsWith('skipped')) {
        failedThisRun.add(issue.number);
      }

      // Capture sibling context for subsequent iterations. Only branches with
      // commits AND a passing CI gate are useful — a no-commit run has nothing
      // for siblings to reuse, and a CI-broken branch would propagate red work
      // into the next agent's prompt.
      if (summary.commitCount > 0 && summary.branch && summary.ciOk !== false) {
        siblings.push(
          await summarizeBranch({
            issue: summary.issue,
            branch: summary.branch,
            baseBranch: 'main',
            cwd: REPO_ROOT,
          }),
        );
      }

      // After a rejection or split, refetch so the priority follow-ups just
      // filed by `handleRejection()` / `processSplits()` land at the front of
      // the remaining queue. `fetchQueue` naturally excludes already-
      // processed issues (the wrapper removed their `sandcastle` label) and
      // `sortQueue` floats `priority` first. Splice instead of replace so
      // already-iterated indices stay valid.
      const filedFollowUps = summary.rejected || (summary.split && summary.split.count > 0);
      if (filedFollowUps) {
        const reason = summary.rejected ? 'rejection' : 'split';
        try {
          const refreshed = await fetchQueue();
          const refreshedList = refreshed.map((r) => '#' + r.number).join(', ') || '(empty)';
          console.log(
            `[wrapper] refetched queue after ${reason} of #${issue.number}: ${refreshed.length} issue(s) — ${refreshedList}`,
          );
          queue = [...queue.slice(0, i + 1), ...refreshed];
        } catch (err) {
          // Refetch is best-effort. On failure we keep the existing tail —
          // the new follow-ups surface on the next `npm run drain`.
          console.error(
            `[wrapper] refetch after ${reason} failed (continuing with existing queue):`,
            (err as Error).message,
          );
        }
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(`[wrapper] Rate limit detected on #${issue.number}; stopping drain.`);
        // Mark remaining issues as skipped in the summary for visibility, and
        // surface the skip on GitHub so the user doesn't have to read the
        // orchestrator transcript to learn which issues the rate limit ate.
        const remaining = queue.slice(i + 1);
        for (const r of remaining) {
          await markSkipped(
            r.number,
            'sandcastle-drain hit the model rate limit before reaching this issue. Re-run drain after the limit clears.',
            { removeSandcastle: false },
          );
          summaries.push({ issue: r.number, status: 'skipped (rate-limited)', commitCount: 0 });
        }
        break;
      }
      // Anything else: log, continue. The per-issue try/catches inside
      // processIssue should normally swallow this.
      console.error(`[wrapper] Unexpected error on #${issue.number}:`, err);
      summaries.push({ issue: issue.number, status: 'failed (unknown)', commitCount: 0 });
      failedThisRun.add(issue.number);
    }
    i += 1;
  }

  return summaries;
}

/**
 * Drains the queue once. Expects `runAllPrereqs()` to have already succeeded —
 * the CLI calls that up-front so all three subcommands share the same probes.
 * On an empty queue, returns immediately; otherwise iterates the prioritized
 * queue and prints a summary at the end.
 */
export async function runDrain(args: { token: string }): Promise<void> {
  console.log('[wrapper] sandcastle-drain starting');

  const queue = await fetchQueue();
  if (queue.length === 0) {
    console.log('[wrapper] Queue empty');
    return;
  }
  console.log(
    `[wrapper] Queue: ${queue.length} issue(s) — ${queue.map((i) => `#${i.number}`).join(', ')}`,
  );

  const summaries = await drainQueue(queue, args.token);
  printSummary(summaries);
}
