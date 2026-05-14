import type { RunStatus } from './status.js';

export interface RunSummary {
  issue: number;
  status:
    | RunStatus
    | 'skipped (existing branch)'
    | 'skipped (rate-limited)'
    | `skipped (blocked by #${number})`;
  branch?: string;
  commitCount: number;
  // undefined when the CI gate didn't run (no commits, or pre-CI failure path).
  // false promotes an otherwise review-bound run to needs-info.
  ciOk?: boolean;
  // true when the wrapper auto-shipped + auto-swept the slice. Implies CI green
  // and reviewer PASS happened; the branch is merged and the issue is closed.
  autoMerged?: boolean;
  // true when the reviewer FAILed and the rejection loop tagged the commits,
  // discarded the branch, and filed a priority follow-up issue. Mutually
  // exclusive with autoMerged.
  rejected?: boolean;
  // Set when the implementer wrote `.sandcastle/splits.json` and the wrapper
  // filed each entry as a `sandcastle` + `priority` follow-up. `count` is the
  // number of follow-ups filed (may be < requested if some gh create calls
  // failed). Independent of autoMerged / rejected — splits can co-exist with
  // a clean foundation merge, and are suppressed when rejection fires.
  split?: { count: number; followUpNumbers: readonly number[] };
  // Number of agent attempts the wrapper made before settling on this status.
  // Omitted (or 1) on the no-retry default path; > 1 only when the wrapper
  // auto-retried after a timeout.
  attempt?: number;
}

export interface SummaryCounts {
  attempted: number;
  completed: number;
  partialWork: number;
  windowsTeardown: number;
  bailedOut: number;
  failed: number;
  ciFailed: number;
  needsReview: number;
  needsInfo: number;
  autoMerged: number;
  rejected: number;
  split: number;
  skipped: number;
}

const hasReviewStatus = (s: RunSummary): boolean =>
  s.status === 'completed' || s.status === 'partial-work' || s.status === 'ok (windows-teardown)';

const isAutoMerged = (s: RunSummary): boolean => s.autoMerged === true;

const isRejected = (s: RunSummary): boolean => s.rejected === true;

const isSplit = (s: RunSummary): boolean => s.split !== undefined && s.split.count > 0;

function splitSuffix(s: RunSummary): string {
  if (!s.split || s.split.count === 0) return '';
  const plural = s.split.count === 1 ? '' : 's';
  return ` [split: ${s.split.count} follow-up${plural}]`;
}

const isReview = (s: RunSummary): boolean =>
  hasReviewStatus(s) && s.ciOk !== false && !isAutoMerged(s) && !isRejected(s);

const isFailed = (s: RunSummary): boolean =>
  typeof s.status === 'string' && s.status.startsWith('failed');

const isInfo = (s: RunSummary): boolean =>
  s.status === 'bailed-out' || isFailed(s) || (hasReviewStatus(s) && s.ciOk === false);

const isSkipped = (s: RunSummary): boolean =>
  typeof s.status === 'string' && s.status.startsWith('skipped');

export function computeCounts(summaries: readonly RunSummary[]): SummaryCounts {
  return {
    attempted: summaries.length,
    completed: summaries.filter((s) => s.status === 'completed').length,
    partialWork: summaries.filter((s) => s.status === 'partial-work').length,
    windowsTeardown: summaries.filter((s) => s.status === 'ok (windows-teardown)').length,
    bailedOut: summaries.filter((s) => s.status === 'bailed-out').length,
    failed: summaries.filter(isFailed).length,
    ciFailed: summaries.filter((s) => hasReviewStatus(s) && s.ciOk === false).length,
    needsReview: summaries.filter(isReview).length,
    needsInfo: summaries.filter(isInfo).length,
    autoMerged: summaries.filter(isAutoMerged).length,
    rejected: summaries.filter(isRejected).length,
    split: summaries.filter(isSplit).length,
    skipped: summaries.filter(isSkipped).length,
  };
}

export function formatSummary(summaries: readonly RunSummary[]): string {
  const c = computeCounts(summaries);
  const lines = [
    '',
    '[wrapper] === Drain summary ===',
    `  attempted   : ${c.attempted}`,
    `  auto-merged : ${c.autoMerged}`,
    `  rejected    : ${c.rejected}`,
    `  split       : ${c.split}`,
    `  needs-review: ${c.needsReview} (${c.completed} completed, ${c.partialWork} partial, ${c.windowsTeardown} windows-teardown)`,
    `  needs-info  : ${c.needsInfo} (${c.bailedOut} bailed-out, ${c.failed} failed, ${c.ciFailed} ci-failed)`,
    `  skipped     : ${c.skipped}`,
    `  failed      : ${c.failed}`,
    '',
  ];
  for (const s of summaries) {
    const branchPart = s.branch ? ` (${s.branch}, ${s.commitCount} commits)` : '';
    const reviewHint = s.branch ? ` — review with: git diff main..${s.branch}` : '';
    const ciSuffix = s.ciOk === false ? ' [CI FAILED]' : '';
    const mergedSuffix = s.autoMerged ? ' [auto-merged]' : '';
    const rejectedSuffix = s.rejected ? ' [rejected]' : '';
    const split = splitSuffix(s);
    const attemptSuffix = s.attempt && s.attempt > 1 ? ` (attempt ${s.attempt})` : '';
    lines.push(
      `  #${s.issue}: ${s.status}${ciSuffix}${mergedSuffix}${rejectedSuffix}${split}${attemptSuffix}${branchPart}${reviewHint}`,
    );
  }
  return lines.join('\n');
}
