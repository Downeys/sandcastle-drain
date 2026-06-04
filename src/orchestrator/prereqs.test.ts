import { describe, expect, it } from 'vitest';
import {
  hostPnpmStoreMount,
  sandboxPnpmEnv,
  SANDBOX_HOST_STORE_PATH,
  SANDBOX_VIRTUAL_STORE_DIR,
} from './prereqs.js';

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

describe('hostPnpmStoreMount', () => {
  const resolve = (path: string | null) => () => Promise.resolve(path);

  it('mounts the host store read-only and points store-dir at it on Windows + pnpm', async () => {
    const result = await hostPnpmStoreMount('pnpm', 'win32', resolve('C:\\store'));
    expect(result.mounts).toEqual([
      { hostPath: 'C:\\store', sandboxPath: SANDBOX_HOST_STORE_PATH, readonly: true },
    ]);
    expect(result.env).toEqual({ npm_config_store_dir: SANDBOX_HOST_STORE_PATH });
  });

  it('keeps the mounted store off the workspace bind mount', () => {
    // node_modules + the virtual store live under /home/agent/workspace; the
    // warm store must sit elsewhere on the container fs so it never collides.
    expect(SANDBOX_HOST_STORE_PATH.startsWith('/home/agent/')).toBe(true);
    expect(SANDBOX_HOST_STORE_PATH.startsWith('/home/agent/workspace')).toBe(false);
  });

  it('is a no-op on non-Windows hosts even for pnpm', async () => {
    expect(await hostPnpmStoreMount('pnpm', 'linux', resolve('/store'))).toEqual({
      mounts: [],
      env: {},
    });
    expect(await hostPnpmStoreMount('pnpm', 'darwin', resolve('/store'))).toEqual({
      mounts: [],
      env: {},
    });
  });

  it('is a no-op for npm and yarn on Windows (only pnpm hits the off-mount-store penalty)', async () => {
    expect(await hostPnpmStoreMount('npm', 'win32', resolve('C:\\store'))).toEqual({
      mounts: [],
      env: {},
    });
    expect(await hostPnpmStoreMount('yarn', 'win32', resolve('C:\\store'))).toEqual({
      mounts: [],
      env: {},
    });
  });

  it('falls back to a cold install (no mount) when the store path cannot be resolved', async () => {
    expect(await hostPnpmStoreMount('pnpm', 'win32', resolve(null))).toEqual({
      mounts: [],
      env: {},
    });
  });
});
