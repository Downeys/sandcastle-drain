export type RunStatus =
  | 'completed'
  | 'partial-work'
  | 'ok (windows-teardown)'
  | 'bailed-out'
  | 'failed (rate limit)'
  | 'failed (timeout)'
  | 'failed (unknown)';

const RATE_LIMIT_MARKERS = ['rate limit', 'usage limit', 'Please try again'];

export function containsRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

export function isRateLimitError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return containsRateLimit(text);
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    const msg = err.message.toLowerCase();
    if (msg.includes('abort') || msg.includes('timeout') || msg.includes('idle')) return true;
  }
  return false;
}

export function determineRunStatus(args: {
  commits: { sha: string }[];
  completionSignal: string | undefined;
  runError: unknown;
  stdout: string;
  windowsTeardownThrew?: boolean;
}): RunStatus {
  const { commits, completionSignal, runError, stdout, windowsTeardownThrew = false } = args;

  if (commits.length > 0) {
    if (windowsTeardownThrew && runError !== undefined) return 'ok (windows-teardown)';
    return completionSignal !== undefined ? 'completed' : 'partial-work';
  }

  if (completionSignal !== undefined) {
    return 'bailed-out';
  }

  if (runError) {
    if (isRateLimitError(runError)) return 'failed (rate limit)';
    if (isAbortError(runError)) return 'failed (timeout)';
    return 'failed (unknown)';
  }

  if (containsRateLimit(stdout)) {
    return 'failed (rate limit)';
  }

  return 'failed (unknown)';
}
