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

  it('logs each package manager\'s frozen-install and preserves the install exit code (no pipefail/tee — container sh is dash)', () => {
    const cmd = (pm: 'npm' | 'pnpm' | 'yarn') =>
      buildPreAgentInstallHook(pm, opts).sandbox?.onSandboxReady?.[0]?.command ?? '';

    for (const [pm, install] of [
      ['npm', 'npm ci'],
      ['pnpm', 'pnpm install --frozen-lockfile'],
      ['yarn', 'yarn install --frozen-lockfile'],
    ] as const) {
      const command = cmd(pm);
      // Redirect to the per-issue log, then exit with the install's real code —
      // dash has no pipefail, so a `| tee` would mask a failed install as 0.
      expect(command).toContain(`${install} > .sandcastle/logs/pre-agent-install-7.log 2>&1`);
      expect(command).toContain('code=$?');
      expect(command).toContain('exit $code');
      expect(command).not.toContain('pipefail');
      expect(command).not.toContain('tee ');
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
    // Default is 45 minutes — sized for a slow Windows/virtiofs install.
    expect(resolvePreInstallTimeoutMs(undefined, {})).toBe(45 * 60 * 1000);
  });

  it('ignores a non-integer or below-minimum env var and uses the default', () => {
    const dflt = 45 * 60 * 1000;
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
