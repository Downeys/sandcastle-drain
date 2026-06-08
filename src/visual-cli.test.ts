import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultOutDir,
  loadVisualCliConfig,
  parseVisualFlags,
  runVisualCommand,
  VisualFlagsError,
} from './visual-cli.js';
import type { BrowserTypeLike } from './visual-engine/index.js';

// ---------------------------------------------------------------------------
// parseVisualFlags
// ---------------------------------------------------------------------------

describe('parseVisualFlags()', () => {
  it('parses --routes with comma-separated values', () => {
    const flags = parseVisualFlags(['--routes', '/,/about']);
    expect(flags.routes).toEqual(['/', '/about']);
  });

  it('parses --routes repeated', () => {
    const flags = parseVisualFlags(['--routes', '/', '--routes', '/about']);
    expect(flags.routes).toEqual(['/', '/about']);
  });

  it('parses --flag=value form', () => {
    const flags = parseVisualFlags(['--routes=/']);
    expect(flags.routes).toEqual(['/']);
  });

  it('parses --breakpoints and merges them in', () => {
    const flags = parseVisualFlags(['--routes', '/', '--breakpoints', '320,1024']);
    expect(flags.breakpoints).toEqual(['320', '1024']);
  });

  it('leaves breakpoints undefined when not supplied', () => {
    const flags = parseVisualFlags(['--routes', '/']);
    expect(flags.breakpoints).toBeUndefined();
  });

  it('parses --ceiling as a positive integer', () => {
    const flags = parseVisualFlags(['--routes', '/', '--ceiling', '5']);
    expect(flags.ceiling).toBe(5);
  });

  it('rejects --ceiling 0', () => {
    expect(() => parseVisualFlags(['--routes', '/', '--ceiling', '0'])).toThrow(
      /positive integer/,
    );
  });

  it('rejects an unknown flag', () => {
    expect(() => parseVisualFlags(['--routes', '/', '--bogus', 'x'])).toThrow(
      /Unknown visual flag/,
    );
  });

  it('requires --routes', () => {
    expect(() => parseVisualFlags(['--breakpoints', '375'])).toThrow(/--routes is required/);
  });

  it('rejects --flag with a missing value (next arg is a flag)', () => {
    expect(() => parseVisualFlags(['--routes', '--branch', 'main'])).toThrow(
      /expects a value/,
    );
  });

  it('captures --rubric, --preview-adapter, --branch, --out-dir', () => {
    const flags = parseVisualFlags([
      '--routes',
      '/',
      '--rubric',
      'rubric.md',
      '--preview-adapter',
      'preview.json',
      '--branch',
      'feature/x',
      '--out-dir',
      'captures',
    ]);
    expect(flags.rubricPath).toBe('rubric.md');
    expect(flags.previewAdapterPath).toBe('preview.json');
    expect(flags.branch).toBe('feature/x');
    expect(flags.outDir).toBe('captures');
  });
});

// ---------------------------------------------------------------------------
// loadVisualCliConfig
// ---------------------------------------------------------------------------

function makeTempProject(): {
  cwd: string;
  rubricPath: string;
  previewPath: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'visual-cli-cfg-'));
  mkdirSync(join(cwd, '.sandcastle-drain'), { recursive: true });
  const rubricPath = join(cwd, '.sandcastle-drain', 'visual-rubric.md');
  writeFileSync(rubricPath, 'be tasteful');
  const previewPath = join(cwd, '.sandcastle-drain', 'preview-adapter.json');
  writeFileSync(
    previewPath,
    JSON.stringify({
      startCommand: ['npm', 'run', 'preview'],
      readinessProbeUrl: 'http://localhost:4173/',
      breakpoints: ['375', '1440'],
    }),
  );
  return { cwd, rubricPath, previewPath };
}

describe('loadVisualCliConfig()', () => {
  it('loads rubric + preview-adapter from default canonical paths', () => {
    const { cwd } = makeTempProject();
    const result = loadVisualCliConfig({ routes: ['/'] }, cwd);
    expect(result.rubric).toBe('be tasteful');
    expect(result.previewAdapterOptions.startCommand).toEqual(['npm', 'run', 'preview']);
    expect(result.breakpoints).toEqual(['375', '1440']);
  });

  it('CLI --breakpoints flag wins over preview-adapter config breakpoints', () => {
    const { cwd } = makeTempProject();
    const result = loadVisualCliConfig({ routes: ['/'], breakpoints: ['320'] }, cwd);
    expect(result.breakpoints).toEqual(['320']);
  });

  it('falls back to engine default breakpoints when neither CLI nor config supplies them', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-cli-bp-'));
    mkdirSync(join(cwd, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(cwd, '.sandcastle-drain', 'visual-rubric.md'), 'r');
    writeFileSync(
      join(cwd, '.sandcastle-drain', 'preview-adapter.json'),
      JSON.stringify({
        startCommand: ['echo', 'x'],
        readinessProbeUrl: 'http://localhost:1/',
      }),
    );
    const result = loadVisualCliConfig({ routes: ['/'] }, cwd);
    expect(result.breakpoints).toEqual(['375', '768', '1440']);
  });

  it('respects an explicit --rubric path override', () => {
    const { cwd } = makeTempProject();
    const otherRubric = join(cwd, 'client-x-rubric.md');
    writeFileSync(otherRubric, 'CLIENT X rubric');
    const result = loadVisualCliConfig(
      { routes: ['/'], rubricPath: 'client-x-rubric.md' },
      cwd,
    );
    expect(result.rubric).toBe('CLIENT X rubric');
  });

  it('throws VisualFlagsError when the rubric is missing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-cli-missing-'));
    expect(() => loadVisualCliConfig({ routes: ['/'] }, cwd)).toThrow(VisualFlagsError);
  });

  it('throws when the preview-adapter JSON is malformed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-cli-badjson-'));
    mkdirSync(join(cwd, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(cwd, '.sandcastle-drain', 'visual-rubric.md'), 'r');
    writeFileSync(
      join(cwd, '.sandcastle-drain', 'preview-adapter.json'),
      '{ not json',
    );
    expect(() => loadVisualCliConfig({ routes: ['/'] }, cwd)).toThrow(/not valid JSON/);
  });

  it('throws when the preview-adapter config shape is invalid', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'visual-cli-badshape-'));
    mkdirSync(join(cwd, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(cwd, '.sandcastle-drain', 'visual-rubric.md'), 'r');
    writeFileSync(
      join(cwd, '.sandcastle-drain', 'preview-adapter.json'),
      JSON.stringify({ startCommand: [], readinessProbeUrl: 'http://x/' }),
    );
    expect(() => loadVisualCliConfig({ routes: ['/'] }, cwd)).toThrow(/rejected/);
  });
});

// ---------------------------------------------------------------------------
// defaultOutDir
// ---------------------------------------------------------------------------

describe('defaultOutDir()', () => {
  it('builds a per-invocation captures path that is filesystem-safe', () => {
    const dir = defaultOutDir('/repo', new Date('2026-06-08T10:00:00.000Z'));
    expect(dir).toBe('/repo/.sandcastle-drain/captures/visual-2026-06-08T10-00-00-000Z');
  });
});

// ---------------------------------------------------------------------------
// runVisualCommand — wiring (stage + branch + standalone all injected)
// ---------------------------------------------------------------------------

describe('runVisualCommand()', () => {
  it('forwards parsed routes/breakpoints/rubric/branch into the standalone wrapper and prints the report as JSON', async () => {
    const { cwd } = makeTempProject();
    let standaloneArgs:
      | Parameters<typeof import('./visual-engine/standalone.js').runVisualEngineStandalone>[0]
      | undefined;

    const writes: string[] = [];

    const report = await runVisualCommand(
      {
        flags: {
          routes: ['/', '/about'],
          breakpoints: ['375'],
          branch: 'feature/x',
        },
        cwd,
      },
      {
        stage: async () => {
          // The real stage() wipes + repopulates the staged dir; here we just
          // confirm it gets called by injecting a no-op stand-in.
        },
        loadBrowserType: async () =>
          ({
            async launch() {
              return {
                async newContext() {
                  return {
                    async newPage() {
                      return {
                        async goto() {
                          return null;
                        },
                        async screenshot() {
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
          }) satisfies BrowserTypeLike,
        // Fake out the engine altogether — we're testing the CLI wiring, not
        // the engine. Capture the args the command passed into it.
        runVisualEngineStandalone: async (args) => {
          standaloneArgs = args;
          return {
            verdict: 'pass',
            findings: [],
            iterations: 1,
            breakpointsCaptured: [...args.target.breakpoints],
            targetsCaptured: [...args.target.routes],
            diffSummary: '',
          };
        },
        createPreviewAdapter: () => ({
          async start() {
            return { baseUrl: 'http://localhost:0/' };
          },
          async rebuild() {},
          async stop() {},
        }),
        write: (line) => writes.push(line),
      },
    );

    expect(report.verdict).toBe('pass');
    expect(standaloneArgs?.target.routes).toEqual(['/', '/about']);
    expect(standaloneArgs?.target.breakpoints).toEqual(['375']);
    expect(standaloneArgs?.rubric).toBe('be tasteful');
    expect(standaloneArgs?.sandbox.branch).toBe('feature/x');

    // The report is printed as pretty JSON the caller can pipe through jq.
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual(report);
  });

  it('falls back to the current git branch when --branch is omitted', async () => {
    const { cwd } = makeTempProject();
    let usedBranch = '';
    await runVisualCommand(
      { flags: { routes: ['/'] }, cwd },
      {
        stage: async () => {},
        loadBrowserType: async () =>
          ({
            async launch() {
              return {
                async newContext() {
                  return {
                    async newPage() {
                      return {
                        async goto() {
                          return null;
                        },
                        async screenshot() {
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
          }) satisfies BrowserTypeLike,
        runVisualEngineStandalone: async (args) => {
          usedBranch = args.sandbox.branch;
          return {
            verdict: 'pass',
            findings: [],
            iterations: 1,
            breakpointsCaptured: [...args.target.breakpoints],
            targetsCaptured: [...args.target.routes],
            diffSummary: '',
          };
        },
        createPreviewAdapter: () => ({
          async start() {
            return { baseUrl: 'http://localhost:0/' };
          },
          async rebuild() {},
          async stop() {},
        }),
        resolveBranchDeps: {
          runCommand: async () => ({ exitCode: 0, stdout: 'agent/issue-45\n' }),
        },
        write: () => {},
      },
    );
    expect(usedBranch).toBe('agent/issue-45');
  });

  it('proves a consumer can inject a different rubric per invocation (per-client taste)', async () => {
    const { cwd } = makeTempProject();
    const clientRubric = join(cwd, 'client-y-rubric.md');
    writeFileSync(clientRubric, 'CLIENT Y: dense, mono-spaced typography');
    let seenRubric: unknown;

    await runVisualCommand(
      {
        flags: {
          routes: ['/'],
          rubricPath: 'client-y-rubric.md',
          branch: 'main',
        },
        cwd,
      },
      {
        stage: async () => {},
        loadBrowserType: async () =>
          ({
            async launch() {
              return {
                async newContext() {
                  return {
                    async newPage() {
                      return {
                        async goto() {
                          return null;
                        },
                        async screenshot() {
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
          }) satisfies BrowserTypeLike,
        runVisualEngineStandalone: async (args) => {
          seenRubric = args.rubric;
          return {
            verdict: 'pass',
            findings: [],
            iterations: 1,
            breakpointsCaptured: [...args.target.breakpoints],
            targetsCaptured: [...args.target.routes],
            diffSummary: '',
          };
        },
        createPreviewAdapter: () => ({
          async start() {
            return { baseUrl: 'http://localhost:0/' };
          },
          async rebuild() {},
          async stop() {},
        }),
        write: () => {},
      },
    );

    expect(seenRubric).toBe('CLIENT Y: dense, mono-spaced typography');
  });
});
