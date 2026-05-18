import { describe, expect, it } from 'vitest';
import { SupersedesChain } from './supersedes-chain.js';

describe('SupersedesChain', () => {
  it('returns the original issue as the follow-up\'s sole ancestor', () => {
    const chain = new SupersedesChain();
    chain.recordRejection(132, 142);

    expect(chain.ancestorsOf(142)).toEqual([132]);
    expect(chain.ancestorsOf(132)).toEqual([]);
  });

  it('propagates ancestors through a two-deep chain so the tail rehabilitates both', () => {
    // Models the bug from the user report: #132 rejected → #142 (rejected) → #144 auto-merged.
    // Without ancestor propagation, #132 stays stuck in failedThisRun and #133's
    // `## Blocked by: #132` trips the skip-guard even though the work effectively shipped.
    const chain = new SupersedesChain();
    chain.recordRejection(132, 142);
    chain.recordRejection(142, 144);

    expect(chain.ancestorsOf(144)).toEqual([132, 142]);
  });

  it('keeps unrelated chains isolated', () => {
    const chain = new SupersedesChain();
    chain.recordRejection(132, 142);
    chain.recordRejection(200, 201);

    expect(chain.ancestorsOf(142)).toEqual([132]);
    expect(chain.ancestorsOf(201)).toEqual([200]);
    expect(chain.ancestorsOf(999)).toEqual([]);
  });
});
