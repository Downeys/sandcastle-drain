import { describe, expect, it } from 'vitest';
import {
  parseWorktreeListPorcelain,
  SANDCASTLE_LIB_DIR,
  sandcastleWorktreePath,
} from './worktree-cleanup.js';

describe('parseWorktreeListPorcelain', () => {
  it('returns the path of a worktree linked to the target branch', () => {
    const stdout = [
      'worktree /home/user/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo/.sandcastle/worktrees/agent-issue-70',
      'HEAD def456',
      'branch refs/heads/agent/issue-70',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout, 'agent/issue-70')).toEqual([
      '/home/user/repo/.sandcastle/worktrees/agent-issue-70',
    ]);
  });

  it('returns empty when no worktree is linked to the branch', () => {
    const stdout = ['worktree /home/user/repo', 'HEAD abc123', 'branch refs/heads/main', ''].join(
      '\n',
    );
    expect(parseWorktreeListPorcelain(stdout, 'agent/issue-70')).toEqual([]);
  });

  it('skips detached-HEAD entries that have no branch line', () => {
    const stdout = [
      'worktree /home/user/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo/detached',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout, 'agent/issue-70')).toEqual([]);
  });

  it('handles CRLF line endings (Windows git output)', () => {
    const stdout = [
      'worktree C:/Users/downe/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree C:/Users/downe/repo/.sandcastle/worktrees/agent-issue-70',
      'HEAD def456',
      'branch refs/heads/agent/issue-70',
      '',
    ].join('\r\n');
    expect(parseWorktreeListPorcelain(stdout, 'agent/issue-70')).toEqual([
      'C:/Users/downe/repo/.sandcastle/worktrees/agent-issue-70',
    ]);
  });

  it('returns all matches when multiple worktrees claim the same branch (defensive)', () => {
    const stdout = [
      'worktree /home/user/old-path/agent-issue-70',
      'HEAD abc123',
      'branch refs/heads/agent/issue-70',
      '',
      'worktree /home/user/new-path/agent-issue-70',
      'HEAD def456',
      'branch refs/heads/agent/issue-70',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout, 'agent/issue-70')).toEqual([
      '/home/user/old-path/agent-issue-70',
      '/home/user/new-path/agent-issue-70',
    ]);
  });
});

// These two suites pin the on-disk directory that upstream @ai-hero/sandcastle
// owns. The wrapper's own dir is `.sandcastle-drain/`, but sandcastle creates
// worktrees at `<repo>/.sandcastle/worktrees/...`. A prior rename refactor
// renamed this path too — breaking the pre-flight orphan cleanup on Windows
// because the probe missed the real orphan dir. Do not change `.sandcastle` to
// `.sandcastle-drain` here without first confirming upstream sandcastle has
// also renamed its CONFIG_DIR.
describe('SANDCASTLE_LIB_DIR', () => {
  it("is '.sandcastle' (upstream-owned; do not rename)", () => {
    expect(SANDCASTLE_LIB_DIR).toBe('.sandcastle');
  });
});

describe('sandcastleWorktreePath', () => {
  it('flattens agent/issue-N branch names under <repo>/.sandcastle/worktrees/', () => {
    const path = sandcastleWorktreePath('/home/user/repo', 'agent/issue-70');
    // Use forward-slash normalization for cross-platform path assertion.
    expect(path.replaceAll('\\', '/')).toBe(
      '/home/user/repo/.sandcastle/worktrees/agent-issue-70',
    );
  });

  it('uses .sandcastle (library dir) not .sandcastle-drain (wrapper dir)', () => {
    const path = sandcastleWorktreePath('/repo', 'agent/issue-1');
    expect(path).toContain('.sandcastle');
    expect(path).not.toContain('.sandcastle-drain');
  });
});
