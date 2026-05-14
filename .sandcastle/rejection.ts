/**
 * Rejection loop — close out a reviewer-FAIL run.
 *
 * When the reviewer returns `FAIL`, the implementer's commits are not safe to
 * merge but the work is still worth preserving for the next attempt's prompt.
 * This module:
 *
 *   1. Computes the next `attempt-K` number by counting existing
 *      `rejected/issue-N-attempt-*` tags.
 *   2. Tags the branch tip as `rejected/issue-N-attempt-K` so the commits
 *      survive the upcoming branch deletion.
 *   3. Returns the rendered body for a follow-up GitHub issue (reviewer
 *      findings as a checklist, files touched, pointer to the tag), plus the
 *      comment to leave on the original issue.
 *
 * Branch deletion, label changes, and gh CLI calls happen in `main.ts` so this
 * module stays a thin layer over pure rendering + git plumbing.
 */
import { execa } from 'execa';
import type { ReviewerOutput, ReviewerFinding, FindingSeverity } from './reviewer.js';

export const REJECTION_TAG_PREFIX = 'rejected/issue-';
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

/**
 * Given the set of existing local tags, returns the next attempt number for
 * this issue. Counts only tags matching `rejected/issue-N-attempt-K` exactly —
 * unrelated tags are ignored.
 */
export function nextAttemptNumber(issue: number, tags: readonly string[]): number {
  const re = new RegExp(`^${REJECTION_TAG_PREFIX}${issue}-attempt-(\\d+)$`);
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
  lines.push(`Sandcastle reviewer. Address the findings below and try again.`);
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

export interface OriginalIssueRejectionCommentArgs {
  rejectionTag: string;
  attempt: number;
  reviewerSummary: string;
  followUpIssueNumber?: number;
  followUpIssueUrl?: string;
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
  if (args.followUpIssueNumber !== undefined) {
    const ref = args.followUpIssueUrl
      ? `#${args.followUpIssueNumber} (${args.followUpIssueUrl})`
      : `#${args.followUpIssueNumber}`;
    lines.push(`Follow-up filed as ${ref} with the \`priority\` label — it will run next.`);
    lines.push('');
    lines.push(`Closing this issue — the follow-up is the active work item.`);
  } else {
    lines.push(`_(Follow-up issue creation failed — see wrapper logs.)_`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

export async function listRejectionTagsForIssue(issue: number, cwd: string): Promise<string[]> {
  const result = await execa(
    'git',
    ['tag', '--list', `${REJECTION_TAG_PREFIX}${issue}-attempt-*`],
    { cwd, reject: false },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function createRejectionTag(args: {
  tag: string;
  branch: string;
  cwd: string;
  message: string;
}): Promise<void> {
  // Annotated tag (-a) so the message — which records the rejection reason —
  // survives in `git show <tag>`. Targets the branch tip explicitly so the tag
  // is independent of HEAD.
  const result = await execa('git', ['tag', '-a', args.tag, args.branch, '-m', args.message], {
    cwd: args.cwd,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git tag failed: ${result.stderr || result.stdout}`);
  }
}
