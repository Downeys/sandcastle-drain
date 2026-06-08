/**
 * Slop-Check critic — the engine's production `CriticSeam`.
 *
 * Per ADR 0005, Slop-Check is a sandboxed agent run modelled on
 * `src/orchestrator/reviewer.ts`: render a prompt, hand it to
 * `sandcastle.run()`, and parse a fenced JSON verdict from stdout. The
 * separation from the editor is deliberate (no edit history → no
 * self-rationalisation), and the critic is exposed as a standalone entry
 * point so it can audit any rendered target outside the iteration loop.
 *
 * Read-only enforcement, in order of strength:
 *
 *   1. **Captures dir mounted `readonly: true`.** The captured PNGs the critic
 *      reads live on a `MountConfig` with the read-only flag set — a
 *      filesystem-level guarantee, not a prompt instruction. A write attempt
 *      against that mount fails at the kernel with EROFS.
 *   2. **Tool restriction in the prompt's frontmatter.** The critic only has
 *      `Read`, `Grep`, `Glob` — no `Edit`, `Write`, or `Bash` — so even
 *      against a writable directory the agent has no tool to mutate it.
 *   3. **No pre-agent install hook.** Mirrors the reviewer (also hook-free).
 *      The critic never builds, never installs, never `git commit`s.
 */
import { run as sandcastleRun, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STAGED_SANDBOX_PATH } from '../stage.js';
import { renderPrompt } from '../render-prompt.js';
import { sandboxPnpmEnv } from '../orchestrator/prereqs.js';
import type { CriticSeam, Finding, Rubric, Screenshot, Severity } from './types.js';

/**
 * Where the screenshots host directory is mounted inside the sandbox.
 * Absolute POSIX path so sandcastle does not try to resolve it relative to
 * the worktree (matches the convention used for `STAGED_SANDBOX_PATH`).
 */
export const SLOP_CHECK_CAPTURES_SANDBOX_PATH = '/home/agent/captures';

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const FENCED_JSON_REGEX = /```json\s*\n([\s\S]*?)\n```/g;
const VALID_SEVERITIES = new Set<Severity>(['high', 'medium', 'low']);

export type SlopCheckParseResult =
  | { ok: true; value: readonly Finding[] }
  | { ok: false; reason: string };

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function parseOneFinding(raw: unknown): Finding | string {
  if (raw === null || typeof raw !== 'object') return 'finding is not an object';
  const f = raw as Record<string, unknown>;
  if (!isString(f.signal)) return 'signal must be a string';
  if (!isString(f.severity) || !VALID_SEVERITIES.has(f.severity as Severity)) {
    return `severity must be one of ${[...VALID_SEVERITIES].join('|')}; got ${JSON.stringify(f.severity)}`;
  }
  if (!isString(f.breakpoint)) return 'breakpoint must be a string';
  if (!isString(f.route)) return 'route must be a string';
  if (!isString(f.suggestedFix)) return 'suggestedFix must be a string';
  return {
    signal: f.signal,
    severity: f.severity as Severity,
    breakpoint: f.breakpoint,
    route: f.route,
    suggestedFix: f.suggestedFix,
  };
}

/**
 * Extracts the *last* fenced ```json``` block from the critic's stdout and
 * schema-validates it into `Finding[]`. The last-block rule mirrors the
 * reviewer parser: an agent may include an example JSON block earlier in its
 * thinking; the final answer is always the last one.
 *
 * Malformed output (no fence, invalid JSON, wrong shape, bad severity) is
 * surfaced as `{ ok: false, reason }` — never silently dropped. The caller
 * decides whether to throw, retry, or post an error comment.
 */
export function parseSlopCheckOutput(stdout: string): SlopCheckParseResult {
  const matches = [...stdout.matchAll(FENCED_JSON_REGEX)];
  if (matches.length === 0) {
    return { ok: false, reason: 'no fenced ```json``` block found in critic output' };
  }
  const rawJson = matches[matches.length - 1][1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false,
      reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'top-level JSON value is not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    return { ok: false, reason: 'findings must be an array' };
  }
  const findings: Finding[] = [];
  for (let i = 0; i < obj.findings.length; i++) {
    const r = parseOneFinding(obj.findings[i]);
    if (typeof r === 'string') {
      return { ok: false, reason: `findings[${i}]: ${r}` };
    }
    findings.push(r);
  }
  return { ok: true, value: findings };
}

// ---------------------------------------------------------------------------
// Prompt rendering helpers
// ---------------------------------------------------------------------------

/**
 * Re-anchors a screenshot's host path at the sandbox mount point. The host
 * writes PNGs under `screenshotsHostDir`; that directory gets mounted
 * read-only at `sandboxMountPath` inside the sandbox. The critic only knows
 * the sandbox path, so we translate before embedding in the prompt.
 *
 * Paths outside the mounted directory pass through unchanged — surfacing as
 * a clear "file not found" in the critic's `Read` tool rather than a silent
 * mistranslation.
 */
export function translateCapturePath(
  pngHostPath: string,
  screenshotsHostDir: string,
  sandboxMountPath: string = SLOP_CHECK_CAPTURES_SANDBOX_PATH,
): string {
  const host = screenshotsHostDir.endsWith('/')
    ? screenshotsHostDir.slice(0, -1)
    : screenshotsHostDir;
  const sandbox = sandboxMountPath.endsWith('/')
    ? sandboxMountPath.slice(0, -1)
    : sandboxMountPath;
  if (pngHostPath === host) return sandbox;
  if (pngHostPath.startsWith(`${host}/`)) {
    return `${sandbox}/${pngHostPath.slice(host.length + 1)}`;
  }
  return pngHostPath;
}

/**
 * Builds the markdown list of (route × breakpoint → sandbox PNG path) the
 * prompt embeds under `{{SCREENSHOTS_BLOCK}}`.
 */
export function buildScreenshotsBlock(
  screenshots: readonly Screenshot[],
  screenshotsHostDir: string,
  sandboxMountPath: string = SLOP_CHECK_CAPTURES_SANDBOX_PATH,
): string {
  if (screenshots.length === 0) return '_(no screenshots captured this iteration)_';
  return screenshots
    .map((s) => {
      const sandboxPath = translateCapturePath(s.pngPath, screenshotsHostDir, sandboxMountPath);
      return `- route \`${s.route}\` × breakpoint \`${s.breakpoint}\` → \`${sandboxPath}\``;
    })
    .join('\n');
}

/**
 * Serialises the (opaque) rubric for embedding under `{{RUBRIC_BLOCK}}`.
 * Strings pass through unchanged; everything else is JSON-stringified with
 * two-space indent so a structured rubric stays human-readable in the
 * rendered prompt.
 */
export function formatRubric(rubric: Rubric): string {
  if (rubric === undefined || rubric === null) return '_(no rubric supplied)_';
  if (typeof rubric === 'string') return rubric;
  try {
    return JSON.stringify(rubric, null, 2);
  } catch {
    return String(rubric);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface SlopCheckSandboxConfig {
  readonly imageName: string;
  readonly hostCredsPath: string;
  readonly sandboxCredsPath: string;
  readonly stagedHostPath: string;
  /** Branch the critic checks out into its worktree. Mirrors the reviewer:
   *  same branch the editor committed to. */
  readonly branch: string;
  /** Host directory containing the captured PNGs. Mounted read-only at
   *  `SLOP_CHECK_CAPTURES_SANDBOX_PATH`. */
  readonly screenshotsHostDir: string;
  /** Optional file the wrapper wants the sandcastle log copied to for
   *  post-mortems. */
  readonly slopCheckLogPath?: string;
  readonly idleTimeoutSeconds: number;
  readonly wallClockTimeoutMs: number;
}

export interface RunSlopCheckArgs extends SlopCheckSandboxConfig {
  readonly screenshots: readonly Screenshot[];
  readonly rubric: Rubric;
}

export interface SlopCheckRunResult {
  /** Parsed findings when stdout contained a well-formed JSON verdict. */
  readonly findings: readonly Finding[] | undefined;
  /** Non-empty when the run threw or stdout did not parse. */
  readonly parseError: string | undefined;
  readonly stdout: string;
  readonly logFilePath: string | undefined;
}

/**
 * Seam letting tests inject a fake `sandcastle.run()` so the wiring can be
 * exercised without spinning up Docker. Production callers omit this.
 */
export type SandcastleRunFn = (
  options: Parameters<typeof sandcastleRun>[0],
) => Promise<Awaited<ReturnType<typeof sandcastleRun>>>;

export interface RunSlopCheckDeps {
  readonly runSandcastleRun?: SandcastleRunFn;
}

/**
 * Spawns one Slop-Check Sandcastle run for the given screenshots + rubric and
 * returns its parsed findings.
 *
 * Mirrors `runReviewer`: the branch already exists with the editor's
 * commits — the critic checks it out into a separate worktree, sandcastle
 * does *not* run a pre-agent install hook, and stdout is parsed for the
 * fenced JSON verdict. The captured PNGs come from `screenshotsHostDir`,
 * mounted read-only at `SLOP_CHECK_CAPTURES_SANDBOX_PATH`.
 *
 * On any failure (timeout, missing JSON, throw), returns
 * `findings: undefined` + a non-empty `parseError`. The caller (engine or
 * CLI) decides how to surface it — the `CriticSeam` adapter throws so the
 * loop aborts visibly; a CLI might prefer to print and exit non-zero.
 */
export async function runSlopCheck(
  args: RunSlopCheckArgs,
  deps: RunSlopCheckDeps = {},
): Promise<SlopCheckRunResult> {
  const run = deps.runSandcastleRun ?? sandcastleRun;

  const prompt = await renderPrompt('slop-check', {
    SCREENSHOTS_BLOCK: buildScreenshotsBlock(args.screenshots, args.screenshotsHostDir),
    RUBRIC_BLOCK: formatRubric(args.rubric),
  });

  let result: Awaited<ReturnType<typeof sandcastleRun>> | undefined;
  let runError: unknown;
  try {
    result = await run({
      agent: claudeCode('claude-opus-4-7'),
      sandbox: docker({
        imageName: args.imageName,
        mounts: [
          { hostPath: args.hostCredsPath, sandboxPath: args.sandboxCredsPath },
          { hostPath: args.stagedHostPath, sandboxPath: STAGED_SANDBOX_PATH, readonly: true },
          {
            hostPath: args.screenshotsHostDir,
            sandboxPath: SLOP_CHECK_CAPTURES_SANDBOX_PATH,
            readonly: true,
          },
        ],
        env: {
          ...sandboxPnpmEnv(),
          HUSKY: '0',
          CI: 'true',
        },
      }),
      prompt,
      // No pre-agent install hook — mirrors reviewer.ts. The critic never
      // builds or installs; the worktree's existing install (if any) is
      // reused in place.
      branchStrategy: { type: 'branch', branch: args.branch },
      idleTimeoutSeconds: args.idleTimeoutSeconds,
      signal: AbortSignal.timeout(args.wallClockTimeoutMs),
    });
  } catch (err) {
    runError = err;
  }

  const stdout =
    result?.stdout ?? (runError instanceof Error ? runError.message : String(runError ?? ''));
  const sourceLogPath = result?.logFilePath;

  let copiedLogPath: string | undefined = sourceLogPath;
  if (sourceLogPath !== undefined && args.slopCheckLogPath !== undefined) {
    try {
      await mkdir(dirname(args.slopCheckLogPath), { recursive: true });
      await copyFile(sourceLogPath, args.slopCheckLogPath);
      copiedLogPath = args.slopCheckLogPath;
    } catch (err) {
      console.error(
        `[slop-check] failed to copy log ${sourceLogPath} → ${args.slopCheckLogPath}:`,
        (err as Error).message,
      );
    }
  }

  if (runError !== undefined && result === undefined) {
    return {
      findings: undefined,
      parseError: `slop-check run threw: ${runError instanceof Error ? runError.message : String(runError)}`,
      stdout,
      logFilePath: copiedLogPath,
    };
  }

  const parsed = parseSlopCheckOutput(stdout);
  if (!parsed.ok) {
    return {
      findings: undefined,
      parseError: parsed.reason,
      stdout,
      logFilePath: copiedLogPath,
    };
  }

  return {
    findings: parsed.value,
    parseError: undefined,
    stdout,
    logFilePath: copiedLogPath,
  };
}

// ---------------------------------------------------------------------------
// CriticSeam adapter
// ---------------------------------------------------------------------------

/**
 * Adapts `runSlopCheck` to the engine's `CriticSeam` shape so it can be
 * passed into `runVisualEngine({ critic: ... })`. The sandbox config is
 * captured at construction time; the engine drives the seam once per
 * iteration with the freshly-captured `{ screenshots, rubric }`.
 *
 * Malformed output is surfaced as a thrown `Error` (per the issue AC:
 * "malformed output is surfaced as an error, not silently dropped"). The
 * engine's `try/finally` around the loop tears down the preview adapter
 * cleanly.
 */
export function createSlopCheckCritic(
  config: SlopCheckSandboxConfig,
  deps: RunSlopCheckDeps = {},
): CriticSeam {
  return {
    async critique({ screenshots, rubric }) {
      const result = await runSlopCheck({ ...config, screenshots, rubric }, deps);
      if (result.findings === undefined) {
        throw new Error(
          `Slop-Check critic produced no parseable output: ${result.parseError ?? 'unknown error'}`,
        );
      }
      return result.findings;
    },
  };
}
