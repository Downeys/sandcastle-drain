import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage, STAGED_DIR_RELATIVE } from './stage.js';

let host: string;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), 'stage-test-'));
});

afterEach(() => {
  rmSync(host, { recursive: true, force: true });
});

describe('stage()', () => {
  it('copies principles + agent-docs into <cwd>/.sandcastle/staged/', async () => {
    const result = await stage(host);

    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'README.md'))).toBe(true);
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'testing.md'))).toBe(true);
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'agent-docs', 'issue-tracker.md'))).toBe(
      true,
    );

    expect(result.copyToWorktree).toEqual([STAGED_DIR_RELATIVE]);
  });

  it('does not write any prompt files into the host .sandcastle/ dir', async () => {
    await stage(host);
    expect(existsSync(join(host, '.sandcastle', 'prompt.md'))).toBe(false);
    expect(existsSync(join(host, '.sandcastle', 'reviewer.md'))).toBe(false);
  });

  it('replaces a stale staged tree on re-stage (library-upgrade scenario)', async () => {
    await stage(host);
    const stalePath = join(host, STAGED_DIR_RELATIVE, 'principles', 'stale-from-prior-run.md');
    writeFileSync(stalePath, 'this file should be gone after re-stage');
    expect(existsSync(stalePath)).toBe(true);

    await stage(host);

    expect(existsSync(stalePath)).toBe(false);
    // Library-bundled content is still present.
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'README.md'))).toBe(true);
  });
});
