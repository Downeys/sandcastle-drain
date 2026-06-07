/**
 * Pure findings → verdict mapping for the Visual-Iteration Engine.
 *
 * The rule (per PRD): zero high-severity findings is a hard requirement for
 * `pass`; medium and low findings fail only above a configurable per-severity
 * threshold. Separating this out keeps the rule one short, exhaustive function
 * the engine and any standalone Slop-Check audit can share.
 */
import type { Finding, Verdict, VerdictPolicy } from './types.js';

/**
 * Default policy: only high-severity fails. Consumers tighten as their rubric
 * demands. We default permissive rather than strict because the engine's job
 * is to *iterate toward* a good UI, not to reject on the first nit — and a
 * brand-new walking-skeleton consumer should not have to thread a policy
 * through just to see the loop run.
 */
export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  mediumMax: Number.POSITIVE_INFINITY,
  lowMax: Number.POSITIVE_INFINITY,
};

export function computeVerdict(
  findings: readonly Finding[],
  policy: VerdictPolicy,
): Verdict {
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    switch (f.severity) {
      case 'high':
        return 'fail';
      case 'medium':
        medium += 1;
        break;
      case 'low':
        low += 1;
        break;
    }
  }
  if (medium > policy.mediumMax) return 'fail';
  if (low > policy.lowMax) return 'fail';
  return 'pass';
}
