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
  // When the rejection loop filed a priority follow-up, the new issue's number.
  // Lets the drain loop track supersession chains and rehabilitate ancestors
  // from `failedThisRun` if the chain eventually auto-merges.
  rejectionFollowUp?: number;
  // true when the CI gate stayed red across the implementer + all fixer
  // attempts, and the wrapper tagged the commits + filed a priority CI-
  // failure follow-up. Mutually exclusive with autoMerged and rejected.
  ciFailed?: boolean;
  // When the CI-failure loop filed a priority follow-up, the new issue's
  // number. Same supersession-chain semantics as rejectionFollowUp.
  ciFailureFollowUp?: number;
  // Number of fixer-agent attempts the wrapper made on this issue. Undefined
  // when the initial CI gate passed (or never ran); otherwise 0..N. A non-
  // zero value with ciOk: true means the fixer recovered a red gate.
  fixerAttempts?: number;
  // Set when the implementer wrote `.sandcastle-drain/splits.json` and the wrapper
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
  ciFollowedUp: number;
  fixerRecovered: number;
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

const isCiFailed = (s: RunSummary): boolean => s.ciFailed === true;

const isSplit = (s: RunSummary): boolean => s.split !== undefined && s.split.count > 0;

const isFixerRecovered = (s: RunSummary): boolean =>
  s.fixerAttempts !== undefined && s.fixerAttempts > 0 && s.ciOk === true;

function splitSuffix(s: RunSummary): string {
  if (!s.split || s.split.count === 0) return '';
  const plural = s.split.count === 1 ? '' : 's';
  return ` [split: ${s.split.count} follow-up${plural}]`;
}

const isReview = (s: RunSummary): boolean =>
  hasReviewStatus(s) && s.ciOk !== false && !isAutoMerged(s) && !isRejected(s) && !isCiFailed(s);

const isFailed = (s: RunSummary): boolean =>
  typeof s.status === 'string' && s.status.startsWith('failed');

// CI-failed runs no longer fall through to needs-info — they're tagged +
// filed as a priority follow-up and tracked under `ciFailed` instead.
const isInfo = (s: RunSummary): boolean =>
  s.status === 'bailed-out' ||
  isFailed(s) ||
  (hasReviewStatus(s) && s.ciOk === false && !isCiFailed(s));

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
    ciFollowedUp: summaries.filter(isCiFailed).length,
    fixerRecovered: summaries.filter(isFixerRecovered).length,
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
    `  attempted    : ${c.attempted}`,
    `  auto-merged  : ${c.autoMerged}`,
    `  rejected     : ${c.rejected}`,
    `  ci-followup  : ${c.ciFollowedUp}`,
    `  fixer-saved  : ${c.fixerRecovered}`,
    `  split        : ${c.split}`,
    `  needs-review : ${c.needsReview} (${c.completed} completed, ${c.partialWork} partial, ${c.windowsTeardown} windows-teardown)`,
    `  needs-info   : ${c.needsInfo} (${c.bailedOut} bailed-out, ${c.failed} failed)`,
    `  skipped      : ${c.skipped}`,
    `  failed       : ${c.failed}`,
    '',
  ];
  for (const s of summaries) {
    lines.push(`  #${s.issue}: ${s.status}${formatSuffixes(s)}`);
  }
  return lines.join('\n');
}

function formatSuffixes(s: RunSummary): string {
  const branchPart = s.branch ? ` (${s.branch}, ${s.commitCount} commits)` : '';
  const reviewHint = s.branch ? ` — review with: git diff main..${s.branch}` : '';
  const ciSuffix = s.ciOk === false ? ' [CI FAILED]' : '';
  const mergedSuffix = s.autoMerged ? ' [auto-merged]' : '';
  const rejectedSuffix = s.rejected ? ' [rejected]' : '';
  const ciFailedSuffix = s.ciFailed ? ' [ci-failed → follow-up]' : '';
  const fixerSuffix =
    s.fixerAttempts && s.fixerAttempts > 0 && s.ciOk === true
      ? ` [fixer: ${s.fixerAttempts}x]`
      : '';
  const split = splitSuffix(s);
  const attemptSuffix = s.attempt && s.attempt > 1 ? ` (attempt ${s.attempt})` : '';
  return `${ciSuffix}${mergedSuffix}${rejectedSuffix}${ciFailedSuffix}${fixerSuffix}${split}${attemptSuffix}${branchPart}${reviewHint}`;
}
