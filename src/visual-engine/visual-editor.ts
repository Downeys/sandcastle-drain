/**
 * Visual editor — the engine's production `EditorSeam`.
 *
 * Per ADR 0005, the editor is a sandboxed agent run modelled on
 * `src/orchestrator/fixer.ts`: render a prompt that batches every finding for
 * the iteration, hand it to `sandcastle.run()` with the worktree mounted
 * read-write, and let the agent commit the polish on the branch. The host
 * loop then rebuilds + recaptures; the critic (a distinct agent, see
 * `slop-check.ts`) re-grades the result.
 *
 * Read-write enforcement, in order of strength:
 *
 *   1. **No `readonly: true` on the worktree mount.** Sandcastle's
 *      `branchStrategy: { type: 'branch', branch }` creates the worktree mount
 *      itself; the default is read-write. We deliberately do not add a
 *      shadowing readonly mount on top of it.
 *   2. **Tool allowance in the prompt's frontmatter.** The editor has
 *      `Read, Grep, Glob, Bash, Edit, Write` — symmetric with the fixer — so
 *      it can edit source, run targeted checks, and `git commit`.
 *   3. **No pre-agent install hook.** Mirrors fixer / slop-check / reviewer.
 *      The wrapper's prior install on this worktree is reused in place; the
 *      editor is a polish pass, not a fresh build.
 *
 * Batching is non-negotiable. One iteration sends *all* of that iteration's
 * findings to the editor in one call; the engine never invokes the seam more
 * than once per iteration. The seam itself enforces this by being a single
 * function call — there is no internal loop here. See `engine.ts` for the
 * loop-level guarantee.
 */
import { run as sandcastleRun, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STAGED_SANDBOX_PATH } from '../stage.js';
import { renderPrompt } from '../render-prompt.js';
import { sandboxPnpmEnv } from '../orchestrator/prereqs.js';
import type { EditorSeam, Finding } from './types.js';

// ---------------------------------------------------------------------------
// Prompt rendering helpers
// ---------------------------------------------------------------------------

/**
 * Builds the markdown block of findings the prompt embeds under
 * `{{FINDINGS_BLOCK}}`. One entry per finding, ordered as given (the critic's
 * own ordering — usually high → medium → low). Each entry includes route,
 * breakpoint, severity, signal, and the critic's suggested fix.
 */
export function buildFindingsBlock(findings: readonly Finding[]): string {
  if (findings.length === 0) return '_(no findings this iteration — nothing to edit)_';
  return findings
    .map((f, i) => {
      return [
        `### ${i + 1}. \`${f.severity}\` — route \`${f.route}\` × breakpoint \`${f.breakpoint}\``,
        '',
        `**Signal:** ${f.signal}`,
        '',
        `**Suggested fix:** ${f.suggestedFix}`,
      ].join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface VisualEditorSandboxConfig {
  readonly imageName: string;
  readonly hostCredsPath: string;
  readonly sandboxCredsPath: string;
  readonly stagedHostPath: string;
  /** Branch the editor commits to. The host's loop has already checked it out
   *  with the prior implementer/fixer commits; the editor's commits land on top. */
  readonly branch: string;
  /** Optional file the wrapper wants the sandcastle log copied to for
   *  post-mortems. */
  readonly visualEditorLogPath?: string;
  readonly idleTimeoutSeconds: number;
  readonly wallClockTimeoutMs: number;
}

export interface RunVisualEditorArgs extends VisualEditorSandboxConfig {
  readonly findings: readonly Finding[];
}

export interface VisualEditorRunResult {
  /** Commits the editor added on top of the prior commits this iteration. */
  readonly commits: readonly { sha: string }[];
  /** Human-readable summary of what changed on disk this iteration. Surfaces
   *  through `IterationReport.diffSummary`. */
  readonly diffSummary: string;
  readonly stdout: string;
  readonly logFilePath: string | undefined;
  /** Non-empty when the sandcastle run threw. */
  readonly runError: string | undefined;
}

/**
 * Seam letting tests inject a fake `sandcastle.run()` so the wiring can be
 * exercised without spinning up Docker. Production callers omit this.
 */
export type SandcastleRunFn = (
  options: Parameters<typeof sandcastleRun>[0],
) => Promise<Awaited<ReturnType<typeof sandcastleRun>>>;

export interface RunVisualEditorDeps {
  readonly runSandcastleRun?: SandcastleRunFn;
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function summarizeCommits(commits: readonly { sha: string }[]): string {
  if (commits.length === 0) return 'editor produced no commits';
  const shas = commits.map((c) => shortSha(c.sha)).join(', ');
  return `editor committed ${commits.length} change(s) on branch: ${shas}`;
}

/**
 * Spawns one Visual editor Sandcastle run for the given batch of findings and
 * returns the commits it produced + a human-readable diff summary.
 *
 * Mirrors `runFixer`: the branch already exists with prior commits — the
 * editor checks it out into a worktree (read-write, per the editor's purpose),
 * sandcastle does *not* run a pre-agent install hook, and the new commits are
 * read from `result.commits`.
 *
 * On any failure (timeout, throw), returns `commits: []` + a non-empty
 * `runError`. The caller (the `EditorSeam` adapter or a CLI) decides how to
 * surface it — the seam throws so the engine's loop aborts visibly; a CLI
 * might prefer to print and exit non-zero.
 */
export async function runVisualEditor(
  args: RunVisualEditorArgs,
  deps: RunVisualEditorDeps = {},
): Promise<VisualEditorRunResult> {
  const run = deps.runSandcastleRun ?? sandcastleRun;

  const prompt = await renderPrompt('visual-editor', {
    FINDINGS_BLOCK: buildFindingsBlock(args.findings),
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
        ],
        // HUSKY=0 / CI=true: kept in sync with fixer.ts / slop-check.ts for
        // parity. A downstream pre-commit hook running inside the editor's
        // `git commit` would silently burn the idle budget. sandboxPnpmEnv()
        // keeps pnpm's virtual store off the Windows host bind mount (no-op
        // elsewhere).
        env: {
          ...sandboxPnpmEnv(),
          HUSKY: '0',
          CI: 'true',
        },
      }),
      prompt,
      // No pre-agent install hook — mirrors fixer.ts. The worktree's prior
      // install is reused in place; the editor is a polish pass.
      branchStrategy: { type: 'branch', branch: args.branch },
      idleTimeoutSeconds: args.idleTimeoutSeconds,
      signal: AbortSignal.timeout(args.wallClockTimeoutMs),
    });
  } catch (err) {
    runError = err;
  }

  const stdout =
    result?.stdout ?? (runError instanceof Error ? runError.message : String(runError ?? ''));
  const commits = result?.commits ?? [];
  const sourceLogPath = result?.logFilePath;

  let copiedLogPath: string | undefined = sourceLogPath;
  if (sourceLogPath !== undefined && args.visualEditorLogPath !== undefined) {
    try {
      await mkdir(dirname(args.visualEditorLogPath), { recursive: true });
      await copyFile(sourceLogPath, args.visualEditorLogPath);
      copiedLogPath = args.visualEditorLogPath;
    } catch (err) {
      console.error(
        `[visual-editor] failed to copy log ${sourceLogPath} → ${args.visualEditorLogPath}:`,
        (err as Error).message,
      );
    }
  }

  return {
    commits,
    diffSummary: summarizeCommits(commits),
    stdout,
    logFilePath: copiedLogPath,
    runError:
      runError !== undefined
        ? runError instanceof Error
          ? runError.message
          : String(runError)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// EditorSeam adapter
// ---------------------------------------------------------------------------

/**
 * Adapts `runVisualEditor` to the engine's `EditorSeam` shape so it can be
 * passed into `runVisualEngine({ editor: ... })`. The sandbox config is
 * captured at construction time; the engine drives the seam once per
 * iteration with the freshly-critiqued `{ findings }`.
 *
 * Run errors are surfaced as thrown `Error`s so the engine's `try/finally`
 * tears down the preview adapter cleanly rather than the loop continuing
 * against an unchanged tree.
 */
export function createVisualEditor(
  config: VisualEditorSandboxConfig,
  deps: RunVisualEditorDeps = {},
): EditorSeam {
  return {
    async edit({ findings }) {
      const result = await runVisualEditor({ ...config, findings }, deps);
      if (result.runError !== undefined) {
        throw new Error(`Visual editor run failed: ${result.runError}`);
      }
      return { diffSummary: result.diffSummary };
    },
  };
}
