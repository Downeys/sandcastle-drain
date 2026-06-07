import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPreviewAdapter,
  ReadinessTimeoutError,
  waitForReady,
} from './preview-adapter-runner.js';

// ---------------------------------------------------------------------------
// waitForReady — pure logic
// ---------------------------------------------------------------------------

describe('waitForReady', () => {
  it('returns when the fetcher resolves with ok: true', async () => {
    let calls = 0;
    await waitForReady({
      url: 'http://example/health',
      timeoutMs: 10_000,
      intervalMs: 100,
      fetcher: async () => {
        calls += 1;
        return { ok: true };
      },
      sleeper: async () => {},
      now: () => 0,
    });
    expect(calls).toBe(1);
  });

  it('retries through failed probes until one succeeds', async () => {
    let calls = 0;
    await waitForReady({
      url: 'http://example/health',
      timeoutMs: 10_000,
      intervalMs: 50,
      fetcher: async () => {
        calls += 1;
        if (calls < 4) return { ok: false };
        return { ok: true };
      },
      sleeper: async () => {},
      now: () => 0,
    });
    expect(calls).toBe(4);
  });

  it('swallows thrown errors from the fetcher (connection refused, etc.)', async () => {
    let calls = 0;
    await waitForReady({
      url: 'http://example/health',
      timeoutMs: 10_000,
      intervalMs: 50,
      fetcher: async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return { ok: true };
      },
      sleeper: async () => {},
      now: () => 0,
    });
    expect(calls).toBe(3);
  });

  it('throws ReadinessTimeoutError after the deadline elapses', async () => {
    let nowValue = 0;
    await expect(
      waitForReady({
        url: 'http://example/health',
        timeoutMs: 500,
        intervalMs: 50,
        fetcher: async () => ({ ok: false }),
        sleeper: async () => {
          nowValue += 200;
        },
        now: () => nowValue,
      }),
    ).rejects.toBeInstanceOf(ReadinessTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// createPreviewAdapter — spawn semantics with a fake child
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  killCalls: NodeJS.Signals[];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal: NodeJS.Signals) => boolean;
}

function makeFakeChild(): FakeChild {
  const e = new EventEmitter() as FakeChild;
  e.killCalls = [];
  e.exitCode = null;
  e.signalCode = null;
  e.kill = (signal: NodeJS.Signals) => {
    e.killCalls.push(signal);
    // Simulate the child exiting on SIGTERM almost immediately, so stop()
    // resolves without waiting for the grace timeout.
    queueMicrotask(() => {
      e.exitCode = 0;
      e.signalCode = signal;
      e.emit('exit', 0, signal);
    });
    return true;
  };
  return e;
}

describe('createPreviewAdapter', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('rejects an empty startCommand', () => {
    expect(() =>
      createPreviewAdapter({
        startCommand: [],
        readinessProbeUrl: 'http://example/',
      }),
    ).toThrow('non-empty argv');
  });

  it('start() waits for readiness then returns the configured baseUrl', async () => {
    const child = makeFakeChild();
    let probes = 0;
    const adapter = createPreviewAdapter({
      startCommand: ['fake', 'start'],
      readinessProbeUrl: 'http://localhost:9999/health',
      baseUrl: 'http://localhost:9999',
      spawner: () => child as unknown as import('node:child_process').ChildProcess,
      fetcher: async () => {
        probes += 1;
        return { ok: probes >= 2 };
      },
      sleeper: async () => {},
      now: () => 0,
    });
    cleanups.push(() => adapter.stop());

    const { baseUrl } = await adapter.start();
    expect(baseUrl).toBe('http://localhost:9999');
    expect(probes).toBeGreaterThanOrEqual(2);
  });

  it('defaults baseUrl to readinessProbeUrl when not given', async () => {
    const child = makeFakeChild();
    const adapter = createPreviewAdapter({
      startCommand: ['fake', 'start'],
      readinessProbeUrl: 'http://localhost:9999/',
      spawner: () => child as unknown as import('node:child_process').ChildProcess,
      fetcher: async () => ({ ok: true }),
      sleeper: async () => {},
      now: () => 0,
    });
    cleanups.push(() => adapter.stop());

    const { baseUrl } = await adapter.start();
    expect(baseUrl).toBe('http://localhost:9999/');
  });

  it('SIGTERMs the child on stop()', async () => {
    const child = makeFakeChild();
    const adapter = createPreviewAdapter({
      startCommand: ['fake', 'start'],
      readinessProbeUrl: 'http://localhost:9999/',
      spawner: () => child as unknown as import('node:child_process').ChildProcess,
      fetcher: async () => ({ ok: true }),
      sleeper: async () => {},
      now: () => 0,
    });
    await adapter.start();
    await adapter.stop();
    expect(child.killCalls).toContain('SIGTERM');
  });

  it('surfaces an early exit before readiness as an error and tears the child down', async () => {
    const child = makeFakeChild();
    const adapter = createPreviewAdapter({
      startCommand: ['fake', 'start'],
      readinessProbeUrl: 'http://localhost:9999/',
      spawner: () => child as unknown as import('node:child_process').ChildProcess,
      fetcher: async () => ({ ok: false }),
      sleeper: async (ms) => {
        // Simulate the server crashing partway through the first poll.
        queueMicrotask(() => {
          child.exitCode = 1;
          child.signalCode = null;
          child.emit('exit', 1, null);
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return;
      },
      now: () => 0,
    });

    await expect(adapter.start()).rejects.toThrow(/exited before becoming ready/);
    // No child to clean up afterward — start()'s catch already handled it.
    await adapter.stop();
  });

  it('start() called twice without stop() throws', async () => {
    const child = makeFakeChild();
    const adapter = createPreviewAdapter({
      startCommand: ['fake', 'start'],
      readinessProbeUrl: 'http://localhost:9999/',
      spawner: () => child as unknown as import('node:child_process').ChildProcess,
      fetcher: async () => ({ ok: true }),
      sleeper: async () => {},
      now: () => 0,
    });
    cleanups.push(() => adapter.stop());

    await adapter.start();
    await expect(adapter.start()).rejects.toThrow(/start\(\) called twice/);
  });

  it('rebuild() is a no-op when no rebuildCommand is configured', async () => {
    const child = makeFakeChild();
    const adapter = createPreviewAdapter({
      startCommand: ['fake', 'start'],
      readinessProbeUrl: 'http://localhost:9999/',
      spawner: () => child as unknown as import('node:child_process').ChildProcess,
      fetcher: async () => ({ ok: true }),
      sleeper: async () => {},
      now: () => 0,
    });
    cleanups.push(() => adapter.stop());

    await adapter.start();
    await expect(adapter.rebuild()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration — real http server + real `waitForReady` (no spawn)
// ---------------------------------------------------------------------------

describe('waitForReady — real http', () => {
  let server: Server;

  afterEach(async () => {
    if (server && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns when the http server starts responding 200', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    await waitForReady({
      url: `http://127.0.0.1:${port}/`,
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });
});
