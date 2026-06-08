/**
 * `sandcastle-drain visual` subcommand — runs the Visual-Iteration Engine
 * loop outside the drain on the current worktree. This is the thin CLI
 * wrapper called for by issue #45: routes/rubric/preview-adapter come from
 * args/config rather than a GitHub issue body, and the iteration report is
 * printed to stdout so a script (e.g. website-midwife's HITL pre-draft flow)
 * can pipe it through `jq`.
 *
 * Mirrors the drain's execution shape: Playwright capture on the host +
 * sandboxed Slop-Check critic + sandboxed visual editor. The difference is
 * surface, not substance — `runDrain` orchestrates many issues against the
 * GitHub queue; this subcommand runs the loop once against a single set of
 * routes the caller supplied.
 *
 * Pure arg parsing + config loading live here; the actual sandbox wiring is
 * `runVisualEngineStandalone` from `src/visual-engine/standalone.ts`.
 */
import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_BREAKPOINTS,
  runVisualEngineStandalone,
  type BrowserTypeLike,
  type CreatePreviewAdapterOptions,
  type IterationReport,
} from './visual-engine/index.js';
import { createPreviewAdapter } from './visual-engine/index.js';
import { coercePreviewAdapterConfig } from './orchestrator/visual-engine-step.js';
import {
  HOST_CREDS_PATH,
  IMAGE_NAME,
  REPO_ROOT,
  SANDBOX_CREDS_PATH,
} from './orchestrator/prereqs.js';
import {
  PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE,
  STAGED_DIR_RELATIVE,
  VISUAL_RUBRIC_PATH_RELATIVE,
  stage,
} from './stage.js';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export interface VisualFlags {
  readonly routes: readonly string[];
  readonly breakpoints?: readonly string[];
  readonly rubricPath?: string;
  readonly previewAdapterPath?: string;
  readonly branch?: string;
  readonly outDir?: string;
  readonly ceiling?: number;
}

export class VisualFlagsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualFlagsError';
  }
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const KNOWN_FLAGS = [
  '--routes',
  '--breakpoints',
  '--rubric',
  '--preview-adapter',
  '--branch',
  '--out-dir',
  '--ceiling',
] as const;

type KnownFlag = (typeof KNOWN_FLAGS)[number];

function matchKnownFlag(arg: string): { name: KnownFlag; inlineValue: string | undefined } | null {
  for (const name of KNOWN_FLAGS) {
    if (arg === name) return { name, inlineValue: undefined };
    if (arg.startsWith(`${name}=`)) return { name, inlineValue: arg.slice(name.length + 1) };
  }
  return null;
}

/**
 * Parses `visual`-subcommand flags. Both `--flag value` and `--flag=value`
 * forms are accepted. `--routes` and `--breakpoints` may be repeated, and
 * each value may be comma-separated (so `--routes / --routes /about` and
 * `--routes /,/about` both work).
 *
 * Unknown flags raise `VisualFlagsError` so a typo doesn't silently get
 * ignored mid-run.
 */
export function parseVisualFlags(args: readonly string[]): VisualFlags {
  const routes: string[] = [];
  const breakpoints: string[] = [];
  let rubricPath: string | undefined;
  let previewAdapterPath: string | undefined;
  let branch: string | undefined;
  let outDir: string | undefined;
  let ceiling: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const match = matchKnownFlag(arg);
    if (!match) {
      throw new VisualFlagsError(`Unknown visual flag: ${arg}`);
    }
    let value = match.inlineValue;
    if (value === undefined) {
      value = args[i + 1];
      i += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      throw new VisualFlagsError(`${match.name} expects a value`);
    }
    switch (match.name) {
      case '--routes':
        routes.push(...splitList(value));
        break;
      case '--breakpoints':
        breakpoints.push(...splitList(value));
        break;
      case '--rubric':
        rubricPath = value;
        break;
      case '--preview-adapter':
        previewAdapterPath = value;
        break;
      case '--branch':
        branch = value;
        break;
      case '--out-dir':
        outDir = value;
        break;
      case '--ceiling': {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          throw new VisualFlagsError(
            `--ceiling expects a positive integer (got: ${value})`,
          );
        }
        ceiling = Number(value);
        break;
      }
    }
  }

  if (routes.length === 0) {
    throw new VisualFlagsError(
      '--routes is required (e.g. `sandcastle-drain visual --routes /,/about`)',
    );
  }

  return {
    routes,
    breakpoints: breakpoints.length > 0 ? breakpoints : undefined,
    rubricPath,
    previewAdapterPath,
    branch,
    outDir,
    ceiling,
  };
}

// ---------------------------------------------------------------------------
// Config + path resolution
// ---------------------------------------------------------------------------

function resolveUnder(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export interface ResolvedVisualConfig {
  readonly rubric: string;
  readonly previewAdapterOptions: CreatePreviewAdapterOptions;
  readonly breakpoints: readonly string[];
}

/**
 * Reads rubric + preview-adapter files from the caller's chosen paths
 * (or the canonical `.sandcastle-drain/` defaults), coerces the preview
 * adapter JSON, and merges breakpoints (explicit CLI flag wins over the
 * preview-adapter config's `breakpoints` field over the engine default trio).
 */
export function loadVisualCliConfig(
  flags: VisualFlags,
  cwd: string = REPO_ROOT,
): ResolvedVisualConfig {
  const rubricPath = resolveUnder(cwd, flags.rubricPath ?? VISUAL_RUBRIC_PATH_RELATIVE);
  if (!existsSync(rubricPath)) {
    throw new VisualFlagsError(`Rubric file not found at ${rubricPath}`);
  }
  const rubric = readFileSync(rubricPath, 'utf8');
  if (rubric.length === 0) {
    throw new VisualFlagsError(`Rubric file is empty at ${rubricPath}`);
  }

  const previewPath = resolveUnder(
    cwd,
    flags.previewAdapterPath ?? PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE,
  );
  if (!existsSync(previewPath)) {
    throw new VisualFlagsError(`Preview-adapter config not found at ${previewPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(previewPath, 'utf8'));
  } catch (err) {
    throw new VisualFlagsError(
      `Preview-adapter config at ${previewPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const coerced = coercePreviewAdapterConfig(parsed);
  if (!coerced.ok) {
    throw new VisualFlagsError(`Preview-adapter config rejected: ${coerced.reason}`);
  }

  // Precedence: CLI flag > preview-adapter config field > engine default.
  let breakpoints: readonly string[];
  if (flags.breakpoints && flags.breakpoints.length > 0) {
    breakpoints = flags.breakpoints;
  } else if (coerced.breakpoints && coerced.breakpoints.length > 0) {
    breakpoints = coerced.breakpoints;
  } else {
    breakpoints = DEFAULT_BREAKPOINTS;
  }

  return {
    rubric,
    previewAdapterOptions: coerced.value,
    breakpoints,
  };
}

// ---------------------------------------------------------------------------
// Current-branch helper (used when `--branch` is omitted)
// ---------------------------------------------------------------------------

export interface ResolveBranchDeps {
  readonly runCommand?: (cmd: string, args: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }>;
}

async function resolveBranch(
  flagsBranch: string | undefined,
  cwd: string,
  deps: ResolveBranchDeps = {},
): Promise<string> {
  if (flagsBranch !== undefined) return flagsBranch;
  const run =
    deps.runCommand ??
    (async (cmd, args) => {
      const r = await execa(cmd, [...args], { cwd, reject: false });
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
    });
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.exitCode !== 0 || r.stdout.trim().length === 0) {
    throw new VisualFlagsError(
      'Could not determine current git branch — pass --branch <name> explicitly',
    );
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// Default screenshots out-dir
// ---------------------------------------------------------------------------

export function defaultOutDir(cwd: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(cwd, '.sandcastle-drain', 'captures', `visual-${stamp}`);
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export type BrowserTypeLoader = () => Promise<BrowserTypeLike>;

async function defaultLoadChromium(): Promise<BrowserTypeLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pw = (await import('playwright' as any)) as { chromium: BrowserTypeLike };
  return pw.chromium;
}

export interface RunVisualCommandDeps {
  readonly loadBrowserType?: BrowserTypeLoader;
  readonly runVisualEngineStandalone?: typeof runVisualEngineStandalone;
  readonly stage?: typeof stage;
  readonly createPreviewAdapter?: typeof createPreviewAdapter;
  readonly resolveBranchDeps?: ResolveBranchDeps;
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
}

export interface RunVisualCommandArgs {
  readonly flags: VisualFlags;
  readonly cwd?: string;
}

/**
 * Runs one Visual-Iteration Engine pass on the current worktree against the
 * caller-supplied routes / rubric / preview-adapter, then prints the iteration
 * report as JSON. Returns the report so a programmatic caller (e.g. a test)
 * can assert directly.
 */
export async function runVisualCommand(
  args: RunVisualCommandArgs,
  deps: RunVisualCommandDeps = {},
): Promise<IterationReport> {
  const cwd = args.cwd ?? REPO_ROOT;
  const config = loadVisualCliConfig(args.flags, cwd);
  const branch = await resolveBranch(args.flags.branch, cwd, deps.resolveBranchDeps);

  // Stage library content so the sandboxed critic + editor can read the
  // principles from `STAGED_SANDBOX_PATH` (same setup the drain does once at
  // boot). A no-op if the CLI is rerun with the same cwd; cheap regardless.
  await (deps.stage ?? stage)(cwd);
  const stagedHostPath = join(cwd, STAGED_DIR_RELATIVE);

  const browserType = await (deps.loadBrowserType ?? defaultLoadChromium)();

  const outDir = args.flags.outDir
    ? resolveUnder(cwd, args.flags.outDir)
    : defaultOutDir(cwd, deps.now ? deps.now() : undefined);
  await mkdir(outDir, { recursive: true });

  const previewAdapter = (deps.createPreviewAdapter ?? createPreviewAdapter)(
    config.previewAdapterOptions,
  );

  const target = {
    routes: args.flags.routes,
    breakpoints: config.breakpoints,
  };

  const runner = deps.runVisualEngineStandalone ?? runVisualEngineStandalone;
  const report = await runner({
    target,
    rubric: config.rubric,
    previewAdapter,
    sandbox: {
      imageName: IMAGE_NAME,
      hostCredsPath: HOST_CREDS_PATH,
      sandboxCredsPath: SANDBOX_CREDS_PATH,
      stagedHostPath,
      branch,
    },
    screenshotsHostDir: outDir,
    browserType,
    ceiling: args.flags.ceiling,
  });

  const write = deps.write ?? ((line: string) => console.log(line));
  write(JSON.stringify(report, null, 2));
  return report;
}
