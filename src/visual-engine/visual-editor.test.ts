import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildFindingsBlock,
  createVisualEditor,
  runVisualEditor,
  type SandcastleRunFn,
  type VisualEditorSandboxConfig,
} from './visual-editor.js';
import type { Finding } from './types.js';

// ---------------------------------------------------------------------------
// buildFindingsBlock
// ---------------------------------------------------------------------------

describe('buildFindingsBlock()', () => {
  it('renders one entry per finding with route × breakpoint, severity, signal, and suggestedFix', () => {
    const findings: Finding[] = [
      {
        signal: 'CTA contrast too low at mobile',
        severity: 'high',
        breakpoint: '375',
        route: '/',
        suggestedFix: 'Darken the CTA background.',
      },
      {
        signal: 'Hero copy wraps awkwardly',
        severity: 'medium',
        breakpoint: '768',
        route: '/about',
        suggestedFix: 'Tighten the headline to one line at tablet.',
      },
    ];
    const block = buildFindingsBlock(findings);
    expect(block).toContain('route `/`');
    expect(block).toContain('breakpoint `375`');
    expect(block).toContain('high');
    expect(block).toContain('CTA contrast too low at mobile');
    expect(block).toContain('Darken the CTA background.');
    expect(block).toContain('route `/about`');
    expect(block).toContain('breakpoint `768`');
    expect(block).toContain('Hero copy wraps awkwardly');
    expect(block).toContain('Tighten the headline');
  });

  it('renders a placeholder for an empty findings list', () => {
    expect(buildFindingsBlock([])).toContain('no findings');
  });
});

// ---------------------------------------------------------------------------
// runVisualEditor + createVisualEditor wiring (sandcastle.run injected)
// ---------------------------------------------------------------------------

let TMP_HOST_CREDS = '';
let TMP_STAGED = '';

beforeAll(() => {
  TMP_HOST_CREDS = mkdtempSync(join(tmpdir(), 'visual-editor-creds-'));
  TMP_STAGED = mkdtempSync(join(tmpdir(), 'visual-editor-staged-'));
});

function makeConfig(
  overrides: Partial<VisualEditorSandboxConfig> = {},
): VisualEditorSandboxConfig {
  return {
    imageName: 'sandcastle:test',
    hostCredsPath: TMP_HOST_CREDS,
    sandboxCredsPath: '/home/agent/.claude',
    stagedHostPath: TMP_STAGED,
    branch: 'agent/issue-41',
    idleTimeoutSeconds: 600,
    wallClockTimeoutMs: 600_000,
    ...overrides,
  };
}

const FAKE_RUN_RESULT = {
  iterations: [],
  completionSignal: '<promise>COMPLETE</promise>',
  branch: 'agent/issue-41',
  commits: [] as { sha: string }[],
  stdout: '',
  logFilePath: undefined,
};

const SAMPLE_FINDING: Finding = {
  signal: 'CTA contrast too low at mobile',
  severity: 'high',
  breakpoint: '375',
  route: '/',
  suggestedFix: 'Darken the CTA background.',
};

describe('runVisualEditor()', () => {
  it('renders the prompt with the findings block and passes it to sandcastle.run', async () => {
    let capturedPrompt = '';
    const fakeRun: SandcastleRunFn = async (options) => {
      capturedPrompt = (options.prompt as string) ?? '';
      return { ...FAKE_RUN_RESULT, commits: [{ sha: 'abc1234567890' }] };
    };
    await runVisualEditor(
      { ...makeConfig(), findings: [SAMPLE_FINDING] },
      { runSandcastleRun: fakeRun },
    );

    expect(capturedPrompt).toContain('Visual editor');
    expect(capturedPrompt).toContain('CTA contrast too low at mobile');
    expect(capturedPrompt).toContain('high');
    expect(capturedPrompt).toContain('Darken the CTA background.');
  });

  it('configures sandcastle.run with the right branch and no install hook (worktree is RW by default)', async () => {
    let captured: Parameters<SandcastleRunFn>[0] | undefined;
    const fakeRun: SandcastleRunFn = async (options) => {
      captured = options;
      return { ...FAKE_RUN_RESULT };
    };

    const cfg = makeConfig();
    await runVisualEditor(
      { ...cfg, findings: [SAMPLE_FINDING] },
      { runSandcastleRun: fakeRun },
    );

    expect(captured).toBeDefined();
    // No pre-agent install hook — mirrors fixer.ts / slop-check.ts. The
    // worktree's existing install is reused in place.
    expect(captured?.hooks).toBeUndefined();
    expect(captured?.branchStrategy).toEqual({ type: 'branch', branch: cfg.branch });
    expect(typeof captured?.prompt).toBe('string');
    // The worktree mount sandcastle creates from branchStrategy is RW by
    // default. We deliberately do NOT add any extra mount that would shadow
    // it read-only. The docker(...) provider is opaque to introspection here;
    // the structural guarantee is in the runner source.
    expect(captured?.sandbox).toBeDefined();
  });

  it('returns a diffSummary mentioning the commits produced by the editor', async () => {
    const fakeRun: SandcastleRunFn = async () => ({
      ...FAKE_RUN_RESULT,
      commits: [{ sha: 'aaaaaaa0000000' }, { sha: 'bbbbbbb1111111' }],
    });
    const result = await runVisualEditor(
      { ...makeConfig(), findings: [SAMPLE_FINDING] },
      { runSandcastleRun: fakeRun },
    );
    expect(result.diffSummary).toMatch(/2/);
    expect(result.diffSummary).toContain('aaaaaaa');
    expect(result.diffSummary).toContain('bbbbbbb');
    expect(result.runError).toBeUndefined();
  });

  it('returns a diffSummary noting "no commits" when the editor produced nothing', async () => {
    const fakeRun: SandcastleRunFn = async () => ({ ...FAKE_RUN_RESULT, commits: [] });
    const result = await runVisualEditor(
      { ...makeConfig(), findings: [SAMPLE_FINDING] },
      { runSandcastleRun: fakeRun },
    );
    expect(result.diffSummary.toLowerCase()).toContain('no commits');
    expect(result.runError).toBeUndefined();
  });

  it('surfaces a runError (without throwing) when sandcastle.run throws', async () => {
    const fakeRun: SandcastleRunFn = async () => {
      throw new Error('docker exploded');
    };
    const result = await runVisualEditor(
      { ...makeConfig(), findings: [SAMPLE_FINDING] },
      { runSandcastleRun: fakeRun },
    );
    expect(result.runError).toMatch(/docker exploded/);
    expect(result.commits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createVisualEditor — EditorSeam adapter
// ---------------------------------------------------------------------------

describe('createVisualEditor()', () => {
  it('returns an EditorSeam that calls runVisualEditor with the iteration findings', async () => {
    let capturedPrompt = '';
    const fakeRun: SandcastleRunFn = async (options) => {
      capturedPrompt = (options.prompt as string) ?? '';
      return { ...FAKE_RUN_RESULT, commits: [{ sha: 'cafef00d12345678' }] };
    };
    const editor = createVisualEditor(makeConfig(), { runSandcastleRun: fakeRun });

    const result = await editor.edit({ findings: [SAMPLE_FINDING] });

    expect(capturedPrompt).toContain('CTA contrast too low at mobile');
    // shortSha truncates to 7 chars (`cafef00`), matching the convention used
    // for git short SHAs throughout the wrapper.
    expect(result.diffSummary).toContain('cafef00');
  });

  it('throws when the editor run errors so the engine surfaces the failure instead of looping', async () => {
    const fakeRun: SandcastleRunFn = async () => {
      throw new Error('container OOM');
    };
    const editor = createVisualEditor(makeConfig(), { runSandcastleRun: fakeRun });

    await expect(editor.edit({ findings: [SAMPLE_FINDING] })).rejects.toThrow(/container OOM/);
  });

  it('is invoked exactly once per iteration regardless of findings count — batching is enforced', async () => {
    let invocations = 0;
    const fakeRun: SandcastleRunFn = async () => {
      invocations += 1;
      return { ...FAKE_RUN_RESULT, commits: [{ sha: 'aaaaaaa1234' }] };
    };
    const editor = createVisualEditor(makeConfig(), { runSandcastleRun: fakeRun });

    await editor.edit({
      findings: [
        SAMPLE_FINDING,
        { ...SAMPLE_FINDING, signal: 'second finding' },
        { ...SAMPLE_FINDING, signal: 'third finding' },
      ],
    });

    expect(invocations).toBe(1);
  });
});
