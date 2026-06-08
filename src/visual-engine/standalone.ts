/**
 * Standalone entry point — thin wrapper over `runVisualEngine` that wires the
 * drain's production seams (Playwright capture + sandboxed Slop-Check critic +
 * sandboxed visual editor) so a consumer outside the drain can run the same
 * loop with just `{ target, rubric, previewAdapter, sandbox, ... }`.
 *
 * Per the parent PRD (#36) and ADRs 0003 / 0005: this package owns the engine,
 * the consumer owns taste (rubric) and serve (preview adapter). website-midwife
 * is the canonical other consumer — it injects a per-client rubric and its own
 * preview adapter, then runs the same iteration loop in its HITL pre-draft
 * flow. The drain itself still uses the lower-level `runVisualEngine` directly
 * because it has extra issue-context concerns (target degradation, comment
 * formatting, skip-reason surfacing) that don't belong in a generic wrapper.
 *
 * The wrapper is deliberately shallow — it builds the three production seams
 * from the supplied sandbox config and delegates. It does not load config
 * files, parse CLI args, or own any defaulting beyond what the underlying
 * factories already provide. Higher-level orchestration (config loading,
 * issue-body parsing, CLI arg coercion) belongs in the caller.
 */
import {
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
} from './standalone-defaults.js';
import { createPlaywrightCapture, type BrowserTypeLike } from './capture.js';
import { runVisualEngine } from './engine.js';
import { createSlopCheckCritic, type RunSlopCheckDeps } from './slop-check.js';
import type {
  IterationReport,
  PreviewAdapter,
  Rubric,
  Target,
  VerdictPolicy,
} from './types.js';
import { createVisualEditor, type RunVisualEditorDeps } from './visual-editor.js';

/**
 * Sandbox + branch context the sandboxed critic and editor need to run. Mirrors
 * the shape `runVisualEngineStep` builds for the drain, lifted out so any
 * consumer can supply their own (different image name, different worktree
 * mount points, different branch).
 */
export interface VisualEngineStandaloneSandbox {
  readonly imageName: string;
  readonly hostCredsPath: string;
  readonly sandboxCredsPath: string;
  readonly stagedHostPath: string;
  /** Branch the editor commits to and the critic checks out. */
  readonly branch: string;
}

export interface RunVisualEngineStandaloneArgs {
  readonly target: Target;
  readonly rubric: Rubric;
  readonly previewAdapter: PreviewAdapter;
  readonly sandbox: VisualEngineStandaloneSandbox;
  /**
   * Host directory the Playwright capture writes PNGs into and the Slop-Check
   * critic mounts read-only. Created if missing by the capture seam.
   */
  readonly screenshotsHostDir: string;
  /**
   * Browser launcher (e.g. `chromium` from `playwright`). Injected to keep
   * `playwright` out of this package's hard import graph — the CLI dynamic-
   * imports it; a programmatic caller can pass `chromium`, `firefox`, or a
   * test fake. See `capture.ts` for the minimal interface.
   */
  readonly browserType: BrowserTypeLike;
  /** Forwards to `createSlopCheckCritic` and `createVisualEditor`. */
  readonly idleTimeoutSeconds?: number;
  /** Forwards to `createSlopCheckCritic` and `createVisualEditor`. */
  readonly wallClockTimeoutMs?: number;
  /** Optional log paths for post-mortem; mirrors the drain's per-issue paths. */
  readonly slopCheckLogPath?: string;
  readonly visualEditorLogPath?: string;
  /** Forwards to `runVisualEngine`. */
  readonly ceiling?: number;
  /** Forwards to `runVisualEngine`. */
  readonly policy?: VerdictPolicy;
}

/**
 * Dependency seams letting tests inject fake `sandcastle.run()` calls into the
 * critic + editor so the wiring is exercisable without Docker. Production
 * callers omit both.
 */
export interface RunVisualEngineStandaloneDeps {
  readonly slopCheckDeps?: RunSlopCheckDeps;
  readonly visualEditorDeps?: RunVisualEditorDeps;
}

/**
 * Builds the production trio of seams (Playwright capture, sandboxed Slop-
 * Check critic, sandboxed visual editor) from the supplied sandbox + capture
 * configuration and delegates to `runVisualEngine`. Returns the engine's
 * `IterationReport` unchanged.
 */
export async function runVisualEngineStandalone(
  args: RunVisualEngineStandaloneArgs,
  deps: RunVisualEngineStandaloneDeps = {},
): Promise<IterationReport> {
  const idleTimeoutSeconds =
    args.idleTimeoutSeconds ?? DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS;
  const wallClockTimeoutMs =
    args.wallClockTimeoutMs ?? DEFAULT_SUBAGENT_WALL_CLOCK_TIMEOUT_MS;

  const capture = createPlaywrightCapture({
    outDir: args.screenshotsHostDir,
    browserType: args.browserType,
  });

  const critic = createSlopCheckCritic(
    {
      imageName: args.sandbox.imageName,
      hostCredsPath: args.sandbox.hostCredsPath,
      sandboxCredsPath: args.sandbox.sandboxCredsPath,
      stagedHostPath: args.sandbox.stagedHostPath,
      branch: args.sandbox.branch,
      screenshotsHostDir: args.screenshotsHostDir,
      slopCheckLogPath: args.slopCheckLogPath,
      idleTimeoutSeconds,
      wallClockTimeoutMs,
    },
    deps.slopCheckDeps ?? {},
  );

  const editor = createVisualEditor(
    {
      imageName: args.sandbox.imageName,
      hostCredsPath: args.sandbox.hostCredsPath,
      sandboxCredsPath: args.sandbox.sandboxCredsPath,
      stagedHostPath: args.sandbox.stagedHostPath,
      branch: args.sandbox.branch,
      visualEditorLogPath: args.visualEditorLogPath,
      idleTimeoutSeconds,
      wallClockTimeoutMs,
    },
    deps.visualEditorDeps ?? {},
  );

  return runVisualEngine({
    target: args.target,
    rubric: args.rubric,
    previewAdapter: args.previewAdapter,
    capture,
    critic,
    editor,
    ceiling: args.ceiling,
    policy: args.policy,
  });
}
