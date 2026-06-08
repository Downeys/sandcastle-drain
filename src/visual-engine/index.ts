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
export {
  createPlaywrightCapture,
  defaultPngName,
  joinUrl,
  parseBreakpointWidth,
  DEFAULT_BREAKPOINTS,
} from './capture.js';
export type {
  BrowserContextLike,
  BrowserLike,
  BrowserTypeLike,
  CreatePlaywrightCaptureOptions,
  PageLike,
} from './capture.js';
export {
  createPreviewAdapter,
  waitForReady,
  ReadinessTimeoutError,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_INTERVAL_MS,
} from './preview-adapter-runner.js';
export type {
  CreatePreviewAdapterOptions,
  WaitForReadyOptions,
} from './preview-adapter-runner.js';
export {
  buildScreenshotsBlock,
  createSlopCheckCritic,
  formatRubric,
  parseSlopCheckOutput,
  runSlopCheck,
  translateCapturePath,
  SLOP_CHECK_CAPTURES_SANDBOX_PATH,
} from './slop-check.js';
export type {
  RunSlopCheckArgs,
  RunSlopCheckDeps,
  SandcastleRunFn,
  SlopCheckParseResult,
  SlopCheckRunResult,
  SlopCheckSandboxConfig,
} from './slop-check.js';
export {
  buildFindingsBlock,
  createVisualEditor,
  runVisualEditor,
} from './visual-editor.js';
export type {
  RunVisualEditorArgs,
  RunVisualEditorDeps,
  VisualEditorRunResult,
  VisualEditorSandboxConfig,
} from './visual-editor.js';
export { runVisualEngineStandalone } from './standalone.js';
export type {
  RunVisualEngineStandaloneArgs,
  RunVisualEngineStandaloneDeps,
  VisualEngineStandaloneSandbox,
} from './standalone.js';
export {
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
} from './standalone-defaults.js';
