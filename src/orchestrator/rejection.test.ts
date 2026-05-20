import { describe, expect, it } from 'vitest';
import {
  buildCiFailureFollowUpBody,
  buildCiFailureFollowUpTitle,
  buildOriginalIssueCiFailureComment,
  ciFailureTagName,
  CI_FAILED_TAG_PREFIX,
  nextAttemptNumber,
  nextCiAttemptNumber,
  REJECTION_TAG_PREFIX,
  rejectionTagName,
} from './rejection.js';
import type { CiGateResult } from './ci-gate.js';

describe('tag-name helpers', () => {
  it('rejectionTagName uses the rejected/issue- prefix', () => {
    expect(rejectionTagName(42, 1)).toBe(`${REJECTION_TAG_PREFIX}42-attempt-1`);
  });

  it('ciFailureTagName uses the ci-failed/issue- prefix', () => {
    expect(ciFailureTagName(42, 1)).toBe(`${CI_FAILED_TAG_PREFIX}42-attempt-1`);
  });
});

describe('nextAttemptNumber / nextCiAttemptNumber', () => {
  it('returns 1 when no prior tags for the issue', () => {
    expect(nextAttemptNumber(42, [])).toBe(1);
    expect(nextCiAttemptNumber(42, [])).toBe(1);
  });

  it('counts only tags that match the prefix for this issue', () => {
    const tags = [
      'rejected/issue-42-attempt-1',
      'rejected/issue-42-attempt-2',
      'rejected/issue-99-attempt-1',
      'random-tag',
      'v1.0.0',
    ];
    expect(nextAttemptNumber(42, tags)).toBe(3);
    expect(nextAttemptNumber(99, tags)).toBe(2);
  });

  it('keeps the rejection and ci-failure attempt counters independent', () => {
    const tags = [
      'rejected/issue-42-attempt-1',
      'rejected/issue-42-attempt-2',
      'ci-failed/issue-42-attempt-1',
    ];
    expect(nextAttemptNumber(42, tags)).toBe(3);
    expect(nextCiAttemptNumber(42, tags)).toBe(2);
  });

  it('ignores malformed attempt numbers', () => {
    const tags = ['rejected/issue-42-attempt-banana', 'rejected/issue-42-attempt-3'];
    expect(nextAttemptNumber(42, tags)).toBe(4);
  });
});

describe('buildCiFailureFollowUpTitle', () => {
  it('prefixes the original title with [ci-failed #N]', () => {
    expect(buildCiFailureFollowUpTitle(42, 'Wire the user-service port')).toBe(
      '[ci-failed #42] Wire the user-service port',
    );
  });
});

function ciResult(): CiGateResult {
  return {
    ok: false,
    failedCheck: 'typecheck',
    runs: [
      {
        check: 'typecheck',
        exitCode: 1,
        output: 'src/foo.ts(12,5): error TS2307: Cannot find module ./bar',
      },
    ],
    logPath: '/tmp/ci.log',
    packageManager: 'pnpm',
  };
}

describe('buildCiFailureFollowUpBody', () => {
  it('includes the failing-check name, output excerpt, fixer attempt outcomes, and tag pointer', () => {
    const body = buildCiFailureFollowUpBody({
      originalIssueNumber: 42,
      ciFailureTag: 'ci-failed/issue-42-attempt-1',
      attempt: 2,
      finalCiResult: ciResult(),
      fixerAttempts: [
        { ciPassed: false, hadCommits: true },
        { ciPassed: false, hadCommits: false },
      ],
      changedFiles: ['src/foo.ts', 'src/bar.ts'],
      commitTitles: ['feat: wire user-service port'],
    });
    expect(body).toContain('Follow-up to #42');
    expect(body).toContain('## Failing CI check');
    expect(body).toContain('pnpm typecheck');
    expect(body).toContain('TS2307');
    expect(body).toContain('## Fixer attempts');
    expect(body).toContain('Attempt 1: committed a fix but CI stayed red');
    expect(body).toContain('Attempt 2: no commits');
    expect(body).toContain('## Prior attempt');
    expect(body).toContain('ci-failed/issue-42-attempt-1');
    expect(body).toContain('git diff main..ci-failed/issue-42-attempt-1');
    expect(body).toContain('- `src/foo.ts`');
    expect(body).toContain('- feat: wire user-service port');
    expect(body).toContain('See #42');
  });

  it('omits the fixer-attempts section when no attempts ran', () => {
    const body = buildCiFailureFollowUpBody({
      originalIssueNumber: 42,
      ciFailureTag: 'ci-failed/issue-42-attempt-1',
      attempt: 2,
      finalCiResult: ciResult(),
      fixerAttempts: [],
      changedFiles: [],
      commitTitles: [],
    });
    expect(body).not.toContain('## Fixer attempts');
    expect(body).toContain('no fixer attempts were made');
  });
});

describe('buildOriginalIssueCiFailureComment', () => {
  it('includes the failing-check, fixer-attempt count, tag, and follow-up reference', () => {
    const body = buildOriginalIssueCiFailureComment({
      ciFailureTag: 'ci-failed/issue-42-attempt-1',
      attempt: 1,
      finalCiResult: ciResult(),
      fixerAttempts: 2,
      followUpIssueNumber: 43,
      followUpIssueUrl: 'https://example/issues/43',
    });
    expect(body).toContain('Attempt 1 failed CI');
    expect(body).toContain('fixer agent ran 2 time(s)');
    expect(body).toContain('pnpm typecheck');
    expect(body).toContain('ci-failed/issue-42-attempt-1');
    expect(body).toContain('Follow-up filed as #43');
    expect(body).toContain('Closing this issue');
  });

  it('emits the follow-up-creation-failed line when no follow-up landed', () => {
    const body = buildOriginalIssueCiFailureComment({
      ciFailureTag: 'ci-failed/issue-42-attempt-1',
      attempt: 1,
      finalCiResult: ciResult(),
      fixerAttempts: 2,
    });
    expect(body).toContain('Follow-up issue creation failed');
    expect(body).not.toContain('Closing this issue');
  });
});
