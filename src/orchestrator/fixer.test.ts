import { describe, expect, it } from 'vitest';
import { formatFixerComment, formatFixerSection, type FixerAttempt } from './fixer.js';
import type { CiGateResult } from './ci-gate.js';

function fixerRun(args: {
  commits: number;
  logFilePath?: string;
  runError?: string;
  stdout?: string;
}) {
  return {
    newCommits: Array.from({ length: args.commits }, (_, i) => ({ sha: `${i}`.padStart(7, '0') })),
    stdout: args.stdout ?? '',
    logFilePath: args.logFilePath,
    runError: args.runError,
  };
}

function ciGreen(): CiGateResult {
  return {
    ok: true,
    runs: [
      { check: 'typecheck', exitCode: 0, output: '' },
      { check: 'lint', exitCode: 0, output: '' },
      { check: 'test', exitCode: 0, output: '' },
    ],
    logPath: '/tmp/ci.log',
    packageManager: 'npm',
  };
}

function ciRed(failedCheck: 'typecheck' | 'lint' | 'test' | 'install', output: string): CiGateResult {
  return {
    ok: false,
    failedCheck,
    runs: [
      { check: failedCheck, exitCode: 1, output },
    ],
    logPath: '/tmp/ci.log',
    packageManager: 'npm',
  };
}

describe('formatFixerComment', () => {
  it('reports CI-green attempt with commit count and log path', () => {
    const md = formatFixerComment({
      attempt: 1,
      maxAttempts: 2,
      fixer: fixerRun({ commits: 2, logFilePath: '/tmp/fixer-1.log' }),
      ciResult: ciGreen(),
    });
    expect(md).toContain('Fixer attempt 1 of 2');
    expect(md).toContain('CI green');
    expect(md).toContain('Fixer committed 2 new commit(s).');
    expect(md).toContain('`/tmp/fixer-1.log`');
  });

  it('reports CI-red attempt with the failing-check excerpt', () => {
    const md = formatFixerComment({
      attempt: 2,
      maxAttempts: 2,
      fixer: fixerRun({ commits: 1, logFilePath: '/tmp/fixer-2.log' }),
      ciResult: ciRed('typecheck', 'src/foo.ts:12 — TS2307: Cannot find module'),
    });
    expect(md).toContain('Fixer attempt 2 of 2');
    expect(md).toContain('CI red');
    expect(md).toContain('CI still red');
    expect(md).toContain('npm typecheck');
    expect(md).toContain('TS2307');
  });

  it('flags a fixer run that errored before producing commits', () => {
    const md = formatFixerComment({
      attempt: 1,
      maxAttempts: 2,
      fixer: fixerRun({ commits: 0, runError: 'sandcastle throw: idle timeout' }),
      ciResult: ciRed('test', 'expect 1 === 2'),
    });
    expect(md).toContain('Fixer run errored: sandcastle throw: idle timeout');
    expect(md).toContain('Fixer produced no new commits.');
  });
});

describe('formatFixerSection', () => {
  it('returns an empty string when no attempts ran', () => {
    expect(formatFixerSection([])).toBe('');
  });

  it('renders a per-attempt summary block describing the outcomes', () => {
    const attempts: FixerAttempt[] = [
      { attempt: 1, logFilePath: '/tmp/1.log', hadCommits: true, ciPassed: false, runError: undefined },
      { attempt: 2, logFilePath: '/tmp/2.log', hadCommits: true, ciPassed: true, runError: undefined },
    ];
    const md = formatFixerSection(attempts);
    expect(md).toMatch(/^\*\*Fixer:\*\* 2 attempt\(s\)/);
    expect(md).toContain('Attempt 1: committed a fix → CI still red');
    expect(md).toContain('Attempt 2: committed a fix → CI green');
  });

  it('describes the no-commits-still-red case', () => {
    const attempts: FixerAttempt[] = [
      { attempt: 1, logFilePath: undefined, hadCommits: false, ciPassed: false, runError: undefined },
    ];
    expect(formatFixerSection(attempts)).toContain('Attempt 1: no commits → CI still red');
  });

  it('surfaces an errored attempt at the top of the list', () => {
    const attempts: FixerAttempt[] = [
      { attempt: 1, logFilePath: undefined, hadCommits: false, ciPassed: false, runError: 'wall-clock timeout' },
    ];
    expect(formatFixerSection(attempts)).toContain('Attempt 1: errored — wall-clock timeout');
  });
});
