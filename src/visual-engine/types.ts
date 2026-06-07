/**
 * Public types for the Visual-Iteration Engine — the shared contract every
 * later slice and every consumer (autonomous drain, website-midwife) builds on.
 *
 * These shapes are deliberately small and stable:
 *
 *   - `Finding` and `IterationReport` are what hosts observe across the
 *     `runVisualEngine` boundary; their fields are nailed down per the PRD.
 *   - `Target`, `Rubric`, `PreviewAdapter` are what hosts inject. `Rubric` is
 *     opaque to the engine (a `unknown` newtype) — the engine never interprets
 *     it. `PreviewAdapter` is the narrow "boot, hand back a base URL, rebuild"
 *     contract from ADR 0005.
 *   - `CaptureSeam`, `CriticSeam`, `EditorSeam` are the mockable seams the
 *     walking skeleton exercises with fixtures. ADR 0003: the engine itself
 *     owns the production critic + editor; only taste and serve are the
 *     consumer's. The seams are still pulled into the public signature here
 *     so the loop runs end-to-end with fixture stand-ins before any real
 *     browser/sandbox exists.
 *   - `VerdictPolicy` is the configurable threshold for medium/low findings;
 *     zero high-severity is non-negotiable per the PRD.
 */

export type Severity = 'high' | 'medium' | 'low';

export type Verdict = 'pass' | 'fail';

export interface Finding {
  readonly signal: string;
  readonly severity: Severity;
  readonly breakpoint: string;
  readonly route: string;
  readonly suggestedFix: string;
}

export interface IterationReport {
  readonly verdict: Verdict;
  readonly findings: readonly Finding[];
  readonly iterations: number;
  readonly breakpointsCaptured: readonly string[];
  readonly targetsCaptured: readonly string[];
  readonly diffSummary: string;
}

/**
 * What to capture — routes × breakpoints. The engine takes one full-page
 * screenshot per pair per iteration (no scripted interaction states in v1,
 * per ADR 0004).
 */
export interface Target {
  readonly routes: readonly string[];
  readonly breakpoints: readonly string[];
}

/**
 * Opaque to the engine. The host owns taste; the engine forwards the rubric
 * to the critic seam without interpretation. ADR 0003: no default rubric
 * ever ships from this package.
 */
export type Rubric = unknown;

/**
 * The screenshot the capture seam produces. `pngPath` is a worktree-relative
 * path the critic can read — for the walking skeleton it's a fixture PNG path
 * the test sets up. A real adapter would write a fresh PNG per iteration.
 */
export interface Screenshot {
  readonly route: string;
  readonly breakpoint: string;
  readonly pngPath: string;
}

/**
 * Narrow "how to serve this project" contract per ADR 0005. The engine only
 * needs `baseUrl` to point capture at, and `rebuild` to refresh the served
 * artifact between iterations after the editor commits. `stop` lets the host
 * tear down whatever process orchestration it spun up; the engine calls it
 * in a `finally` so a thrown seam can't leak a server.
 */
export interface PreviewAdapter {
  start(): Promise<{ readonly baseUrl: string }>;
  rebuild(): Promise<void>;
  stop(): Promise<void>;
}

export interface CaptureSeam {
  /**
   * Captures one screenshot per (route, breakpoint) pair and returns them in
   * a single batch. Returning the whole batch (rather than one-at-a-time)
   * keeps the engine's loop trivially deterministic and lets the critic see
   * all captures at once.
   */
  capture(args: {
    readonly baseUrl: string;
    readonly target: Target;
  }): Promise<readonly Screenshot[]>;
}

export interface CriticSeam {
  /**
   * Critiques the full batch of screenshots against the (opaque) rubric and
   * returns structured findings. Pure in the walking skeleton; in production
   * runs as a sandboxed agent (Slop-Check) per ADR 0005.
   */
  critique(args: {
    readonly screenshots: readonly Screenshot[];
    readonly rubric: Rubric;
  }): Promise<readonly Finding[]>;
}

export interface EditResult {
  /**
   * Human-readable summary of what changed on disk this iteration. Surfaces
   * through `IterationReport.diffSummary` (the last iteration's summary wins)
   * so the host can show what the engine ended up writing.
   */
  readonly diffSummary: string;
}

export interface EditorSeam {
  /**
   * Applies one batched edit covering *all* findings this iteration — never
   * per-finding (per the PRD's batching requirement). In production runs as
   * a sandboxed agent with the worktree mounted read-write per ADR 0005.
   */
  edit(args: { readonly findings: readonly Finding[] }): Promise<EditResult>;
}

/**
 * Verdict thresholds. Zero high-severity is hard-wired (per PRD); medium and
 * low are configurable per-consumer.
 *
 * Default in `runVisualEngine` is `mediumMax: Infinity, lowMax: Infinity` —
 * only high-severity findings fail the verdict. Consumers tighten as their
 * rubric demands.
 */
export interface VerdictPolicy {
  readonly mediumMax: number;
  readonly lowMax: number;
}
