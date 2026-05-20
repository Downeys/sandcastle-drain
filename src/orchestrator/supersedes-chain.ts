/**
 * Tracks original-issue → priority-follow-up supersession chains during a single
 * drain run. Both reviewer rejections and CI-gate failures produce follow-ups
 * via this chain. When the tail of a chain auto-merges, every ancestor is
 * "effectively landed" — `ancestorsOf(tail)` returns them so the caller can
 * clear them from `failedThisRun` and stop skipping their dependents.
 *
 * In-memory only. A chain dies with the wrapper process; cross-run rehabilitation
 * is out of scope (the next run will refetch GitHub state cleanly).
 */
export class SupersedesChain {
  private readonly map = new Map<number, readonly number[]>();

  recordSupersession(original: number, followUp: number): void {
    const inherited = this.map.get(original) ?? [];
    this.map.set(followUp, [...inherited, original]);
  }

  ancestorsOf(issue: number): readonly number[] {
    return this.map.get(issue) ?? [];
  }
}
