/**
 * Real preview-adapter runner — boots the host's single `start` command,
 * polls a readiness probe until 2xx, hands back `baseUrl`, tears the process
 * down on `stop()`.
 *
 * Per ADR 0005 the engine is stack-agnostic: this runner is a *default*
 * `PreviewAdapter` implementation hosts can construct with one call when
 * their stack fits the "spawn a command, wait for it to serve, kill on
 * teardown" shape. Hosts whose serving model is more exotic (multi-process
 * orchestration, container boot, etc.) implement `PreviewAdapter` directly
 * — this runner is convenience, not the contract.
 *
 * The runner is deliberately argv-based (`['npm', 'run', 'preview']`) rather
 * than a shell string. A built artifact's start command is usually a fixed
 * argv anyway, and skipping the shell avoids injection corners.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import type { PreviewAdapter } from './types.js';

export const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
export const DEFAULT_READINESS_INTERVAL_MS = 250;
const DEFAULT_STOP_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// waitForReady — pure polling logic
// ---------------------------------------------------------------------------

export interface WaitForReadyOptions {
  /** Probe URL polled until a fetch resolves with `ok === true`. */
  readonly url: string;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** Injected for tests; defaults to global `fetch`. */
  readonly fetcher?: (url: string) => Promise<{ readonly ok: boolean }>;
  /** Injected for tests; defaults to `node:timers/promises` setTimeout. */
  readonly sleeper?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class ReadinessTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`Readiness probe ${url} did not return 2xx within ${timeoutMs}ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

/**
 * Polls `url` at `intervalMs` until a fetch resolves with `ok === true` or
 * `timeoutMs` elapses. Throws `ReadinessTimeoutError` on timeout. Swallows
 * per-probe errors (a connection refused while the server is still booting
 * is expected — that's the whole point of probing).
 */
export async function waitForReady(opts: WaitForReadyOptions): Promise<void> {
  const fetcher = opts.fetcher ?? ((url: string) => fetch(url));
  const sleeper = opts.sleeper ?? ((ms: number) => wait(ms));
  const now = opts.now ?? (() => Date.now());

  const deadline = now() + opts.timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetcher(opts.url);
      if (res.ok) return;
    } catch {
      // Server is still booting — connection refused, DNS not ready, etc.
      // Fall through to the timeout check + sleep.
    }
    if (now() >= deadline) {
      throw new ReadinessTimeoutError(opts.url, opts.timeoutMs);
    }
    await sleeper(opts.intervalMs);
  }
}

// ---------------------------------------------------------------------------
// createPreviewAdapter
// ---------------------------------------------------------------------------

export interface CreatePreviewAdapterOptions {
  /**
   * Argv form (e.g. `['npm', 'run', 'preview']`). No shell, no string
   * interpolation. The host's `start` command is expected to wrap whatever
   * multi-process startup the project needs behind this one call.
   */
  readonly startCommand: readonly string[];
  /**
   * URL polled to confirm the server is up. Often the same as `baseUrl` (the
   * server's root), occasionally a dedicated `/health` route.
   */
  readonly readinessProbeUrl: string;
  /**
   * Base URL handed back from `start()` to point capture at. Defaults to
   * `readinessProbeUrl`, which is the common case (host serves the site at
   * the same URL the probe hits).
   */
  readonly baseUrl?: string;
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Extra environment variables merged over `process.env`. The host's start
   * command often needs `PORT=...` or similar.
   */
  readonly env?: Record<string, string>;
  /**
   * Optional rebuild command — invoked between engine iterations after the
   * editor commits. Spawned and awaited until exit. No-op if absent (suitable
   * for dev-server stacks with hot reload).
   */
  readonly rebuildCommand?: readonly string[];
  /** Default 60_000. */
  readonly readinessTimeoutMs?: number;
  /** Default 250. */
  readonly readinessIntervalMs?: number;
  /**
   * Time to wait after SIGTERM before SIGKILL. Default 5s. The point of the
   * grace is to let the start command flush logs / detach child processes;
   * a stuck server still gets killed.
   */
  readonly stopGraceMs?: number;
  /**
   * Optional spawner override for tests. Defaults to `node:child_process`'s
   * `spawn` with stdio set so the parent doesn't deadlock on a chatty server.
   */
  readonly spawner?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
  ) => ChildProcess;
  /** Injected for tests; passed through to `waitForReady`. */
  readonly fetcher?: (url: string) => Promise<{ readonly ok: boolean }>;
  /** Injected for tests; passed through to `waitForReady`. */
  readonly sleeper?: (ms: number) => Promise<void>;
  /** Injected for tests; passed through to `waitForReady`. */
  readonly now?: () => number;
}

function defaultSpawner(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
): ChildProcess {
  // 'ignore' for stdin — the start command should never wait on input.
  // 'inherit' for stdout/stderr so the host can see what the server says
  // without us buffering its output (which would slowly OOM a chatty server).
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function killProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  const timeoutId = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createPreviewAdapter(opts: CreatePreviewAdapterOptions): PreviewAdapter {
  if (opts.startCommand.length === 0) {
    throw new Error('createPreviewAdapter: startCommand must be a non-empty argv array');
  }

  const spawner = opts.spawner ?? defaultSpawner;
  const timeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = opts.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const baseUrl = opts.baseUrl ?? opts.readinessProbeUrl;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;

  let child: ChildProcess | null = null;

  return {
    async start() {
      if (child !== null) {
        throw new Error('createPreviewAdapter: start() called twice without stop()');
      }
      const [cmd, ...args] = opts.startCommand;
      const proc = spawner(cmd, args, { cwd: opts.cwd, env });
      child = proc;

      // If the server crashes before becoming ready, the readiness probe
      // would happily keep polling until the timeout. Surface the early
      // exit immediately instead. We track it via a promise that rejects
      // on 'exit' before readiness completes.
      const earlyExit = new Promise<never>((_, reject) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          reject(
            new Error(
              `Preview adapter start command exited before becoming ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
            ),
          );
        };
        proc.once('exit', onExit);
      });

      try {
        await Promise.race([
          waitForReady({
            url: opts.readinessProbeUrl,
            timeoutMs,
            intervalMs,
            fetcher: opts.fetcher,
            sleeper: opts.sleeper,
            now: opts.now,
          }),
          earlyExit,
        ]);
      } catch (err) {
        // Tear the server down before propagating, so a readiness failure
        // doesn't leak a process.
        await killProcess(proc, stopGraceMs).catch(() => {});
        child = null;
        throw err;
      }
      return { baseUrl };
    },

    async rebuild() {
      if (!opts.rebuildCommand) return;
      const [cmd, ...args] = opts.rebuildCommand;
      const proc = spawner(cmd, args, { cwd: opts.cwd, env });
      await new Promise<void>((resolve, reject) => {
        proc.once('exit', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Preview adapter rebuild command failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
              ),
            );
        });
        proc.once('error', reject);
      });
    },

    async stop() {
      const proc = child;
      child = null;
      if (!proc) return;
      await killProcess(proc, stopGraceMs);
    },
  };
}
