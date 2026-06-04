import { describe, expect, it } from 'vitest';
import {
  buildPreAgentInstallHook,
  MIN_PRE_INSTALL_TIMEOUT_SECONDS,
  resolvePreInstallTimeoutMs,
} from './main.js';

const opts = { timeoutMs: 1000, issueNumber: 7 };

describe('buildPreAgentInstallHook', () => {
  it('puts the install on sandbox.onSandboxReady so it runs inside the container before agent boot', () => {
    const hooks = buildPreAgentInstallHook('pnpm', opts);
    expect(hooks.host).toBeUndefined();
    expect(hooks.sandbox?.onSandboxReady).toHaveLength(1);
  });

  it('wraps each package manager\'s frozen-install in a logged, pipefail-guarded command', () => {
    const cmd = (pm: 'npm' | 'pnpm' | 'yarn') =>
      buildPreAgentInstallHook(pm, opts).sandbox?.onSandboxReady?.[0]?.command ?? '';

    for (const [pm, install] of [
      ['npm', 'npm ci'],
      ['pnpm', 'pnpm install --frozen-lockfile'],
      ['yarn', 'yarn install --frozen-lockfile'],
    ] as const) {
      const command = cmd(pm);
      expect(command).toContain(install);
      // pipefail makes the pipeline surface the install's exit code, not tee's.
      expect(command).toContain('set -o pipefail');
      expect(command).toContain('tee .sandcastle/logs/pre-agent-install-7.log');
    }
  });

  it('uses the per-issue log path so concurrent-ish runs do not clobber each other', () => {
    const command = buildPreAgentInstallHook('pnpm', { timeoutMs: 1000, issueNumber: 42 })
      .sandbox?.onSandboxReady?.[0]?.command;
    expect(command).toContain('pre-agent-install-42.log');
  });

  it('passes the caller-supplied timeout through to the hook', () => {
    const hook = buildPreAgentInstallHook('npm', { timeoutMs: 123_456, issueNumber: 1 })
      .sandbox?.onSandboxReady?.[0];
    expect(hook?.timeoutMs).toBe(123_456);
  });
});

describe('resolvePreInstallTimeoutMs', () => {
  it('prefers the CLI flag value (converted to ms) over the env var', () => {
    expect(resolvePreInstallTimeoutMs(900, { SANDCASTLE_DRAIN_PRE_INSTALL_TIMEOUT_SECONDS: '300' })).toBe(
      900_000,
    );
  });

  it('falls back to the env var when no CLI value is given', () => {
    expect(resolvePreInstallTimeoutMs(undefined, { SANDCASTLE_DRAIN_PRE_INSTALL_TIMEOUT_SECONDS: '1800' })).toBe(
      1_800_000,
    );
  });

  it('falls back to the built-in default when neither is set', () => {
    // Default is 20 minutes.
    expect(resolvePreInstallTimeoutMs(undefined, {})).toBe(20 * 60 * 1000);
  });

  it('ignores a non-integer or below-minimum env var and uses the default', () => {
    const dflt = 20 * 60 * 1000;
    expect(resolvePreInstallTimeoutMs(undefined, { SANDCASTLE_DRAIN_PRE_INSTALL_TIMEOUT_SECONDS: 'abc' })).toBe(
      dflt,
    );
    expect(
      resolvePreInstallTimeoutMs(undefined, {
        SANDCASTLE_DRAIN_PRE_INSTALL_TIMEOUT_SECONDS: String(MIN_PRE_INSTALL_TIMEOUT_SECONDS - 1),
      }),
    ).toBe(dflt);
  });
});
