import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectRubricFlags,
  resetRubricFlagsCache,
  stage,
  STAGED_DIR_RELATIVE,
} from './stage.js';

let host: string;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), 'stage-test-'));
  resetRubricFlagsCache();
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

describe('detectRubricFlags()', () => {
  it('returns both flags false when neither CONTEXT.md nor docs/adr/ exist', () => {
    expect(detectRubricFlags(host)).toEqual({ hasContextMd: false, hasAdrs: false });
  });

  it('reports hasContextMd=true when CONTEXT.md exists and is non-empty', () => {
    writeFileSync(join(host, 'CONTEXT.md'), '# Glossary\n\nFoo means bar.\n');
    expect(detectRubricFlags(host).hasContextMd).toBe(true);
  });

  it('reports hasContextMd=false when CONTEXT.md exists but is empty', () => {
    writeFileSync(join(host, 'CONTEXT.md'), '');
    expect(detectRubricFlags(host).hasContextMd).toBe(false);
  });

  it('reports hasAdrs=true when docs/adr/ contains at least one non-README .md', () => {
    mkdirSync(join(host, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(host, 'docs', 'adr', 'README.md'), '# Index\n');
    writeFileSync(join(host, 'docs', 'adr', '0001-pick-db.md'), '# 0001 — Pick a DB\n');
    expect(detectRubricFlags(host).hasAdrs).toBe(true);
  });

  it('reports hasAdrs=false when docs/adr/ only contains README.md', () => {
    mkdirSync(join(host, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(host, 'docs', 'adr', 'README.md'), '# Index\n');
    expect(detectRubricFlags(host).hasAdrs).toBe(false);
  });

  it('reports hasAdrs=false when docs/adr/ does not exist', () => {
    expect(detectRubricFlags(host).hasAdrs).toBe(false);
  });

  it('memoizes results per cwd so repeat calls do not re-probe disk', () => {
    const first = detectRubricFlags(host);
    writeFileSync(join(host, 'CONTEXT.md'), '# Glossary\n');
    // Without the cache this would now report hasContextMd=true. The cache
    // is intentional — flags are sampled once per drain.
    const second = detectRubricFlags(host);
    expect(second).toBe(first);
    expect(second.hasContextMd).toBe(false);

    resetRubricFlagsCache();
    const third = detectRubricFlags(host);
    expect(third.hasContextMd).toBe(true);
  });
});
