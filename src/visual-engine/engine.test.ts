import { describe, expect, it } from 'vitest';
import { runVisualEngine, DEFAULT_ITERATION_CEILING } from './engine.js';
import type {
  CaptureSeam,
  CriticSeam,
  EditorSeam,
  Finding,
  PreviewAdapter,
  Screenshot,
  Severity,
  Target,
} from './types.js';

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

function makeFinding(severity: Severity, signal: string, route = '/', breakpoint = '375'): Finding {
  return { signal, severity, route, breakpoint, suggestedFix: `fix ${signal}` };
}

function makePreviewAdapter(): PreviewAdapter & {
  readonly calls: { start: number; rebuild: number; stop: number };
} {
  const calls = { start: 0, rebuild: 0, stop: 0 };
  return {
    calls,
    async start() {
      calls.start += 1;
      return { baseUrl: 'http://localhost:4173' };
    },
    async rebuild() {
      calls.rebuild += 1;
    },
    async stop() {
      calls.stop += 1;
    },
  };
}

function makeCapture(target: Target): CaptureSeam & { readonly calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    async capture({ target: t }) {
      calls.count += 1;
      const screenshots: Screenshot[] = [];
      for (const route of t.routes) {
        for (const breakpoint of t.breakpoints) {
          screenshots.push({
            route,
            breakpoint,
            pngPath: `fixtures/${route.replace(/\//g, '_')}-${breakpoint}.png`,
          });
        }
      }
      // silence unused-var lint by referencing target in dev runs
      void target;
      return screenshots;
    },
  };
}

/**
 * Critic that returns a scripted sequence of findings — one entry per call. If
 * the script is shorter than the call count, the last entry repeats; if it's
 * exhausted with an empty array, subsequent calls return no findings.
 */
function makeScriptedCritic(
  script: readonly (readonly Finding[])[],
): CriticSeam & { readonly calls: { count: number; receivedRubrics: unknown[] } } {
  const state = { count: 0, receivedRubrics: [] as unknown[] };
  return {
    calls: state,
    async critique({ rubric }) {
      const index = Math.min(state.count, script.length - 1);
      state.count += 1;
      state.receivedRubrics.push(rubric);
      return script[index] ?? [];
    },
  };
}

function makeEditor(): EditorSeam & {
  readonly calls: { count: number; receivedBatches: (readonly Finding[])[] };
} {
  const state = { count: 0, receivedBatches: [] as (readonly Finding[])[] };
  return {
    calls: state,
    async edit({ findings }) {
      state.count += 1;
      state.receivedBatches.push(findings);
      return { diffSummary: `edit #${state.count} addressed ${findings.length} findings` };
    },
  };
}

const baseTarget: Target = {
  routes: ['/', '/about'],
  breakpoints: ['375', '768', '1440'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runVisualEngine — happy path', () => {
  it('returns pass on the first iteration when critic finds no issues', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([[]]);
    const editor = makeEditor();

    const report = await runVisualEngine({
      target: baseTarget,
      rubric: { kind: 'opaque-test-rubric' },
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(report.verdict).toBe('pass');
    expect(report.findings).toEqual([]);
    expect(report.iterations).toBe(1);
    expect(report.breakpointsCaptured).toEqual(['375', '768', '1440']);
    expect(report.targetsCaptured).toEqual(['/', '/about']);
    expect(report.diffSummary).toBe('');
    expect(editor.calls.count).toBe(0);
    expect(preview.calls.rebuild).toBe(0);
    expect(preview.calls.stop).toBe(1);
  });
});

describe('runVisualEngine — ceiling termination', () => {
  it('stops after the deterministic ceiling of 3 iterations when never passing', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    // Always returns one high-severity finding → verdict will always be fail.
    const critic = makeScriptedCritic([[makeFinding('high', 'always-bad')]]);
    const editor = makeEditor();

    const report = await runVisualEngine({
      target: baseTarget,
      rubric: undefined,
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(DEFAULT_ITERATION_CEILING).toBe(3);
    expect(report.iterations).toBe(3);
    expect(report.verdict).toBe('fail');
    expect(capture.calls.count).toBe(3);
    expect(critic.calls.count).toBe(3);
    // Editor runs once per iteration that fails-and-isn't-the-last
    // (last iteration's findings aren't acted on — there's no recapture after).
    expect(editor.calls.count).toBe(2);
    expect(preview.calls.rebuild).toBe(2);
    expect(preview.calls.stop).toBe(1);
    expect(report.diffSummary).toBe('edit #2 addressed 1 findings');
  });

  it('honours a custom ceiling', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([[makeFinding('high', 'bad')]]);
    const editor = makeEditor();

    const report = await runVisualEngine({
      target: baseTarget,
      rubric: null,
      previewAdapter: preview,
      capture,
      critic,
      editor,
      ceiling: 1,
    });

    expect(report.iterations).toBe(1);
    expect(capture.calls.count).toBe(1);
    expect(critic.calls.count).toBe(1);
    expect(editor.calls.count).toBe(0);
    expect(preview.calls.rebuild).toBe(0);
  });

  it('reaches pass mid-loop and short-circuits', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([
      [makeFinding('high', 'bad-1')],
      [makeFinding('high', 'bad-2')],
      [], // iteration 3: pass
      [makeFinding('high', 'should-not-run')],
    ]);
    const editor = makeEditor();

    const report = await runVisualEngine({
      target: baseTarget,
      rubric: { v: 1 },
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(report.verdict).toBe('pass');
    expect(report.iterations).toBe(3);
    expect(critic.calls.count).toBe(3);
    expect(editor.calls.count).toBe(2);
    expect(preview.calls.rebuild).toBe(2);
  });
});

describe('runVisualEngine — batched edits', () => {
  it('sends ALL findings from one iteration to the editor in a single call', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const iter1Findings = [
      makeFinding('high', 'a', '/', '375'),
      makeFinding('medium', 'b', '/', '768'),
      makeFinding('low', 'c', '/about', '1440'),
      makeFinding('high', 'd', '/about', '768'),
    ];
    const critic = makeScriptedCritic([iter1Findings, []]);
    const editor = makeEditor();

    await runVisualEngine({
      target: baseTarget,
      rubric: undefined,
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(editor.calls.count).toBe(1);
    expect(editor.calls.receivedBatches).toHaveLength(1);
    expect(editor.calls.receivedBatches[0]).toEqual(iter1Findings);
  });

  it('rebuilds exactly once per editor pass (one edit ↔ one rebuild)', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([
      [makeFinding('high', 'x')],
      [makeFinding('high', 'y')],
      [],
    ]);
    const editor = makeEditor();

    await runVisualEngine({
      target: baseTarget,
      rubric: undefined,
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(editor.calls.count).toBe(2);
    expect(preview.calls.rebuild).toBe(2);
  });
});

describe('runVisualEngine — verdict mapping wired in', () => {
  it('passes when only medium/low findings exist under the default policy', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([[makeFinding('medium', 'small'), makeFinding('low', 'tiny')]]);
    const editor = makeEditor();

    const report = await runVisualEngine({
      target: baseTarget,
      rubric: undefined,
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(report.verdict).toBe('pass');
    expect(report.iterations).toBe(1);
    expect(editor.calls.count).toBe(0);
  });

  it('fails when a tightened policy is exceeded', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([[makeFinding('medium', 'a'), makeFinding('medium', 'b')]]);
    const editor = makeEditor();

    const report = await runVisualEngine({
      target: baseTarget,
      rubric: undefined,
      previewAdapter: preview,
      capture,
      critic,
      editor,
      policy: { mediumMax: 1, lowMax: Number.POSITIVE_INFINITY },
      ceiling: 1,
    });

    expect(report.verdict).toBe('fail');
  });
});

describe('runVisualEngine — opaque rubric + preview adapter', () => {
  it('forwards the rubric to the critic verbatim (engine never interprets)', async () => {
    const preview = makePreviewAdapter();
    const capture = makeCapture(baseTarget);
    const critic = makeScriptedCritic([[]]);
    const editor = makeEditor();
    const sentinel = { deeply: { nested: 'value' }, list: [1, 2, 3] };

    await runVisualEngine({
      target: baseTarget,
      rubric: sentinel,
      previewAdapter: preview,
      capture,
      critic,
      editor,
    });

    expect(critic.calls.receivedRubrics[0]).toBe(sentinel);
  });

  it('always calls previewAdapter.stop, even when an inner seam throws', async () => {
    const preview = makePreviewAdapter();
    const capture: CaptureSeam = {
      async capture() {
        throw new Error('capture exploded');
      },
    };
    const critic = makeScriptedCritic([[]]);
    const editor = makeEditor();

    await expect(
      runVisualEngine({
        target: baseTarget,
        rubric: undefined,
        previewAdapter: preview,
        capture,
        critic,
        editor,
      }),
    ).rejects.toThrow('capture exploded');
    expect(preview.calls.start).toBe(1);
    expect(preview.calls.stop).toBe(1);
  });
});
