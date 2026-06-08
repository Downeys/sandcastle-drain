import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runVisualEngineStandalone } from './standalone.js';
import type {
  BrowserContextLike,
  BrowserLike,
  BrowserTypeLike,
  PageLike,
} from './capture.js';
import type { PreviewAdapter, Rubric } from './types.js';
import type { SandcastleRunFn as SlopCheckRunFn } from './slop-check.js';
import type { SandcastleRunFn as VisualEditorRunFn } from './visual-editor.js';

let TMP_HOST_CREDS = '';
let TMP_STAGED = '';

beforeAll(() => {
  TMP_HOST_CREDS = mkdtempSync(join(tmpdir(), 'standalone-creds-'));
  TMP_STAGED = mkdtempSync(join(tmpdir(), 'standalone-staged-'));
});

function fence(json: string): string {
  return '```json\n' + json + '\n```';
}

function makeWritingBrowser(): BrowserTypeLike {
  return {
    async launch(): Promise<BrowserLike> {
      return {
        async newContext(): Promise<BrowserContextLike> {
          return {
            async newPage(): Promise<PageLike> {
              return {
                async goto() {
                  return null;
                },
                async screenshot() {
                  // No file write — the slop-check critic is faked, so the
                  // file's contents are irrelevant. The capture seam is what
                  // returns the (route, breakpoint, pngPath) triple the engine
                  // forwards to the critic.
                  return null;
                },
                async close() {},
              };
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
}

function makePreviewAdapter(): PreviewAdapter & {
  readonly calls: { start: number; rebuild: number; stop: number };
} {
  const calls = { start: 0, rebuild: 0, stop: 0 };
  return {
    calls,
    async start() {
      calls.start += 1;
      return { baseUrl: 'http://localhost:9999' };
    },
    async rebuild() {
      calls.rebuild += 1;
    },
    async stop() {
      calls.stop += 1;
    },
  };
}

const FAKE_SANDCASTLE_RESULT = {
  iterations: [],
  completionSignal: '<promise>COMPLETE</promise>',
  branch: 'agent/issue-45',
  commits: [] as { sha: string }[],
  stdout: '',
  logFilePath: undefined,
};

function makeSandbox() {
  return {
    imageName: 'sandcastle:test',
    hostCredsPath: TMP_HOST_CREDS,
    sandboxCredsPath: '/home/agent/.claude',
    stagedHostPath: TMP_STAGED,
    branch: 'agent/issue-45',
  };
}

describe('runVisualEngineStandalone()', () => {
  it('wires Playwright capture + sandboxed critic + sandboxed editor and drives a pass on a no-findings run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'standalone-out-'));
    const previewAdapter = makePreviewAdapter();

    const fakeCriticRun: SlopCheckRunFn = async () => ({
      ...FAKE_SANDCASTLE_RESULT,
      stdout: fence(JSON.stringify({ findings: [] })),
    });
    let editorCalled = false;
    const fakeEditorRun: VisualEditorRunFn = async () => {
      editorCalled = true;
      return FAKE_SANDCASTLE_RESULT;
    };

    const report = await runVisualEngineStandalone(
      {
        target: { routes: ['/'], breakpoints: ['375'] },
        rubric: 'tasteful',
        previewAdapter,
        sandbox: makeSandbox(),
        screenshotsHostDir: outDir,
        browserType: makeWritingBrowser(),
      },
      {
        slopCheckDeps: { runSandcastleRun: fakeCriticRun },
        visualEditorDeps: { runSandcastleRun: fakeEditorRun },
      },
    );

    expect(report.verdict).toBe('pass');
    expect(report.iterations).toBe(1);
    expect(report.targetsCaptured).toEqual(['/']);
    expect(report.breakpointsCaptured).toEqual(['375']);
    expect(previewAdapter.calls).toEqual({ start: 1, rebuild: 0, stop: 1 });
    // A clean pass on the first iteration must not invoke the editor.
    expect(editorCalled).toBe(false);
  });

  it('forwards the rubric verbatim to the critic — proving per-consumer taste injection', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'standalone-rubric-'));
    let capturedPrompt = '';
    const rubric: Rubric = 'CLIENT-SPECIFIC: brutalist, sharp edges, no rounded corners';
    const fakeCriticRun: SlopCheckRunFn = async (options) => {
      capturedPrompt = (options.prompt as string) ?? '';
      return {
        ...FAKE_SANDCASTLE_RESULT,
        stdout: fence(JSON.stringify({ findings: [] })),
      };
    };

    await runVisualEngineStandalone(
      {
        target: { routes: ['/'], breakpoints: ['375'] },
        rubric,
        previewAdapter: makePreviewAdapter(),
        sandbox: makeSandbox(),
        screenshotsHostDir: outDir,
        browserType: makeWritingBrowser(),
      },
      {
        slopCheckDeps: { runSandcastleRun: fakeCriticRun },
        visualEditorDeps: {
          runSandcastleRun: async () => FAKE_SANDCASTLE_RESULT,
        },
      },
    );

    expect(capturedPrompt).toContain('brutalist');
    expect(capturedPrompt).toContain('no rounded corners');
  });

  it('iterates: critic finds → editor batched → rebuild → recapture, ceiling caps at supplied value', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'standalone-iter-'));
    const previewAdapter = makePreviewAdapter();
    let critiqueCalls = 0;
    let editorCalls = 0;

    // High-severity finding on every iteration → engine never passes; ceiling=2
    // means two critiques + one editor pass + one rebuild.
    const fakeCriticRun: SlopCheckRunFn = async () => {
      critiqueCalls += 1;
      return {
        ...FAKE_SANDCASTLE_RESULT,
        stdout: fence(
          JSON.stringify({
            findings: [
              {
                signal: 'CTA contrast too low',
                severity: 'high',
                breakpoint: '375',
                route: '/',
                suggestedFix: 'darken CTA',
              },
            ],
          }),
        ),
      };
    };
    const fakeEditorRun: VisualEditorRunFn = async () => {
      editorCalls += 1;
      return { ...FAKE_SANDCASTLE_RESULT, commits: [{ sha: 'abc1234' }] };
    };

    const report = await runVisualEngineStandalone(
      {
        target: { routes: ['/'], breakpoints: ['375'] },
        rubric: undefined,
        previewAdapter,
        sandbox: makeSandbox(),
        screenshotsHostDir: outDir,
        browserType: makeWritingBrowser(),
        ceiling: 2,
      },
      {
        slopCheckDeps: { runSandcastleRun: fakeCriticRun },
        visualEditorDeps: { runSandcastleRun: fakeEditorRun },
      },
    );

    expect(report.verdict).toBe('fail');
    expect(report.iterations).toBe(2);
    expect(critiqueCalls).toBe(2);
    expect(editorCalls).toBe(1);
    expect(previewAdapter.calls).toEqual({ start: 1, rebuild: 1, stop: 1 });
    expect(report.diffSummary).toContain('abc1234');
  });

  it('stops the preview adapter even when the critic throws (try/finally wiring intact)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'standalone-throw-'));
    const previewAdapter = makePreviewAdapter();

    const fakeCriticRun: SlopCheckRunFn = async () => ({
      ...FAKE_SANDCASTLE_RESULT,
      stdout: 'no fenced JSON — parse error → critic adapter throws',
    });

    await expect(
      runVisualEngineStandalone(
        {
          target: { routes: ['/'], breakpoints: ['375'] },
          rubric: undefined,
          previewAdapter,
          sandbox: makeSandbox(),
          screenshotsHostDir: outDir,
          browserType: makeWritingBrowser(),
        },
        {
          slopCheckDeps: { runSandcastleRun: fakeCriticRun },
          visualEditorDeps: {
            runSandcastleRun: async () => FAKE_SANDCASTLE_RESULT,
          },
        },
      ),
    ).rejects.toThrow(/Slop-Check/);

    expect(previewAdapter.calls.start).toBe(1);
    expect(previewAdapter.calls.stop).toBe(1);
  });

  it('writes one PNG per (route × breakpoint) into the configured outDir', async () => {
    // Use a browser fake that actually writes the file so we can assert the
    // capture seam's outDir was respected.
    const outDir = mkdtempSync(join(tmpdir(), 'standalone-pngs-'));
    const writingBrowser: BrowserTypeLike = {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  async goto() {
                    return null;
                  },
                  async screenshot({ path }) {
                    const { writeFile } = await import('node:fs/promises');
                    await writeFile(path, Buffer.from('PNG'));
                    return null;
                  },
                  async close() {},
                } satisfies PageLike;
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    };

    await runVisualEngineStandalone(
      {
        target: { routes: ['/', '/about'], breakpoints: ['375', '768'] },
        rubric: 'x',
        previewAdapter: makePreviewAdapter(),
        sandbox: makeSandbox(),
        screenshotsHostDir: outDir,
        browserType: writingBrowser,
      },
      {
        slopCheckDeps: {
          runSandcastleRun: async () => ({
            ...FAKE_SANDCASTLE_RESULT,
            stdout: fence(JSON.stringify({ findings: [] })),
          }),
        },
        visualEditorDeps: {
          runSandcastleRun: async () => FAKE_SANDCASTLE_RESULT,
        },
      },
    );

    const files = readdirSync(outDir).sort();
    expect(files).toEqual(
      ['about-375.png', 'about-768.png', 'root-375.png', 'root-768.png'].sort(),
    );
  });
});
