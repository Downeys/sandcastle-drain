/**
 * Rejection / CI-failure loop — close out a run whose work cannot ship.
 *
 * Two parallel flows funnel through this module:
 *
 *   - **Reviewer rejection** — the reviewer FAILed on commits. Tag is
 *     `rejected/issue-N-attempt-K`; follow-up body carries the reviewer
 *     findings forward as a checklist.
 *   - **CI failure** — the CI gate stayed red after the fixer loop exhausted
 *     its attempts. Tag is `ci-failed/issue-N-attempt-K`; follow-up body
 *     carries the failing-check name and CI excerpt forward as guidance.
 *
 * Both paths share the structural plumbing here: compute `attempt-K` from
 * existing tags, tag the branch tip so commits survive deletion, build the
 * follow-up issue body, and render the pointer comment for the original
 * issue. Branch deletion, label changes, and gh CLI calls happen in `main.ts`
 * so this module stays a thin layer over pure rendering + git plumbing.
 */
import { execa } from 'execa';
import type { CiGateResult } from './ci-gate.js';
import type { ReviewerOutput, ReviewerFinding, FindingSeverity } from './reviewer.js';

export const REJECTION_TAG_PREFIX = 'rejected/issue-';
export const CI_FAILED_TAG_PREFIX = 'ci-failed/issue-';
export const PRIORITY_LABEL = 'priority';

/**
 * Queue ordering: `priority`-labeled issues first (so a rejection-loop
 * follow-up runs ahead of pending work), then by issue number. Stable for
 * issues with the same priority bucket so a fixed queue produces a fixed
 * order.
 */
export function sortQueue<T extends { number: number; labels: readonly string[] }>(
  issues: readonly T[],
): T[] {
  return [...issues].sort((a, b) => {
    const aPriority = a.labels.includes(PRIORITY_LABEL);
    const bPriority = b.labels.includes(PRIORITY_LABEL);
    if (aPriority !== bPriority) return aPriority ? -1 : 1;
    return a.number - b.number;
  });
}

export function rejectionTagName(issue: number, attempt: number): string {
  return `${REJECTION_TAG_PREFIX}${issue}-attempt-${attempt}`;
}

export function ciFailureTagName(issue: number, attempt: number): string {
  return `${CI_FAILED_TAG_PREFIX}${issue}-attempt-${attempt}`;
}

function nextAttemptForPrefix(prefix: string, issue: number, tags: readonly string[]): number {
  const re = new RegExp(String.raw`^${prefix}${issue}-attempt-(\d+)$`);
  let max = 0;
  for (const tag of tags) {
    const m = re.exec(tag);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Given the set of existing local tags, returns the next attempt number for
 * this issue. Counts only tags matching `rejected/issue-N-attempt-K` exactly —
 * unrelated tags are ignored.
 */
export function nextAttemptNumber(issue: number, tags: readonly string[]): number {
  return nextAttemptForPrefix(REJECTION_TAG_PREFIX, issue, tags);
}

/**
 * Like `nextAttemptNumber` but counts `ci-failed/issue-N-attempt-K` tags. CI-
 * failure attempt counts are independent of reviewer-rejection counts; an
 * issue can have an `attempt-1` of each kind.
 */
export function nextCiAttemptNumber(issue: number, tags: readonly string[]): number {
  return nextAttemptForPrefix(CI_FAILED_TAG_PREFIX, issue, tags);
}

export interface FollowUpIssueBodyArgs {
  originalIssueNumber: number;
  rejectionTag: string;
  attempt: number;
  reviewerOutput: ReviewerOutput;
  changedFiles: readonly string[];
  commitTitles: readonly string[];
}

function severityBadge(s: FindingSeverity): string {
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  return 'low';
}

function findingChecklistLine(f: ReviewerFinding): string {
  const location = f.line > 0 ? `${f.file}:${f.line}` : f.file;
  return `- [ ] **[${severityBadge(f.severity)}] ${f.principle}** — \`${location}\`: ${f.message} _(suggested: ${f.suggestedFix})_`;
}

function severityRank(s: FindingSeverity): number {
  if (s === 'high') return 0;
  if (s === 'medium') return 1;
  return 2;
}

/**
 * Renders the body of the follow-up issue. The next implementer reads this as
 * their starting point — it must contain enough context to restart without
 * cold-starting from the original issue alone:
 *
 *   - link back to the original
 *   - reviewer summary + findings as a checklist (each becomes a TODO)
 *   - what the prior attempt touched (files, commit titles)
 *   - pointer to the rejected tag for `git diff` of the prior attempt
 */
export function buildFollowUpBody(args: FollowUpIssueBodyArgs): string {
  const { originalIssueNumber, rejectionTag, attempt, reviewerOutput, changedFiles, commitTitles } =
    args;
  const orderedFindings = [...reviewerOutput.findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );

  const lines: string[] = [];
  lines.push(`Follow-up to #${originalIssueNumber} — attempt ${attempt - 1} was rejected by the`);
  lines.push(`sandcastle-drain reviewer. Address the findings below and try again.`);
  lines.push('');
  lines.push(`## Reviewer summary`);
  lines.push('');
  lines.push(reviewerOutput.summary);
  lines.push('');
  lines.push(`## Reviewer findings`);
  lines.push('');
  if (orderedFindings.length === 0) {
    lines.push('_No structured findings — see the reviewer comment on the original issue._');
  } else {
    for (const f of orderedFindings) {
      lines.push(findingChecklistLine(f));
    }
  }
  lines.push('');
  lines.push(`## Prior attempt`);
  lines.push('');
  lines.push(`Commits from the rejected attempt are preserved at the \`${rejectionTag}\` tag.`);
  lines.push(
    `Diff with \`git diff main..${rejectionTag}\` to see what the prior implementer tried.`,
  );
  lines.push('');
  if (commitTitles.length > 0) {
    lines.push('Commit titles:');
    lines.push('');
    for (const title of commitTitles) {
      lines.push(`- ${title}`);
    }
    lines.push('');
  }
  if (changedFiles.length > 0) {
    lines.push('Files touched:');
    lines.push('');
    for (const file of changedFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }
  lines.push(`## Original issue`);
  lines.push('');
  lines.push(`See #${originalIssueNumber} for the full requirements.`);
  return lines.join('\n').trimEnd();
}

export function buildFollowUpTitle(originalNumber: number, originalTitle: string): string {
  return `[follow-up #${originalNumber}] ${originalTitle}`;
}

export function buildCiFailureFollowUpTitle(originalNumber: number, originalTitle: string): string {
  return `[ci-failed #${originalNumber}] ${originalTitle}`;
}

export interface CiFailureFollowUpBodyArgs {
  originalIssueNumber: number;
  ciFailureTag: string;
  attempt: number;
  finalCiResult: CiGateResult;
  fixerAttempts: readonly { ciPassed: boolean; hadCommits: boolean }[];
  changedFiles: readonly string[];
  commitTitles: readonly string[];
}

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function fixerAttemptOutcomeLabel(a: { ciPassed: boolean; hadCommits: boolean }): string {
  if (a.ciPassed) return 'CI green (no exhaustion expected)';
  if (a.hadCommits) return 'committed a fix but CI stayed red';
  return 'no commits';
}

function fixerSummarySentence(fixerCount: number): string {
  if (fixerCount === 0) return 'no fixer attempts were made';
  return `${fixerCount} fixer attempt(s) could not get the gate green`;
}

function renderFailingCheckSection(finalCiResult: CiGateResult, lines: string[]): void {
  const failedCheck = finalCiResult.failedCheck ?? 'unknown';
  const failedRun = finalCiResult.runs.find((r) => r.exitCode !== 0);
  lines.push(`## Failing CI check`);
  lines.push('');
  lines.push(
    `\`${finalCiResult.packageManager} ${failedCheck}\` exited non-zero in the prior attempt's worktree.`,
  );
  if (!failedRun) return;
  lines.push('');
  lines.push('<details><summary>Last ~50 lines of CI output</summary>');
  lines.push('');
  lines.push('```');
  lines.push(lastLines(failedRun.output, 50));
  lines.push('```');
  lines.push('');
  lines.push('</details>');
}

function renderFixerAttemptsSection(
  fixerAttempts: readonly { ciPassed: boolean; hadCommits: boolean }[],
  lines: string[],
): void {
  if (fixerAttempts.length === 0) return;
  lines.push('');
  lines.push(`## Fixer attempts`);
  lines.push('');
  for (let i = 0; i < fixerAttempts.length; i++) {
    lines.push(`- Attempt ${i + 1}: ${fixerAttemptOutcomeLabel(fixerAttempts[i])}`);
  }
}

function renderPriorAttemptSection(
  ciFailureTag: string,
  commitTitles: readonly string[],
  changedFiles: readonly string[],
  lines: string[],
): void {
  lines.push('');
  lines.push(`## Prior attempt`);
  lines.push('');
  lines.push(`Commits from the prior attempt are preserved at the \`${ciFailureTag}\` tag.`);
  lines.push(
    `Diff with \`git diff main..${ciFailureTag}\` to see what the prior implementer tried.`,
  );
  lines.push('');
  if (commitTitles.length > 0) {
    lines.push('Commit titles:');
    lines.push('');
    for (const title of commitTitles) {
      lines.push(`- ${title}`);
    }
    lines.push('');
  }
  if (changedFiles.length > 0) {
    lines.push('Files touched:');
    lines.push('');
    for (const file of changedFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }
}

/**
 * Renders the body of the CI-failure follow-up issue. Mirrors
 * `buildFollowUpBody` but the rubric source is the CI gate, not the reviewer.
 * The next implementer reads this as the starting context for another attempt:
 *
 *   - link back to the original
 *   - which check failed last (typecheck / lint / test / install)
 *   - the tail of the failing CI output (so the failure mode is concrete)
 *   - how many fixer attempts the wrapper made, and that none recovered
 *   - what the prior attempt touched (files, commit titles)
 *   - pointer to the ci-failed tag for `git diff` of the prior attempt
 */
export function buildCiFailureFollowUpBody(args: CiFailureFollowUpBodyArgs): string {
  const {
    originalIssueNumber,
    ciFailureTag,
    attempt,
    finalCiResult,
    fixerAttempts,
    changedFiles,
    commitTitles,
  } = args;
  const lines: string[] = [];
  lines.push(`Follow-up to #${originalIssueNumber} — attempt ${attempt - 1} failed the CI gate`);
  lines.push(`and ${fixerSummarySentence(fixerAttempts.length)}.`);
  lines.push('Try a fresh approach; pay attention to the failing check below.');
  lines.push('');
  renderFailingCheckSection(finalCiResult, lines);
  renderFixerAttemptsSection(fixerAttempts, lines);
  renderPriorAttemptSection(ciFailureTag, commitTitles, changedFiles, lines);
  lines.push(`## Original issue`);
  lines.push('');
  lines.push(`See #${originalIssueNumber} for the full requirements.`);
  return lines.join('\n').trimEnd();
}

export interface OriginalIssueRejectionCommentArgs {
  rejectionTag: string;
  attempt: number;
  reviewerSummary: string;
  followUpIssueNumber?: number;
  followUpIssueUrl?: string;
}

function followUpReferenceLine(
  followUpIssueNumber: number | undefined,
  followUpIssueUrl: string | undefined,
  lines: string[],
): void {
  if (followUpIssueNumber === undefined) {
    lines.push(`_(Follow-up issue creation failed — see wrapper logs.)_`);
    return;
  }
  const ref = followUpIssueUrl
    ? `#${followUpIssueNumber} (${followUpIssueUrl})`
    : `#${followUpIssueNumber}`;
  lines.push(`Follow-up filed as ${ref} with the \`priority\` label — it will run next.`);
  lines.push('');
  lines.push(`Closing this issue — the follow-up is the active work item.`);
}

/**
 * The note left on the original issue. Tells the human reader: "this attempt
 * was rejected, here's the verdict, here's the follow-up that picks it up."
 */
export function buildOriginalIssueRejectionComment(
  args: OriginalIssueRejectionCommentArgs,
): string {
  const lines: string[] = [];
  lines.push(`**Attempt ${args.attempt} rejected.** The reviewer FAILed this run.`);
  lines.push('');
  lines.push(`> ${args.reviewerSummary}`);
  lines.push('');
  lines.push(`Rejected commits preserved at tag \`${args.rejectionTag}\`.`);
  lines.push(`The working branch has been discarded.`);
  lines.push('');
  followUpReferenceLine(args.followUpIssueNumber, args.followUpIssueUrl, lines);
  return lines.join('\n');
}

export interface OriginalIssueCiFailureCommentArgs {
  ciFailureTag: string;
  attempt: number;
  finalCiResult: CiGateResult;
  fixerAttempts: number;
  followUpIssueNumber?: number;
  followUpIssueUrl?: string;
}

/**
 * Note left on the original issue after CI failure exhausts the fixer loop.
 * Tells the human reader: "the implementer committed but CI never went green,
 * we tried the fixer N times, here's the follow-up that picks it up."
 */
export function buildOriginalIssueCiFailureComment(
  args: OriginalIssueCiFailureCommentArgs,
): string {
  const failedCheck = args.finalCiResult.failedCheck ?? 'unknown';
  const lines: string[] = [];
  lines.push(`**Attempt ${args.attempt} failed CI.** The fixer agent ran ${args.fixerAttempts} time(s) but couldn't get the gate green.`);
  lines.push('');
  lines.push(`> Failing check: \`${args.finalCiResult.packageManager} ${failedCheck}\``);
  lines.push('');
  lines.push(`Commits preserved at tag \`${args.ciFailureTag}\`.`);
  lines.push(`The working branch has been discarded.`);
  lines.push('');
  followUpReferenceLine(args.followUpIssueNumber, args.followUpIssueUrl, lines);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

async function listTagsForPrefix(prefix: string, issue: number, cwd: string): Promise<string[]> {
  const result = await execa(
    'git',
    ['tag', '--list', `${prefix}${issue}-attempt-*`],
    { cwd, reject: false },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function listRejectionTagsForIssue(issue: number, cwd: string): Promise<string[]> {
  return listTagsForPrefix(REJECTION_TAG_PREFIX, issue, cwd);
}

export async function listCiFailureTagsForIssue(issue: number, cwd: string): Promise<string[]> {
  return listTagsForPrefix(CI_FAILED_TAG_PREFIX, issue, cwd);
}

/**
 * Creates an annotated tag at the branch tip. The tag prefix carries the
 * semantic (rejected/ci-failed/…); callers pre-format `tag` via
 * `rejectionTagName()` or `ciFailureTagName()`.
 *
 * The annotated form (-a + -m) ensures the message — which records why this
 * tag was created — survives in `git show <tag>`. The branch is named
 * explicitly so the tag is independent of HEAD.
 */
export async function createRejectionTag(args: {
  tag: string;
  branch: string;
  cwd: string;
  message: string;
}): Promise<void> {
  const result = await execa('git', ['tag', '-a', args.tag, args.branch, '-m', args.message], {
    cwd: args.cwd,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git tag failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Convenience alias — `createRejectionTag` is generic on the tag name. Naming
 * the CI-failure path explicitly at call sites makes the intent clearer.
 */
export const createCiFailureTag = createRejectionTag;
