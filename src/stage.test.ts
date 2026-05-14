import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stage,
  IMPLEMENTER_PROMPT_RELATIVE,
  REVIEWER_PROMPT_RELATIVE,
  STAGED_DIR_RELATIVE,
} from './stage.js';

let host: string;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), 'stage-test-'));
});

afterEach(() => {
  rmSync(host, { recursive: true, force: true });
});

describe('stage()', () => {
  it('copies principles + agent-docs + prompts into <cwd>/.sandcastle/', async () => {
    const result = await stage(host);

    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'README.md'))).toBe(true);
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'testing.md'))).toBe(true);
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'agent-docs', 'issue-tracker.md'))).toBe(
      true,
    );
    expect(existsSync(join(host, IMPLEMENTER_PROMPT_RELATIVE))).toBe(true);
    expect(existsSync(join(host, REVIEWER_PROMPT_RELATIVE))).toBe(true);

    expect(result.copyToWorktree).toEqual([STAGED_DIR_RELATIVE]);
    expect(result.implementerPromptPath).toBe(IMPLEMENTER_PROMPT_RELATIVE);
    expect(result.reviewerPromptPath).toBe(REVIEWER_PROMPT_RELATIVE);
  });

  it('writes the implementer prompt with the post-staging path references', async () => {
    await stage(host);
    const prompt = readFileSync(join(host, IMPLEMENTER_PROMPT_RELATIVE), 'utf8');
    expect(prompt).toContain('.sandcastle/staged/principles/');
    expect(prompt).not.toContain('src/content/principles/');
  });

  it('writes the reviewer prompt with the post-staging path references', async () => {
    await stage(host);
    const prompt = readFileSync(join(host, REVIEWER_PROMPT_RELATIVE), 'utf8');
    expect(prompt).toContain('.sandcastle/staged/principles/');
    expect(prompt).not.toContain('src/content/principles/');
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
