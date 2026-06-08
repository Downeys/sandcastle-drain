import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildScreenshotsBlock,
  createSlopCheckCritic,
  formatRubric,
  parseSlopCheckOutput,
  runSlopCheck,
  translateCapturePath,
  SLOP_CHECK_CAPTURES_SANDBOX_PATH,
  type SandcastleRunFn,
  type SlopCheckSandboxConfig,
} from './slop-check.js';
import type { Screenshot } from './types.js';

// ---------------------------------------------------------------------------
// parseSlopCheckOutput
// ---------------------------------------------------------------------------

function fence(json: string): string {
  return '```json\n' + json + '\n```';
}

describe('parseSlopCheckOutput()', () => {
  it('parses a well-formed verdict with one finding', () => {
    const stdout = `Some thinking...\n\n${fence(
      JSON.stringify({
        findings: [
          {
            signal: 'CTA contrast too low at mobile',
            severity: 'high',
            breakpoint: '375',
            route: '/',
            suggestedFix: 'Darken the CTA background.',
          },
        ],
      }),
    )}`;
    const result = parseSlopCheckOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toEqual({
      signal: 'CTA contrast too low at mobile',
      severity: 'high',
      breakpoint: '375',
      route: '/',
      suggestedFix: 'Darken the CTA background.',
    });
  });

  it('parses an empty findings array as a clean pass', () => {
    const stdout = fence(JSON.stringify({ findings: [] }));
    const result = parseSlopCheckOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual([]);
  });

  it('takes the LAST fenced block — so an inline example in the thinking does not poison the result', () => {
    const exampleBlock = fence(
      JSON.stringify({
        findings: [
          {
            signal: 'EXAMPLE — not real',
            severity: 'high',
            breakpoint: '999',
            route: '/example',
            suggestedFix: 'do not pick me up',
          },
        ],
      }),
    );
    const realBlock = fence(JSON.stringify({ findings: [] }));
    const stdout = `Here's the shape I'll emit:\n\n${exampleBlock}\n\nMy actual verdict:\n\n${realBlock}`;
    const result = parseSlopCheckOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual([]);
  });

  it('returns ok:false when no fenced JSON block is present', () => {
    const result = parseSlopCheckOutput('the critic forgot to emit a verdict');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/no fenced/);
  });

  it('returns ok:false when the JSON is syntactically invalid', () => {
    const result = parseSlopCheckOutput(fence('{ "findings": [ not-json ] }'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/JSON\.parse failed/);
  });

  it('returns ok:false when findings is not an array', () => {
    const result = parseSlopCheckOutput(fence(JSON.stringify({ findings: 'oops' })));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/findings must be an array/);
  });

  it('returns ok:false when a finding has an invalid severity', () => {
    const stdout = fence(
      JSON.stringify({
        findings: [
          {
            signal: 'x',
            severity: 'CRITICAL',
            breakpoint: '375',
            route: '/',
            suggestedFix: 'y',
          },
        ],
      }),
    );
    const result = parseSlopCheckOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/severity/);
  });

  it('returns ok:false when a finding is missing a required field', () => {
    const stdout = fence(
      JSON.stringify({
        findings: [
          {
            signal: 'x',
            severity: 'medium',
            breakpoint: '375',
            route: '/',
            // suggestedFix missing
          },
        ],
      }),
    );
    const result = parseSlopCheckOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/suggestedFix/);
  });
});

// ---------------------------------------------------------------------------
// translateCapturePath + buildScreenshotsBlock + formatRubric
// ---------------------------------------------------------------------------

describe('translateCapturePath()', () => {
  it('re-anchors a path under the host dir at the sandbox mount', () => {
    expect(translateCapturePath('/host/captures/root-375.png', '/host/captures')).toBe(
      `${SLOP_CHECK_CAPTURES_SANDBOX_PATH}/root-375.png`,
    );
  });

  it('handles a trailing slash on the host dir', () => {
    expect(translateCapturePath('/host/captures/a.png', '/host/captures/')).toBe(
      `${SLOP_CHECK_CAPTURES_SANDBOX_PATH}/a.png`,
    );
  });

  it('returns the host dir itself when the path equals the host dir', () => {
    expect(translateCapturePath('/host/captures', '/host/captures')).toBe(
      SLOP_CHECK_CAPTURES_SANDBOX_PATH,
    );
  });

  it('passes through a path that is outside the host dir', () => {
    expect(translateCapturePath('/elsewhere/a.png', '/host/captures')).toBe('/elsewhere/a.png');
  });

  it('does not match a sibling directory by prefix', () => {
    // `/host/captures-other/a.png` starts with `/host/captures` but is not
    // inside that directory — must not be re-anchored.
    expect(translateCapturePath('/host/captures-other/a.png', '/host/captures')).toBe(
      '/host/captures-other/a.png',
    );
  });
});

describe('buildScreenshotsBlock()', () => {
  it('translates each pngPath to the sandbox mount path and renders one markdown line per screenshot', () => {
    const screenshots: Screenshot[] = [
      { route: '/', breakpoint: '375', pngPath: '/host/captures/root-375.png' },
      { route: '/about', breakpoint: '1440', pngPath: '/host/captures/about-1440.png' },
    ];
    const block = buildScreenshotsBlock(screenshots, '/host/captures');
    expect(block).toContain('route `/` × breakpoint `375`');
    expect(block).toContain(`${SLOP_CHECK_CAPTURES_SANDBOX_PATH}/root-375.png`);
    expect(block).toContain(`${SLOP_CHECK_CAPTURES_SANDBOX_PATH}/about-1440.png`);
    expect(block).not.toContain('/host/captures');
  });

  it('renders a "no captures" placeholder for an empty list', () => {
    expect(buildScreenshotsBlock([], '/host/captures')).toContain('no screenshots');
  });
});

describe('formatRubric()', () => {
  it('returns a string rubric unchanged', () => {
    expect(formatRubric('be tasteful')).toBe('be tasteful');
  });

  it('JSON-stringifies a structured rubric', () => {
    expect(formatRubric({ tone: 'serious', mustHave: ['contrast'] })).toContain('"tone": "serious"');
  });

  it('renders a placeholder when no rubric is supplied', () => {
    expect(formatRubric(undefined)).toContain('no rubric');
    expect(formatRubric(null)).toContain('no rubric');
  });
});

// ---------------------------------------------------------------------------
// runSlopCheck + createSlopCheckCritic wiring (sandcastle.run injected)
// ---------------------------------------------------------------------------

// docker() resolves and stat-checks every mount hostPath at construction
// time, so the test config uses real temp dirs the OS confirms exist. The
// fake `runSandcastleRun` short-circuits before sandcastle would do anything
// with them — but the validation happens before our seam fires.
let TMP_HOST_CREDS = '';
let TMP_STAGED = '';
let TMP_CAPTURES = '';

beforeAll(() => {
  TMP_HOST_CREDS = mkdtempSync(join(tmpdir(), 'slop-check-creds-'));
  TMP_STAGED = mkdtempSync(join(tmpdir(), 'slop-check-staged-'));
  TMP_CAPTURES = mkdtempSync(join(tmpdir(), 'slop-check-caps-'));
});

afterAll(() => {
  // mkdtemp dirs are tiny and OSes reap /tmp anyway.
});

function makeConfig(overrides: Partial<SlopCheckSandboxConfig> = {}): SlopCheckSandboxConfig {
  return {
    imageName: 'sandcastle:test',
    hostCredsPath: TMP_HOST_CREDS,
    sandboxCredsPath: '/home/agent/.claude',
    stagedHostPath: TMP_STAGED,
    branch: 'agent/issue-40',
    screenshotsHostDir: TMP_CAPTURES,
    idleTimeoutSeconds: 600,
    wallClockTimeoutMs: 600_000,
    ...overrides,
  };
}

const FAKE_RUN_RESULT = {
  iterations: [],
  completionSignal: '<promise>COMPLETE</promise>',
  branch: 'agent/issue-40',
  commits: [],
  stdout: '',
  logFilePath: undefined,
};

describe('runSlopCheck()', () => {
  it('is invokable standalone — given PNGs + rubric, returns parsed Finding[]', async () => {
    const findings = [
      {
        signal: 'Below-the-fold CTA hidden',
        severity: 'medium' as const,
        breakpoint: '375',
        route: '/',
        suggestedFix: 'Move the CTA above the fold.',
      },
    ];
    const fakeRun: SandcastleRunFn = async () => ({
      ...FAKE_RUN_RESULT,
      stdout: fence(JSON.stringify({ findings })),
    });

    const result = await runSlopCheck(
      {
        ...makeConfig(),
        screenshots: [
          { route: '/', breakpoint: '375', pngPath: join(TMP_CAPTURES, 'root-375.png') },
        ],
        rubric: 'tasteful, accessible',
      },
      { runSandcastleRun: fakeRun },
    );

    expect(result.parseError).toBeUndefined();
    expect(result.findings).toEqual(findings);
  });

  it('renders the prompt with the sandbox-translated screenshot path and the rubric', async () => {
    let capturedPrompt = '';
    const fakeRun: SandcastleRunFn = async (options) => {
      capturedPrompt = (options.prompt as string) ?? '';
      return { ...FAKE_RUN_RESULT, stdout: fence(JSON.stringify({ findings: [] })) };
    };
    await runSlopCheck(
      {
        ...makeConfig(),
        screenshots: [
          { route: '/', breakpoint: '375', pngPath: join(TMP_CAPTURES, 'root-375.png') },
        ],
        rubric: 'no slop',
      },
      { runSandcastleRun: fakeRun },
    );

    expect(capturedPrompt).toContain('Slop-Check');
    expect(capturedPrompt).toContain('no slop');
    expect(capturedPrompt).toContain(`${SLOP_CHECK_CAPTURES_SANDBOX_PATH}/root-375.png`);
    // The host path must not leak into the prompt — the critic only knows the
    // sandbox mount path.
    expect(capturedPrompt).not.toContain(TMP_CAPTURES);
  });

  it('configures sandcastle.run with a read-only captures mount, the right branch, and no install hook', async () => {
    let captured: Parameters<SandcastleRunFn>[0] | undefined;
    const fakeRun: SandcastleRunFn = async (options) => {
      captured = options;
      return { ...FAKE_RUN_RESULT, stdout: fence(JSON.stringify({ findings: [] })) };
    };

    const cfg = makeConfig();
    await runSlopCheck(
      { ...cfg, screenshots: [], rubric: undefined },
      { runSandcastleRun: fakeRun },
    );

    expect(captured).toBeDefined();
    // No pre-agent install hook — mirrors reviewer.ts.
    expect(captured?.hooks).toBeUndefined();
    expect(captured?.branchStrategy).toEqual({ type: 'branch', branch: cfg.branch });
    expect(typeof captured?.prompt).toBe('string');
  });

  it('surfaces a parse error (without throwing) when the agent emits no JSON block', async () => {
    const fakeRun: SandcastleRunFn = async () => ({
      ...FAKE_RUN_RESULT,
      stdout: 'I forgot the JSON block sorry',
    });
    const result = await runSlopCheck(
      { ...makeConfig(), screenshots: [], rubric: undefined },
      { runSandcastleRun: fakeRun },
    );
    expect(result.findings).toBeUndefined();
    expect(result.parseError).toMatch(/no fenced/);
  });

  it('surfaces a parse error when the sandcastle run throws', async () => {
    const fakeRun: SandcastleRunFn = async () => {
      throw new Error('docker exploded');
    };
    const result = await runSlopCheck(
      { ...makeConfig(), screenshots: [], rubric: undefined },
      { runSandcastleRun: fakeRun },
    );
    expect(result.findings).toBeUndefined();
    expect(result.parseError).toMatch(/docker exploded/);
  });
});

describe('createSlopCheckCritic()', () => {
  it('returns a CriticSeam that calls runSlopCheck with the per-iteration {screenshots, rubric}', async () => {
    let capturedPrompt = '';
    const fakeRun: SandcastleRunFn = async (options) => {
      capturedPrompt = (options.prompt as string) ?? '';
      return {
        ...FAKE_RUN_RESULT,
        stdout: fence(JSON.stringify({ findings: [] })),
      };
    };
    const critic = createSlopCheckCritic(makeConfig(), { runSandcastleRun: fakeRun });

    const findings = await critic.critique({
      screenshots: [
        { route: '/', breakpoint: '375', pngPath: join(TMP_CAPTURES, 'root-375.png') },
      ],
      rubric: 'no slop',
    });

    expect(findings).toEqual([]);
    expect(capturedPrompt).toContain('no slop');
    expect(capturedPrompt).toContain(`${SLOP_CHECK_CAPTURES_SANDBOX_PATH}/root-375.png`);
  });

  it('throws (does not silently drop) when the critic emits malformed output', async () => {
    const fakeRun: SandcastleRunFn = async () => ({
      ...FAKE_RUN_RESULT,
      stdout: 'no json here',
    });
    const critic = createSlopCheckCritic(makeConfig(), { runSandcastleRun: fakeRun });

    await expect(
      critic.critique({ screenshots: [], rubric: undefined }),
    ).rejects.toThrow(/no fenced|no parseable/);
  });
});
