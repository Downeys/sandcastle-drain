/**
 * End-to-end wiring test for the real preview-adapter runner + capture seam.
 *
 * Per ADR 0005, real browser capture runs on the host and is intentionally
 * not exercised in unit tests — the principle calls it out explicitly: "Real-
 * IO paths (browser capture, preview adapter) are intentionally not unit-
 * tested. Drive them with a fixture static site rather than mocking the IO."
 *
 * This file is the "fixture static site" half of that — it stands up a real
 * `node:http` server serving a tiny site, drives the engine against it with
 * the real `createPreviewAdapter`, and verifies the engine produces a real
 * PNG per (route × breakpoint) into the worktree. The browser is fake (we
 * don't bundle Playwright into the test runtime) but everything else — port
 * binding, readiness probing, file writes — is real.
 *
 * The capture seam's contract with the browser is the seam the next slice
 * tests in CI with real Chromium. This test pins the rest.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPlaywrightCapture,
  createPreviewAdapter,
  DEFAULT_BREAKPOINTS,
  runVisualEngine,
  type BrowserContextLike,
  type BrowserLike,
  type BrowserTypeLike,
  type CriticSeam,
  type EditorSeam,
  type PageLike,
} from './index.js';

interface FixtureSite {
  readonly server: Server;
  readonly baseUrl: string;
  readonly hits: string[];
}

async function startFixtureSite(): Promise<FixtureSite> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '/';
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><h1>Home</h1></body></html>');
      return;
    }
    if (url.startsWith('/about')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><h1>About</h1></body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, hits };
}

/**
 * Fake browser that writes a deterministic 1-byte PNG-ish blob per
 * screenshot so we can assert real file writes without dragging Playwright
 * into the test runtime.
 */
function makeFileWritingBrowser(): BrowserTypeLike {
  return {
    async launch(): Promise<BrowserLike> {
      return {
        async newContext(): Promise<BrowserContextLike> {
          return {
            async newPage(): Promise<PageLike> {
              let lastUrl = '';
              return {
                async goto(url) {
                  // Real network hit against the fixture site — the test
                  // asserts the site recorded the GET, which proves the
                  // preview adapter's readiness probe + the engine's goto
                  // routing are both wired correctly.
                  const res = await fetch(url);
                  lastUrl = url;
                  await res.text();
                  return null;
                },
                async screenshot({ path }) {
                  await writeFile(path, Buffer.from(`PNG-bytes:${lastUrl}`));
                  return null;
                },
                async close() {
                  /* no-op */
                },
              };
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
}

/**
 * Build a minimal `ChildProcess`-shaped stub that exits on SIGTERM. The
 * fixture site is the *actual* server in this test — the preview adapter's
 * spawned process is irrelevant to what we're verifying — so this stub
 * stands in for "an external process was spawned and we still want stop()
 * to tear it down cleanly."
 */
function makeStubChild(): ChildProcess {
  const e = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  e.exitCode = null;
  e.signalCode = null;
  e.kill = (signal: NodeJS.Signals) => {
    e.exitCode = 0;
    e.signalCode = signal;
    queueMicrotask(() => e.emit('exit', 0, signal));
    return true;
  };
  return e as unknown as ChildProcess;
}

describe('visual-engine end-to-end against a real fixture site', () => {
  let site: FixtureSite | null = null;

  afterEach(async () => {
    if (site && site.server.listening) {
      await new Promise<void>((resolve) => site!.server.close(() => resolve()));
    }
    site = null;
  });

  it('writes one PNG per route × default-breakpoint into the worktree', async () => {
    site = await startFixtureSite();
    const outDir = await mkdtemp(join(tmpdir(), 'engine-e2e-'));

    // Use the *real* preview adapter — but instead of spawning a separate
    // start command, we point its readiness probe at the already-running
    // fixture server. The adapter's spawner is a no-op; nothing else
    // changes. This proves the readiness-probe + baseUrl wiring without
    // duplicating the fixture-server-spawning machinery on top.
    const adapter = createPreviewAdapter({
      startCommand: ['true'],
      readinessProbeUrl: `${site.baseUrl}/`,
      spawner: () => makeStubChild(),
    });

    const capture = createPlaywrightCapture({
      outDir,
      browserType: makeFileWritingBrowser(),
    });

    const noFindingsCritic: CriticSeam = { async critique() { return []; } };
    const noopEditor: EditorSeam = { async edit() { return { diffSummary: '' }; } };

    const report = await runVisualEngine({
      target: { routes: ['/', '/about'], breakpoints: [...DEFAULT_BREAKPOINTS] },
      rubric: undefined,
      previewAdapter: adapter,
      capture,
      critic: noFindingsCritic,
      editor: noopEditor,
    });

    expect(report.verdict).toBe('pass');
    expect(report.iterations).toBe(1);

    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(
      [
        'about-1440.png',
        'about-375.png',
        'about-768.png',
        'root-1440.png',
        'root-375.png',
        'root-768.png',
      ].sort(),
    );

    // Spot-check that the screenshot really was written by the fake browser
    // after a real GET against the fixture site at the expected URL.
    const aboutBytes = await readFile(join(outDir, 'about-375.png'), 'utf8');
    expect(aboutBytes).toBe(`PNG-bytes:${site.baseUrl}/about`);

    // The fixture site saw every route we asked the engine to capture.
    const routesHit = new Set(site.hits);
    expect(routesHit.has('/')).toBe(true);
    expect(routesHit.has('/about')).toBe(true);
  });

  it('captures at consumer-configurable breakpoints, not just the defaults', async () => {
    site = await startFixtureSite();
    const outDir = await mkdtemp(join(tmpdir(), 'engine-e2e-bp-'));

    const adapter = createPreviewAdapter({
      startCommand: ['true'],
      readinessProbeUrl: `${site.baseUrl}/`,
      spawner: () => makeStubChild(),
    });

    const capture = createPlaywrightCapture({ outDir, browserType: makeFileWritingBrowser() });

    await runVisualEngine({
      target: { routes: ['/'], breakpoints: ['320', '1024'] },
      rubric: undefined,
      previewAdapter: adapter,
      capture,
      critic: { async critique() { return []; } },
      editor: { async edit() { return { diffSummary: '' }; } },
    });

    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(['root-1024.png', 'root-320.png']);
  });
});
