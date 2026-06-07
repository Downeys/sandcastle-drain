/**
 * Real (Playwright-driven) capture seam for the Visual-Iteration Engine.
 *
 * Per ADR 0005 the engine is generic and stack-agnostic: the consumer wires
 * the browser. To keep that promise, this module does **not** import
 * `playwright` directly — it takes a `BrowserTypeLike` argument (the minimal
 * shape we use from `chromium`) and lets the host supply the real one. That
 * also makes the seam unit-testable with a fake browser and keeps `playwright`
 * out of the engine's hard import graph.
 *
 * No screenshot ever leaves the host: PNGs are written into `outDir`
 * (typically the bind-mounted worktree). Agents that consume them read files;
 * they never touch the network. This is the property ADR 0005 calls out as
 * the reason for moving capture off the agent in the first place.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join as pathJoin } from 'node:path';
import type { CaptureSeam, Screenshot, Target } from './types.js';

/**
 * Conventional default — the three breakpoints mentioned in the PRD / ADR 0004.
 * Exported as a convenience for hosts that want the defaults without retyping
 * them; not consulted by the engine itself (the engine takes `Target` and is
 * agnostic to which strings the host puts there).
 */
export const DEFAULT_BREAKPOINTS: readonly string[] = ['375', '768', '1440'];

// ---------------------------------------------------------------------------
// Minimal Playwright-shaped interface
// ---------------------------------------------------------------------------

/**
 * The subset of Playwright's `BrowserType` (e.g. `chromium`) the capture seam
 * actually uses. Defined locally so the engine package does not import
 * `playwright` and so a unit test can supply a fake. Method shapes match
 * Playwright's so passing `chromium` from `playwright` satisfies it without a
 * cast.
 */
export interface BrowserTypeLike {
  launch(options?: { readonly headless?: boolean }): Promise<BrowserLike>;
}

export interface BrowserLike {
  newContext(options?: {
    readonly viewport?: { readonly width: number; readonly height: number };
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface PageLike {
  goto(
    url: string,
    options?: { readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' },
  ): Promise<unknown>;
  screenshot(options: { readonly path: string; readonly fullPage?: boolean }): Promise<unknown>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Accepts a breakpoint as a width string. Tolerates a trailing `px` or
 * `WIDTHxHEIGHT` form (`1440x900`) so a consumer's existing breakpoint
 * vocabulary can flow through unchanged. Throws on garbage rather than
 * silently producing a 0-width viewport.
 */
export function parseBreakpointWidth(breakpoint: string): number {
  const match = /^(\d+)/.exec(breakpoint.trim());
  if (!match) {
    throw new Error(`Cannot parse breakpoint width from ${JSON.stringify(breakpoint)}`);
  }
  const width = Number(match[1]);
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid breakpoint width parsed from ${JSON.stringify(breakpoint)}: ${width}`);
  }
  return width;
}

/**
 * Joins a base URL and a route without collapsing or duplicating slashes. We
 * don't use `new URL(route, base)` because that rebases `/about` relative to
 * the base's directory, dropping any path prefix on the base.
 */
export function joinUrl(baseUrl: string, route: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (route === '' || route === '/') return `${trimmedBase}/`;
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
  return `${trimmedBase}${normalizedRoute}`;
}

/**
 * Default PNG file name: `<sanitised-route>-<breakpoint>.png`. Slashes and
 * other path separators in the route collapse to underscores; the root route
 * becomes `root`.
 */
export function defaultPngName(args: { readonly route: string; readonly breakpoint: string }): string {
  const slug = args.route === '/' || args.route === '' ? 'root' : args.route.replace(/^\/+/, '').replace(/[\\/]+/g, '_');
  return `${slug}-${args.breakpoint}.png`;
}

// ---------------------------------------------------------------------------
// Capture seam factory
// ---------------------------------------------------------------------------

export interface CreatePlaywrightCaptureOptions {
  /**
   * Directory to write PNGs into. Typically a worktree-relative path the
   * agents will later read. Created if missing. Required — the engine has no
   * sensible default and we don't want to clobber `process.cwd()`.
   */
  readonly outDir: string;
  /**
   * Browser launcher. Hosts pass `chromium` (or `firefox` / `webkit`) from
   * `playwright`; tests pass a fake. Injected to keep `playwright` out of the
   * engine's import graph (ADR 0005: the engine is stack-agnostic; the host
   * wires the browser).
   */
  readonly browserType: BrowserTypeLike;
  /**
   * Viewport height used for every breakpoint. Width comes from the
   * breakpoint; height is fixed because we always pass `fullPage: true`, so
   * the rendered area extends past the viewport regardless. Default 900.
   */
  readonly viewportHeight?: number;
  /**
   * Override the default file name. Useful for the engine's iterative loop
   * where the host may want per-iteration names. The default
   * `defaultPngName` overwrites each iteration; that's intentional — the
   * report only references the last set.
   */
  readonly pngName?: (args: { readonly route: string; readonly breakpoint: string }) => string;
}

const DEFAULT_VIEWPORT_HEIGHT = 900;

export function createPlaywrightCapture(opts: CreatePlaywrightCaptureOptions): CaptureSeam {
  const { outDir, browserType, viewportHeight = DEFAULT_VIEWPORT_HEIGHT, pngName = defaultPngName } = opts;

  return {
    async capture({ baseUrl, target }: { readonly baseUrl: string; readonly target: Target }) {
      await mkdir(outDir, { recursive: true });
      const browser = await browserType.launch({ headless: true });
      const screenshots: Screenshot[] = [];
      try {
        for (const breakpoint of target.breakpoints) {
          const width = parseBreakpointWidth(breakpoint);
          const context = await browser.newContext({ viewport: { width, height: viewportHeight } });
          try {
            for (const route of target.routes) {
              const page = await context.newPage();
              try {
                await page.goto(joinUrl(baseUrl, route), { waitUntil: 'networkidle' });
                const fileName = pngName({ route, breakpoint });
                const pngPath = pathJoin(outDir, fileName);
                await mkdir(dirname(pngPath), { recursive: true });
                await page.screenshot({ path: pngPath, fullPage: true });
                screenshots.push({ route, breakpoint, pngPath });
              } finally {
                await page.close();
              }
            }
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
      return screenshots;
    },
  };
}
