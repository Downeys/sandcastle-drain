import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectPackageManager,
  determineCiOk,
  installArgs,
  needsInstall,
  type CiCheckRun,
} from './ci-gate.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ci-gate-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writePkg(content: object): void {
  writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify(content));
}

function touch(name: string): void {
  writeFileSync(join(tmpRoot, name), '');
}

describe('detectPackageManager', () => {
  it('returns pnpm when pnpm-lock.yaml exists', () => {
    touch('pnpm-lock.yaml');
    expect(detectPackageManager(tmpRoot)).toBe('pnpm');
  });

  it('returns yarn when yarn.lock exists', () => {
    touch('yarn.lock');
    expect(detectPackageManager(tmpRoot)).toBe('yarn');
  });

  it('returns npm when package-lock.json exists', () => {
    touch('package-lock.json');
    expect(detectPackageManager(tmpRoot)).toBe('npm');
  });

  it('lockfile precedence: pnpm > yarn > npm', () => {
    touch('pnpm-lock.yaml');
    touch('yarn.lock');
    touch('package-lock.json');
    expect(detectPackageManager(tmpRoot)).toBe('pnpm');
  });

  it('falls back to packageManager field when no lockfile', () => {
    writePkg({ packageManager: 'pnpm@9.0.0' });
    expect(detectPackageManager(tmpRoot)).toBe('pnpm');
  });

  it('parses yarn from packageManager field', () => {
    writePkg({ packageManager: 'yarn@4.0.0' });
    expect(detectPackageManager(tmpRoot)).toBe('yarn');
  });

  it('parses npm from packageManager field', () => {
    writePkg({ packageManager: 'npm@10.0.0' });
    expect(detectPackageManager(tmpRoot)).toBe('npm');
  });

  it('defaults to npm when nothing is detectable', () => {
    expect(detectPackageManager(tmpRoot)).toBe('npm');
  });

  it('defaults to npm when packageManager field is malformed', () => {
    writePkg({ packageManager: 12345 });
    expect(detectPackageManager(tmpRoot)).toBe('npm');
  });

  it('defaults to npm when packageManager names an unknown PM', () => {
    writePkg({ packageManager: 'bun@1.0.0' });
    expect(detectPackageManager(tmpRoot)).toBe('npm');
  });

  it('defaults to npm when package.json is malformed', () => {
    writeFileSync(join(tmpRoot, 'package.json'), '{ not valid json');
    expect(detectPackageManager(tmpRoot)).toBe('npm');
  });

  it('lockfile beats packageManager field', () => {
    touch('pnpm-lock.yaml');
    writePkg({ packageManager: 'yarn@4.0.0' });
    expect(detectPackageManager(tmpRoot)).toBe('pnpm');
  });
});

describe('needsInstall', () => {
  it('pnpm: false when .modules.yaml is present', () => {
    mkdirSync(join(tmpRoot, 'node_modules'));
    touch('node_modules/.modules.yaml');
    expect(needsInstall(tmpRoot, 'pnpm')).toBe(false);
  });

  it('pnpm: true when node_modules exists without .modules.yaml', () => {
    mkdirSync(join(tmpRoot, 'node_modules'));
    expect(needsInstall(tmpRoot, 'pnpm')).toBe(true);
  });

  it('pnpm: true when node_modules is absent', () => {
    expect(needsInstall(tmpRoot, 'pnpm')).toBe(true);
  });

  it('npm: false when node_modules exists', () => {
    mkdirSync(join(tmpRoot, 'node_modules'));
    expect(needsInstall(tmpRoot, 'npm')).toBe(false);
  });

  it('npm: true when node_modules is absent', () => {
    expect(needsInstall(tmpRoot, 'npm')).toBe(true);
  });

  it('yarn: false when node_modules exists', () => {
    mkdirSync(join(tmpRoot, 'node_modules'));
    expect(needsInstall(tmpRoot, 'yarn')).toBe(false);
  });
});

describe('installArgs', () => {
  it('returns `ci` for npm', () => {
    expect(installArgs('npm')).toEqual(['ci']);
  });

  it('returns `install --frozen-lockfile` for pnpm', () => {
    expect(installArgs('pnpm')).toEqual(['install', '--frozen-lockfile']);
  });

  it('returns `install --frozen-lockfile` for yarn', () => {
    expect(installArgs('yarn')).toEqual(['install', '--frozen-lockfile']);
  });
});

describe('determineCiOk', () => {
  it('returns ok=true on empty runs', () => {
    expect(determineCiOk([])).toEqual({ ok: true });
  });

  it('returns ok=true when every run has exit 0', () => {
    const runs: CiCheckRun[] = [
      { check: 'install', exitCode: 0, output: '' },
      { check: 'typecheck', exitCode: 0, output: '' },
      { check: 'lint', exitCode: 0, output: '' },
      { check: 'test', exitCode: 0, output: '' },
    ];
    expect(determineCiOk(runs)).toEqual({ ok: true });
  });

  it('returns ok=false and surfaces the first failed check', () => {
    const runs: CiCheckRun[] = [
      { check: 'install', exitCode: 0, output: '' },
      { check: 'typecheck', exitCode: 1, output: 'TS2307' },
      { check: 'lint', exitCode: 1, output: 'unrelated' },
    ];
    expect(determineCiOk(runs)).toEqual({ ok: false, failedCheck: 'typecheck' });
  });
});
