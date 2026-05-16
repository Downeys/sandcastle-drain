import { describe, expect, it } from 'vitest';
import { parseWorktreeListPorcelain } from './worktree-cleanup.js';

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
