/**
 * `runVisualEngine` — host-side orchestrator for the Visual-Iteration Engine
 * walking skeleton. Per ADR 0005, the engine is deterministic TypeScript: it
 * boots a preview, drives capture → critique → (edit + rebuild + recapture)
 * up to a ceiling, and assembles a structured iteration report.
 *
 * **Mockable seams.** Capture, critic, and editor are passed in. The walking
 * skeleton tests inject fixture-PNG capture, a fake critic returning canned
 * findings, and a no-op editor so the loop runs end-to-end before any real
 * browser or sandbox exists. Production wiring (drain + website-midwife) will
 * supply concrete seam implementations in separate slices.
 *
 * **Batching.** One iteration sends *all* of that iteration's findings to the
 * editor in one call — never per-finding. The editor's diff is followed by
 * exactly one preview rebuild and one recapture. This is non-negotiable per
 * the PRD; the test suite asserts it.
 *
 * **Ceiling.** Default 3 (per PRD / ADR 0004). The loop exits on the first
 * iteration whose critic finds zero issues that violate the policy; otherwise
 * it iterates to the ceiling and returns its last verdict + findings. The
 * engine never throws on ceiling-fail — it returns a fail verdict and lets
 * the host decide how to surface it (in the drain: park at `needs-review` per
 * ADR 0004, not the rejection path).
 *
 * **Rubric stays opaque.** The rubric is forwarded to the critic verbatim;
 * the engine never reads or interprets it. ADR 0003: no default rubric ever
 * ships from this package.
 */
import type {
  CaptureSeam,
  CriticSeam,
  EditorSeam,
  Finding,
  IterationReport,
  PreviewAdapter,
  Rubric,
  Target,
  VerdictPolicy,
} from './types.js';
import { computeVerdict, DEFAULT_VERDICT_POLICY } from './verdict.js';

export const DEFAULT_ITERATION_CEILING = 3;

export interface RunVisualEngineArgs {
  readonly target: Target;
  readonly rubric: Rubric;
  readonly previewAdapter: PreviewAdapter;
  readonly capture: CaptureSeam;
  readonly critic: CriticSeam;
  readonly editor: EditorSeam;
  readonly ceiling?: number;
  readonly policy?: VerdictPolicy;
}

export async function runVisualEngine(args: RunVisualEngineArgs): Promise<IterationReport> {
  const {
    target,
    rubric,
    previewAdapter,
    capture,
    critic,
    editor,
    ceiling = DEFAULT_ITERATION_CEILING,
    policy = DEFAULT_VERDICT_POLICY,
  } = args;

  const { baseUrl } = await previewAdapter.start();

  let findings: readonly Finding[] = [];
  let verdict: IterationReport['verdict'] = 'fail';
  let iterations = 0;
  let diffSummary = '';

  try {
    for (let i = 0; i < ceiling; i++) {
      const screenshots = await capture.capture({ baseUrl, target });
      findings = await critic.critique({ screenshots, rubric });
      verdict = computeVerdict(findings, policy);
      iterations = i + 1;

      if (verdict === 'pass') break;

      // Not the last allowed iteration → batched edit + rebuild, then recapture
      // happens at the top of the next loop turn.
      if (i < ceiling - 1) {
        const editResult = await editor.edit({ findings });
        diffSummary = editResult.diffSummary;
        await previewAdapter.rebuild();
      }
    }
  } finally {
    await previewAdapter.stop();
  }

  return {
    verdict,
    findings,
    iterations,
    breakpointsCaptured: target.breakpoints,
    targetsCaptured: target.routes,
    diffSummary,
  };
}
