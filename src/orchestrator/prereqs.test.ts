import { describe, expect, it } from 'vitest';
import { sandboxPnpmEnv, SANDBOX_VIRTUAL_STORE_DIR } from './prereqs.js';

describe('sandboxPnpmEnv', () => {
  it('redirects pnpm\'s virtual store off the bind mount on Windows hosts', () => {
    expect(sandboxPnpmEnv('win32')).toEqual({
      npm_config_virtual_store_dir: SANDBOX_VIRTUAL_STORE_DIR,
    });
  });

  it('points the virtual store at a container-Linux path outside the workspace mount', () => {
    // The agent worktree is bind-mounted at /home/agent/workspace; the virtual
    // store must live elsewhere on the container fs, or the EACCES returns.
    expect(SANDBOX_VIRTUAL_STORE_DIR.startsWith('/home/agent/')).toBe(true);
    expect(SANDBOX_VIRTUAL_STORE_DIR.startsWith('/home/agent/workspace')).toBe(
      false,
    );
  });

  it('is a no-op on non-Windows hosts, where the bind mount is native', () => {
    expect(sandboxPnpmEnv('linux')).toEqual({});
    expect(sandboxPnpmEnv('darwin')).toEqual({});
  });
});
