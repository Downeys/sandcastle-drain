import { describe, expect, it } from 'vitest';
import { buildPreAgentInstallHook } from './main.js';

describe('buildPreAgentInstallHook', () => {
  it('puts the install on sandbox.onSandboxReady so it runs inside the container before agent boot', () => {
    const hooks = buildPreAgentInstallHook('pnpm');
    expect(hooks.host).toBeUndefined();
    expect(hooks.sandbox?.onSandboxReady).toHaveLength(1);
  });

  it('builds a single-string frozen-install command per package manager', () => {
    expect(buildPreAgentInstallHook('npm').sandbox?.onSandboxReady?.[0]?.command).toBe('npm ci');
    expect(buildPreAgentInstallHook('pnpm').sandbox?.onSandboxReady?.[0]?.command).toBe(
      'pnpm install --frozen-lockfile',
    );
    expect(buildPreAgentInstallHook('yarn').sandbox?.onSandboxReady?.[0]?.command).toBe(
      'yarn install --frozen-lockfile',
    );
  });

  it('sets a hook-level timeout so a stuck install aborts before the agent ever boots', () => {
    const hook = buildPreAgentInstallHook('npm').sandbox?.onSandboxReady?.[0];
    expect(hook?.timeoutMs).toBeGreaterThan(0);
  });
});
