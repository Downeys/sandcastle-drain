/**
 * Visual-Iteration Engine drain integration — gate, target derivation, and
 * orchestration helper that the drain loop invokes between the first
 * ci/fixer pass and the Code Reviewer.
 *
 * Per ADR 0004 the engine runs at:
 *
 *   implementer → ci → fixer → [Visual-Iteration Engine] → ci → fixer → reviewer
 *
 * It is invoked iff (a) the issue carries the `ui` label and (b) the project
 * has both a visual rubric and a preview-adapter config (see `stage.ts`'s
 * `isVisualEngineConfigured`). The `## Visual targets` section of the issue
 * body supplies route paths; a missing section degrades to capturing `/` and
 * is flagged in the report.
 *
 * Playwright is loaded lazily so projects that never opt into the visual
 * engine don't pay the install cost. When `import('playwright')` fails, the
 * step is reported skipped with a clear reason rather than crashing the run.
 *
 * This module owns gate + wiring decisions; the actual engine loop, capture,
 * critic and editor live under `src/visual-engine/`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_BREAKPOINTS,
  createPlaywrightCapture,
  createPreviewAdapter,
  createSlopCheckCritic,
  createVisualEditor,
  runVisualEngine,
} from '../visual-engine/index.js';
import type {
  BrowserTypeLike,
  CreatePreviewAdapterOptions,
  IterationReport,
  Severity,
  Target,
} from '../visual-engine/index.js';
import { isVisualEngineConfigured, loadVisualConfig } from '../stage.js';
import { parseVisualTargets } from './visual-targets.js';

export const UI_LABEL = 'ui';

// Sub-agent budgets — the editor and critic each run via `sandcastle.run()`
// like the fixer/reviewer; reuse the reviewer envelope (bounded scope, no
// install, no full build). The engine loop iterates up to its ceiling (3 by
// default), so the cumulative wall-clock cost on a worst-case `ui` issue is
// roughly ceiling × (editor + critic), per ADR 0005.
export const VISUAL_ENGINE_SUBAGENT_IDLE_TIMEOUT_SECONDS = 300;
export const VISUAL_ENGINE_SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface VisualEngineGateInput {
  readonly labels: readonly string[];
  readonly body: string;
}

/**
 * Per-issue gate. The wrapper invokes the engine iff this returns true:
 *
 *   1. Issue carries the `ui` label, AND
 *   2. Project has both a visual rubric file and a preview-adapter config.
 *
 * A `ui` issue with no `## Visual targets` section still passes the gate;
 * `buildTargetFromIssue` degrades it to capturing `/` (per ADR 0004).
 */
export function shouldRunVisualEngine(
  issue: VisualEngineGateInput,
  repoRoot: string,
): boolean {
  return issue.labels.includes(UI_LABEL) && isVisualEngineConfigured(repoRoot);
}

// ---------------------------------------------------------------------------
// Target derivation
// ---------------------------------------------------------------------------

export interface BuildTargetResult {
  readonly target: Target;
  readonly degradedRoutes: boolean;
}

/**
 * Builds the engine's `Target` from the issue body. Routes come from the
 * `## Visual targets` section; absence degrades to `['/']` and is flagged so
 * the report can call out the degradation. Breakpoints come from the host's
 * preview-adapter config when supplied, otherwise the engine's default trio.
 */
export function buildTargetFromIssue(args: {
  readonly body: string;
  readonly breakpoints?: readonly string[];
}): BuildTargetResult {
  const parsed = parseVisualTargets(args.body);
  const degradedRoutes = parsed.length === 0;
  const routes = degradedRoutes ? ['/'] : parsed;
  const breakpoints =
    args.breakpoints && args.breakpoints.length > 0 ? args.breakpoints : DEFAULT_BREAKPOINTS;
  return { target: { routes, breakpoints }, degradedRoutes };
}

// ---------------------------------------------------------------------------
// Preview-adapter config coercion
// ---------------------------------------------------------------------------

export type CoercePreviewAdapterResult =
  | {
      ok: true;
      value: CreatePreviewAdapterOptions;
      breakpoints?: readonly string[];
    }
  | { ok: false; reason: string };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Coerces the host's JSON-loaded preview-adapter config into the typed shape
 * `createPreviewAdapter` expects. Validation is intentionally narrow — only
 * the required fields are enforced; the rest pass through when present. A
 * shape mismatch is reported as `{ ok: false, reason }` so the drain can
 * surface "engine skipped: <why>" rather than crashing.
 */
export function coercePreviewAdapterConfig(raw: unknown): CoercePreviewAdapterResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'preview-adapter config must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (!isStringArray(o.startCommand) || o.startCommand.length === 0) {
    return {
      ok: false,
      reason: 'startCommand must be a non-empty array of strings',
    };
  }
  if (typeof o.readinessProbeUrl !== 'string' || o.readinessProbeUrl.length === 0) {
    return { ok: false, reason: 'readinessProbeUrl must be a non-empty string' };
  }

  const opts: {
    startCommand: readonly string[];
    readinessProbeUrl: string;
    baseUrl?: string;
    cwd?: string;
    env?: Record<string, string>;
    rebuildCommand?: readonly string[];
    readinessTimeoutMs?: number;
    readinessIntervalMs?: number;
  } = {
    startCommand: o.startCommand,
    readinessProbeUrl: o.readinessProbeUrl,
  };
  if (typeof o.baseUrl === 'string') opts.baseUrl = o.baseUrl;
  if (typeof o.cwd === 'string') opts.cwd = o.cwd;
  if (isStringArray(o.rebuildCommand) && o.rebuildCommand.length > 0) {
    opts.rebuildCommand = o.rebuildCommand;
  }
  if (typeof o.readinessTimeoutMs === 'number' && Number.isFinite(o.readinessTimeoutMs)) {
    opts.readinessTimeoutMs = o.readinessTimeoutMs;
  }
  if (typeof o.readinessIntervalMs === 'number' && Number.isFinite(o.readinessIntervalMs)) {
    opts.readinessIntervalMs = o.readinessIntervalMs;
  }
  if (o.env !== undefined && o.env !== null && typeof o.env === 'object' && !Array.isArray(o.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    opts.env = env;
  }

  const breakpoints = isStringArray(o.breakpoints) ? o.breakpoints : undefined;
  return { ok: true, value: opts, breakpoints };
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function severityBadge(s: Severity): string {
  if (s === 'high') return '🔴 high';
  if (s === 'medium') return '🟡 medium';
  return '🔵 low';
}

/**
 * Renders the engine's `IterationReport` as a GitHub issue comment. The
 * verdict gates auto-merge per ADR 0004: `pass` lets the merge proceed
 * (alongside CI green + reviewer PASS); `fail` parks the issue at
 * `needs-review` with the editor's polish preserved. Visual fail never
 * drives the rejection / branch-discard flow.
 */
export function formatVisualEngineComment(args: {
  readonly report: IterationReport;
  readonly degradedRoutes: boolean;
}): string {
  const { report, degradedRoutes } = args;
  const verdictEmoji = report.verdict === 'pass' ? '✅' : '⚠️';
  const verdictHint =
    report.verdict === 'pass'
      ? '_(merge gate: pass)_'
      : '_(merge gate: fail — parked at `needs-review`, branch preserved)_';
  const lines: string[] = [];
  lines.push(
    `**Visual-Iteration Engine:** ${verdictEmoji} \`${report.verdict}\` after ${report.iterations} iteration(s) ${verdictHint}`,
  );
  lines.push('');
  if (degradedRoutes) {
    lines.push(
      '> ℹ️ Issue had no `## Visual targets` section — engine degraded to capturing `/`.',
    );
    lines.push('');
  }
  lines.push(
    `**Routes:** ${report.targetsCaptured.map((r) => '`' + r + '`').join(', ')}`,
  );
  lines.push(
    `**Breakpoints:** ${report.breakpointsCaptured.map((b) => '`' + b + '`').join(', ')}`,
  );
  if (report.diffSummary) {
    lines.push(`**Edits:** ${report.diffSummary}`);
  }
  if (report.findings.length > 0) {
    lines.push('');
    lines.push(`### Findings (${report.findings.length})`);
    lines.push('');
    for (const f of report.findings) {
      lines.push(
        `- **${severityBadge(f.severity)}** at \`${f.route}\` × \`${f.breakpoint}\` — ${f.signal}`,
      );
      lines.push(`  _Suggested fix:_ ${f.suggestedFix}`);
    }
  }
  return lines.join('\n').trimEnd();
}

/**
 * Renders the "engine was applicable but did not run" fallback comment.
 * Reasons: malformed preview-adapter config, Playwright import failure, or
 * an unexpected throw inside the engine loop.
 */
export function formatVisualEngineErrorComment(reason: string): string {
  return [
    '**Visual-Iteration Engine:** ⚠️ skipped',
    '',
    `Engine was applicable but did not run: ${reason}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Seam letting tests inject a fake browser loader so the wiring can be
 * exercised without a real Playwright install. Production callers omit this.
 */
export type BrowserTypeLoader = () => Promise<BrowserTypeLike>;

/**
 * Default loader: dynamic-import `playwright` and return its `chromium`. Kept
 * lazy so projects without UI work don't pay the install cost; the failure
 * mode (Playwright not installed) is surfaced as an engine-skip comment, not
 * a crashed run.
 */
async function defaultLoadChromium(): Promise<BrowserTypeLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pw = (await import('playwright' as any)) as { chromium: BrowserTypeLike };
  return pw.chromium;
}

export interface RunVisualEngineStepArgs {
  readonly issueNumber: number;
  readonly issueBody: string;
  readonly branch: string;
  readonly repoRoot: string;
  readonly imageName: string;
  readonly hostCredsPath: string;
  readonly sandboxCredsPath: string;
  readonly stagedHostPath: string;
  readonly idleTimeoutSeconds?: number;
  readonly wallClockTimeoutMs?: number;
  readonly loadBrowserType?: BrowserTypeLoader;
}

export interface RunVisualEngineStepResult {
  /** Set when the engine ran end-to-end and produced a report. */
  readonly report: IterationReport | undefined;
  /** True when the gate said go but a setup error short-circuited the run. */
  readonly skipped: boolean;
  /** Human-readable reason the engine was skipped (when `skipped === true`). */
  readonly skipReason?: string;
  /** True when the issue body had no `## Visual targets` section. */
  readonly degradedRoutes: boolean;
  /** True when the engine throw was caught at the loop boundary. */
  readonly runError?: string;
}

/**
 * Outcome of the visual gate as observed by the auto-merge decision per
 * ADR 0004.
 *   - `'not-applicable'`: the engine didn't run (no `ui` label, or the project
 *     has no rubric / preview-adapter config). Treated as N/A — does not block
 *     auto-merge.
 *   - `'pass'`: the engine ran end-to-end and produced a `pass` verdict.
 *   - `'fail'`: the engine produced a `fail` verdict OR was applicable but
 *     could not produce one (skipped or threw). Either way, auto-merge is
 *     blocked. Visual fail **never** drives `handleRejection` — the editor's
 *     commits stay on the branch and the issue parks at `needs-review`.
 */
export type VisualOutcome = 'not-applicable' | 'pass' | 'fail';

/**
 * Maps a completed visual engine step result to the gate's three-state
 * outcome. Callers pass `undefined` when the gate said don't-run (no `ui`
 * label / no visual config) and the engine never executed.
 *
 * A result without a `report` (Playwright import failure, engine throw,
 * preview-adapter config rejected) is treated as `'fail'` — we can't verify
 * the change visually, so we refuse to auto-merge. The drain still parks the
 * branch at `needs-review`; rejection is never invoked for a visual fail.
 */
export function deriveVisualOutcome(
  result: RunVisualEngineStepResult | undefined,
): VisualOutcome {
  if (result === undefined) return 'not-applicable';
  if (result.report !== undefined) {
    return result.report.verdict === 'pass' ? 'pass' : 'fail';
  }
  return 'fail';
}

/**
 * Drives one full Visual-Iteration Engine pass: loads config, parses targets,
 * wires preview adapter + Playwright capture + sandboxed critic + sandboxed
 * editor, and calls `runVisualEngine`. Returns the iteration report on
 * success; on a recoverable setup failure (bad config, missing Playwright,
 * thrown seam) returns `skipped` or `runError` so the caller can surface a
 * comment without aborting the drain.
 */
export async function runVisualEngineStep(
  args: RunVisualEngineStepArgs,
): Promise<RunVisualEngineStepResult> {
  const config = loadVisualConfig(args.repoRoot);
  if (config === null) {
    return {
      report: undefined,
      skipped: true,
      skipReason: 'visual config missing or invalid at engine invocation time',
      degradedRoutes: false,
    };
  }

  const coerced = coercePreviewAdapterConfig(config.previewAdapterConfig);
  if (!coerced.ok) {
    return {
      report: undefined,
      skipped: true,
      skipReason: `preview-adapter config rejected: ${coerced.reason}`,
      degradedRoutes: false,
    };
  }

  const { target, degradedRoutes } = buildTargetFromIssue({
    body: args.issueBody,
    breakpoints: coerced.breakpoints,
  });

  let browserType: BrowserTypeLike;
  try {
    browserType = await (args.loadBrowserType ?? defaultLoadChromium)();
  } catch (err) {
    return {
      report: undefined,
      skipped: true,
      skipReason: `failed to load Playwright (install \`playwright\` to enable the visual engine): ${(err as Error).message}`,
      degradedRoutes,
    };
  }

  const screenshotsHostDir = join(
    args.repoRoot,
    '.sandcastle-drain',
    'captures',
    `issue-${args.issueNumber}`,
  );
  await mkdir(screenshotsHostDir, { recursive: true });

  const idleTimeoutSeconds =
    args.idleTimeoutSeconds ?? VISUAL_ENGINE_SUBAGENT_IDLE_TIMEOUT_SECONDS;
  const wallClockTimeoutMs =
    args.wallClockTimeoutMs ?? VISUAL_ENGINE_SUBAGENT_WALL_CLOCK_TIMEOUT_MS;

  const previewAdapter = createPreviewAdapter(coerced.value);
  const capture = createPlaywrightCapture({ outDir: screenshotsHostDir, browserType });

  const critic = createSlopCheckCritic({
    imageName: args.imageName,
    hostCredsPath: args.hostCredsPath,
    sandboxCredsPath: args.sandboxCredsPath,
    stagedHostPath: args.stagedHostPath,
    branch: args.branch,
    screenshotsHostDir,
    slopCheckLogPath: join(
      args.repoRoot,
      '.sandcastle-drain',
      'logs',
      `issue-${args.issueNumber}-slop-check.log`,
    ),
    idleTimeoutSeconds,
    wallClockTimeoutMs,
  });

  const editor = createVisualEditor({
    imageName: args.imageName,
    hostCredsPath: args.hostCredsPath,
    sandboxCredsPath: args.sandboxCredsPath,
    stagedHostPath: args.stagedHostPath,
    branch: args.branch,
    visualEditorLogPath: join(
      args.repoRoot,
      '.sandcastle-drain',
      'logs',
      `issue-${args.issueNumber}-visual-editor.log`,
    ),
    idleTimeoutSeconds,
    wallClockTimeoutMs,
  });

  try {
    const report = await runVisualEngine({
      target,
      rubric: config.rubric,
      previewAdapter,
      capture,
      critic,
      editor,
    });
    return { report, skipped: false, degradedRoutes };
  } catch (err) {
    return {
      report: undefined,
      skipped: false,
      degradedRoutes,
      runError: err instanceof Error ? err.message : String(err),
    };
  }
}
