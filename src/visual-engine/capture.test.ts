import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPlaywrightCapture,
  defaultPngName,
  joinUrl,
  parseBreakpointWidth,
  type BrowserContextLike,
  type BrowserLike,
  type BrowserTypeLike,
  type PageLike,
} from './capture.js';
import type { Target } from './types.js';

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('parseBreakpointWidth', () => {
  it.each([
    ['375', 375],
    ['768', 768],
    ['1440', 1440],
    ['1920px', 1920],
    ['1440x900', 1440],
    [' 600 ', 600],
  ])('parses %s as %i', (input, expected) => {
    expect(parseBreakpointWidth(input)).toBe(expected);
  });

  it.each(['', 'wide', 'px', '0', '-100'])('throws on garbage input %j', (input) => {
    expect(() => parseBreakpointWidth(input)).toThrow();
  });
});

describe('joinUrl', () => {
  it.each([
    ['http://localhost:4173', '/', 'http://localhost:4173/'],
    ['http://localhost:4173/', '/', 'http://localhost:4173/'],
    ['http://localhost:4173', '/about', 'http://localhost:4173/about'],
    ['http://localhost:4173/', '/about', 'http://localhost:4173/about'],
    ['http://localhost:4173', 'about', 'http://localhost:4173/about'],
    ['http://localhost:4173/app', '/about', 'http://localhost:4173/app/about'],
    ['http://localhost:4173/app', '', 'http://localhost:4173/app/'],
  ])('joins %s + %s → %s', (base, route, expected) => {
    expect(joinUrl(base, route)).toBe(expected);
  });
});

describe('defaultPngName', () => {
  it('uses "root" for the root route', () => {
    expect(defaultPngName({ route: '/', breakpoint: '375' })).toBe('root-375.png');
  });

  it('replaces interior slashes with underscores', () => {
    expect(defaultPngName({ route: '/blog/2026/01/post', breakpoint: '1440' })).toBe(
      'blog_2026_01_post-1440.png',
    );
  });

  it('handles a route with no leading slash', () => {
    expect(defaultPngName({ route: 'about', breakpoint: '768' })).toBe('about-768.png');
  });
});

// ---------------------------------------------------------------------------
// createPlaywrightCapture — fake browser
// ---------------------------------------------------------------------------

interface RecordedShot {
  readonly url: string;
  readonly pngPath: string;
  readonly fullPage: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
}

interface FakeBrowser {
  readonly browserType: BrowserTypeLike;
  readonly recorded: RecordedShot[];
  readonly closed: { browser: number; contexts: number; pages: number };
}

function makeFakeBrowser(): FakeBrowser {
  const recorded: RecordedShot[] = [];
  const closed = { browser: 0, contexts: 0, pages: 0 };

  const browserType: BrowserTypeLike = {
    async launch() {
      const browser: BrowserLike = {
        async newContext(options) {
          const viewport = options?.viewport ?? { width: 0, height: 0 };
          const context: BrowserContextLike = {
            async newPage() {
              let currentUrl = '';
              const page: PageLike = {
                async goto(url) {
                  currentUrl = url;
                  return null;
                },
                async screenshot({ path, fullPage }) {
                  recorded.push({
                    url: currentUrl,
                    pngPath: path,
                    fullPage: fullPage ?? false,
                    viewport,
                  });
                  return Buffer.from('');
                },
                async close() {
                  closed.pages += 1;
                },
              };
              return page;
            },
            async close() {
              closed.contexts += 1;
            },
          };
          return context;
        },
        async close() {
          closed.browser += 1;
        },
      };
      return browser;
    },
  };

  return { browserType, recorded, closed };
}

describe('createPlaywrightCapture', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'capture-test-'));
  });

  afterEach(() => {
    // tmpdir cleanup is left to the OS — the fake browser does not write real
    // bytes, so there's nothing to clobber on a quick test run.
  });

  it('captures one PNG per route × breakpoint and writes paths under outDir', async () => {
    const fake = makeFakeBrowser();
    const target: Target = { routes: ['/', '/about'], breakpoints: ['375', '768', '1440'] };
    const capture = createPlaywrightCapture({ outDir, browserType: fake.browserType });

    const shots = await capture.capture({ baseUrl: 'http://localhost:4173', target });

    expect(shots).toHaveLength(6);
    expect(new Set(shots.map((s) => s.route))).toEqual(new Set(['/', '/about']));
    expect(new Set(shots.map((s) => s.breakpoint))).toEqual(new Set(['375', '768', '1440']));
    for (const shot of shots) {
      expect(shot.pngPath.startsWith(outDir + sep) || shot.pngPath.startsWith(outDir + '/')).toBe(true);
    }
  });

  it('always passes fullPage: true and uses the breakpoint width for the viewport', async () => {
    const fake = makeFakeBrowser();
    const target: Target = { routes: ['/'], breakpoints: ['375', '1440'] };

    await createPlaywrightCapture({ outDir, browserType: fake.browserType }).capture({
      baseUrl: 'http://localhost:4173',
      target,
    });

    expect(fake.recorded.every((s) => s.fullPage)).toBe(true);
    expect(new Set(fake.recorded.map((s) => s.viewport.width))).toEqual(new Set([375, 1440]));
  });

  it('navigates the page to baseUrl + route for every pair', async () => {
    const fake = makeFakeBrowser();
    const target: Target = { routes: ['/', '/about'], breakpoints: ['375'] };

    await createPlaywrightCapture({ outDir, browserType: fake.browserType }).capture({
      baseUrl: 'http://localhost:4173',
      target,
    });

    const urls = new Set(fake.recorded.map((s) => s.url));
    expect(urls).toEqual(new Set(['http://localhost:4173/', 'http://localhost:4173/about']));
  });

  it('closes browser, context, and page for every pair (no leaks on the happy path)', async () => {
    const fake = makeFakeBrowser();
    const target: Target = { routes: ['/', '/about'], breakpoints: ['375', '1440'] };

    await createPlaywrightCapture({ outDir, browserType: fake.browserType }).capture({
      baseUrl: 'http://localhost:4173',
      target,
    });

    expect(fake.closed.browser).toBe(1);
    expect(fake.closed.contexts).toBe(2); // one per breakpoint
    expect(fake.closed.pages).toBe(4); // one per route × breakpoint
  });

  it('closes the browser even if a page operation throws', async () => {
    const closed = { browser: 0 };
    const browserType: BrowserTypeLike = {
      async launch(): Promise<BrowserLike> {
        return {
          async newContext(): Promise<BrowserContextLike> {
            return {
              async newPage(): Promise<PageLike> {
                return {
                  async goto() {
                    throw new Error('boom');
                  },
                  async screenshot() {
                    return null;
                  },
                  async close() {
                    /* no-op */
                  },
                };
              },
              async close() {
                /* no-op */
              },
            };
          },
          async close() {
            closed.browser += 1;
          },
        };
      },
    };

    await expect(
      createPlaywrightCapture({ outDir, browserType }).capture({
        baseUrl: 'http://localhost:4173',
        target: { routes: ['/'], breakpoints: ['375'] },
      }),
    ).rejects.toThrow('boom');
    expect(closed.browser).toBe(1);
  });

  it('writes PNG names using the configured pngName hook', async () => {
    const fake = makeFakeBrowser();
    await createPlaywrightCapture({
      outDir,
      browserType: fake.browserType,
      pngName: ({ route, breakpoint }) => `iter1-${route.replace(/\//g, '_') || 'root'}-${breakpoint}.png`,
    }).capture({
      baseUrl: 'http://localhost:4173',
      target: { routes: ['/about'], breakpoints: ['375'] },
    });

    const names = fake.recorded.map((s) => s.pngPath.split(/[\\/]/).at(-1));
    expect(names).toEqual(['iter1-_about-375.png']);
  });

  it('creates outDir if it does not exist', async () => {
    const fake = makeFakeBrowser();
    const nested = join(outDir, 'nested', 'subdir');
    await createPlaywrightCapture({ outDir: nested, browserType: fake.browserType }).capture({
      baseUrl: 'http://localhost:4173',
      target: { routes: ['/'], breakpoints: ['375'] },
    });

    const s = await stat(nested);
    expect(s.isDirectory()).toBe(true);
    const entries = await readdir(nested);
    // The fake browser doesn't write bytes, but the dir must exist so a real
    // Playwright screenshot() doesn't ENOENT.
    expect(entries).toBeInstanceOf(Array);
  });
});
