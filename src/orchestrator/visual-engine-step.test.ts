import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE,
  resetRubricFlagsCache,
  VISUAL_RUBRIC_PATH_RELATIVE,
} from '../stage.js';
import {
  buildTargetFromIssue,
  coercePreviewAdapterConfig,
  deriveVisualOutcome,
  formatVisualEngineComment,
  formatVisualEngineErrorComment,
  shouldRunVisualEngine,
  UI_LABEL,
} from './visual-engine-step.js';
import type { RunVisualEngineStepResult } from './visual-engine-step.js';
import { DEFAULT_BREAKPOINTS } from '../visual-engine/index.js';
import type { IterationReport } from '../visual-engine/index.js';

let host: string;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), 'visual-engine-step-test-'));
  resetRubricFlagsCache();
});

afterEach(() => {
  rmSync(host, { recursive: true, force: true });
});

function writeVisualConfig(opts: { rubric?: string; previewAdapter?: string } = {}): void {
  mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
  writeFileSync(
    join(host, VISUAL_RUBRIC_PATH_RELATIVE),
    opts.rubric ?? '# Rubric\n\nNo slop.\n',
  );
  writeFileSync(
    join(host, PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE),
    opts.previewAdapter ??
      '{"startCommand":["npm","run","preview"],"readinessProbeUrl":"http://localhost:4173/"}',
  );
}

describe('shouldRunVisualEngine', () => {
  it('returns false when the issue lacks the ui label, even if project is visually configured', () => {
    writeVisualConfig();
    expect(shouldRunVisualEngine({ labels: ['enhancement'], body: '' }, host)).toBe(false);
  });

  it('returns false when the project is not visually configured, even with ui label', () => {
    // No rubric / preview-adapter written.
    expect(shouldRunVisualEngine({ labels: [UI_LABEL], body: '' }, host)).toBe(false);
  });

  it('returns true when ui label is present AND project has rubric + preview-adapter config', () => {
    writeVisualConfig();
    expect(shouldRunVisualEngine({ labels: [UI_LABEL, 'sandcastle'], body: '' }, host)).toBe(
      true,
    );
  });
});

describe('buildTargetFromIssue', () => {
  it('returns parsed routes + default breakpoints when no override is given', () => {
    const body = '## Visual targets\n\n- /dashboard\n- /settings\n';
    const result = buildTargetFromIssue({ body });
    expect(result.target.routes).toEqual(['/dashboard', '/settings']);
    expect(result.target.breakpoints).toEqual(DEFAULT_BREAKPOINTS);
    expect(result.degradedRoutes).toBe(false);
  });

  it('degrades a missing `## Visual targets` section to `/` and flags it', () => {
    const body = 'some body without the section';
    const result = buildTargetFromIssue({ body });
    expect(result.target.routes).toEqual(['/']);
    expect(result.degradedRoutes).toBe(true);
  });

  it('respects host-supplied breakpoints when present and non-empty', () => {
    const body = '## Visual targets\n\n- /\n';
    const result = buildTargetFromIssue({ body, breakpoints: ['320', '1024'] });
    expect(result.target.breakpoints).toEqual(['320', '1024']);
  });

  it('falls back to defaults when host supplies an empty breakpoints array', () => {
    const body = '## Visual targets\n\n- /\n';
    const result = buildTargetFromIssue({ body, breakpoints: [] });
    expect(result.target.breakpoints).toEqual(DEFAULT_BREAKPOINTS);
  });
});

describe('coercePreviewAdapterConfig', () => {
  it('rejects a non-object', () => {
    expect(coercePreviewAdapterConfig('npm run preview').ok).toBe(false);
    expect(coercePreviewAdapterConfig(null).ok).toBe(false);
    expect(coercePreviewAdapterConfig([]).ok).toBe(false);
  });

  it('rejects when startCommand is missing or not a string array', () => {
    expect(
      coercePreviewAdapterConfig({ readinessProbeUrl: 'http://localhost:4173/' }).ok,
    ).toBe(false);
    expect(
      coercePreviewAdapterConfig({
        startCommand: [],
        readinessProbeUrl: 'http://localhost:4173/',
      }).ok,
    ).toBe(false);
    expect(
      coercePreviewAdapterConfig({
        startCommand: ['npm', 1],
        readinessProbeUrl: 'http://localhost:4173/',
      }).ok,
    ).toBe(false);
  });

  it('rejects when readinessProbeUrl is missing or empty', () => {
    expect(coercePreviewAdapterConfig({ startCommand: ['npm', 'start'] }).ok).toBe(false);
    expect(
      coercePreviewAdapterConfig({
        startCommand: ['npm', 'start'],
        readinessProbeUrl: '',
      }).ok,
    ).toBe(false);
  });

  it('accepts the minimal valid shape and ignores unknown fields', () => {
    const result = coercePreviewAdapterConfig({
      startCommand: ['npm', 'run', 'preview'],
      readinessProbeUrl: 'http://localhost:4173/',
      unknown: 'ignored',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startCommand).toEqual(['npm', 'run', 'preview']);
    expect(result.value.readinessProbeUrl).toBe('http://localhost:4173/');
  });

  it('extracts optional baseUrl, rebuildCommand, timeouts, env when shapes match', () => {
    const result = coercePreviewAdapterConfig({
      startCommand: ['npm', 'run', 'preview'],
      readinessProbeUrl: 'http://localhost:4173/health',
      baseUrl: 'http://localhost:4173',
      rebuildCommand: ['npm', 'run', 'build'],
      readinessTimeoutMs: 90000,
      readinessIntervalMs: 500,
      env: { PORT: '4173', SKIPPED: 7 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseUrl).toBe('http://localhost:4173');
    expect(result.value.rebuildCommand).toEqual(['npm', 'run', 'build']);
    expect(result.value.readinessTimeoutMs).toBe(90000);
    expect(result.value.readinessIntervalMs).toBe(500);
    // Only string env values are forwarded.
    expect(result.value.env).toEqual({ PORT: '4173' });
  });

  it('exposes host-supplied breakpoints alongside the typed preview-adapter options', () => {
    const result = coercePreviewAdapterConfig({
      startCommand: ['npm', 'start'],
      readinessProbeUrl: 'http://localhost:4173/',
      breakpoints: ['320', '768'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.breakpoints).toEqual(['320', '768']);
  });
});

describe('formatVisualEngineComment', () => {
  function baseReport(overrides: Partial<IterationReport> = {}): IterationReport {
    return {
      verdict: 'pass',
      findings: [],
      iterations: 1,
      breakpointsCaptured: ['375', '768', '1440'],
      targetsCaptured: ['/'],
      diffSummary: '',
      ...overrides,
    };
  }

  it('marks a pass verdict and notes the merge gate allows shipping', () => {
    const comment = formatVisualEngineComment({
      report: baseReport({ verdict: 'pass' }),
      degradedRoutes: false,
    });
    expect(comment).toContain('Visual-Iteration Engine');
    expect(comment).toContain('pass');
    expect(comment).toContain('merge gate: pass');
  });

  it('marks a fail verdict, signals parked-at-needs-review, lists findings with severity badges + fixes', () => {
    const comment = formatVisualEngineComment({
      report: baseReport({
        verdict: 'fail',
        iterations: 3,
        findings: [
          {
            severity: 'high',
            signal: 'header logo overlaps nav',
            route: '/',
            breakpoint: '375',
            suggestedFix: 'add padding-top to <main>',
          },
          {
            severity: 'low',
            signal: 'footer link is a touch dim',
            route: '/',
            breakpoint: '1440',
            suggestedFix: 'bump contrast to 4.5:1',
          },
        ],
        diffSummary: 'editor committed 1 change(s)',
      }),
      degradedRoutes: false,
    });
    expect(comment).toContain('fail');
    expect(comment).toContain('3 iteration');
    // Fail-verdict hint signals the parked outcome — the editor's polish
    // stays on the branch, the issue routes to needs-review (not rejection).
    expect(comment).toContain('merge gate: fail');
    expect(comment).toContain('needs-review');
    expect(comment).toContain('branch preserved');
    expect(comment).toContain('header logo overlaps nav');
    expect(comment).toContain('footer link is a touch dim');
    expect(comment).toContain('add padding-top to <main>');
    expect(comment).toContain('editor committed 1 change(s)');
    expect(comment).toContain('high');
    expect(comment).toContain('low');
  });

  it('flags the `/`-degradation explicitly when the issue had no `## Visual targets`', () => {
    const comment = formatVisualEngineComment({
      report: baseReport(),
      degradedRoutes: true,
    });
    expect(comment).toContain('no `## Visual targets`');
    expect(comment).toContain('degraded to capturing `/`');
  });
});

describe('formatVisualEngineErrorComment', () => {
  it('renders the supplied reason verbatim under the skipped header', () => {
    const reason = 'failed to load Playwright (install playwright)';
    const comment = formatVisualEngineErrorComment(reason);
    expect(comment).toContain('skipped');
    expect(comment).toContain(reason);
  });
});

describe('deriveVisualOutcome', () => {
  function report(verdict: 'pass' | 'fail'): IterationReport {
    return {
      verdict,
      findings: [],
      iterations: 1,
      breakpointsCaptured: ['375'],
      targetsCaptured: ['/'],
      diffSummary: '',
    };
  }
  function result(over: Partial<RunVisualEngineStepResult> = {}): RunVisualEngineStepResult {
    return {
      report: undefined,
      skipped: false,
      degradedRoutes: false,
      ...over,
    };
  }

  it('returns `not-applicable` when the gate did not run the engine (result undefined)', () => {
    expect(deriveVisualOutcome(undefined)).toBe('not-applicable');
  });

  it('returns `pass` when the engine ran end-to-end with a pass verdict', () => {
    expect(deriveVisualOutcome(result({ report: report('pass') }))).toBe('pass');
  });

  it('returns `fail` when the engine ran end-to-end with a fail verdict (ceiling-fail)', () => {
    expect(deriveVisualOutcome(result({ report: report('fail') }))).toBe('fail');
  });

  it('returns `fail` when the engine was applicable but skipped (no report)', () => {
    // e.g. Playwright import failed, preview-adapter config rejected. We
    // can't verify visually — refuse to auto-merge — but never reject.
    expect(
      deriveVisualOutcome(result({ skipped: true, skipReason: 'playwright missing' })),
    ).toBe('fail');
  });

  it('returns `fail` when the engine threw inside its loop (no report)', () => {
    expect(deriveVisualOutcome(result({ runError: 'engine boom' }))).toBe('fail');
  });
});
