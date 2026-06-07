/**
 * Public entry point for the Visual-Iteration Engine.
 *
 * Consumers (the autonomous drain + website-midwife) import from
 * `sandcastle-drain/visual-engine` (subpath export wired in package.json) and
 * call `runVisualEngine` with their own rubric, preview adapter, and seams.
 *
 * Per ADR 0003 / 0005 this package owns the engine; consumers own taste
 * (rubric) and serve (preview adapter).
 */
export { runVisualEngine, DEFAULT_ITERATION_CEILING } from './engine.js';
export type { RunVisualEngineArgs } from './engine.js';
export { computeVerdict, DEFAULT_VERDICT_POLICY } from './verdict.js';
export type {
  CaptureSeam,
  CriticSeam,
  EditorSeam,
  EditResult,
  Finding,
  IterationReport,
  PreviewAdapter,
  Rubric,
  Screenshot,
  Severity,
  Target,
  Verdict,
  VerdictPolicy,
} from './types.js';
