/**
 * Stages library-bundled markdown into the host project's `.sandcastle/staged/`
 * so the implementer and reviewer agents — running inside per-issue worktrees —
 * can read the canonical principles and agent-docs from inside the sandbox.
 *
 * The orchestrator bind-mounts `<host-cwd>/.sandcastle/staged/` into each
 * per-issue sandbox at the same relative path (read-only), so the agent can
 * `Read .sandcastle/staged/principles/testing.md` from inside the worktree.
 *
 * Prompt templates are NOT staged here — they're rendered in memory by
 * `src/render-prompt.ts` and passed to `sandcastle.run()` as `prompt: <string>`.
 *
 * Library content is resolved relative to `import.meta.dirname`. The build
 * script (`scripts/copy-library-assets.mjs`) copies `src/content/` next to the
 * compiled `dist/stage.js` so the same resolver works under tsx (dev) and node
 * (`dist/`).
 *
 * This module also owns host-rubric-flag detection (`detectRubricFlags`) so the
 * reviewer prompt can degrade gracefully when `CONTEXT.md` or `docs/adr/` are
 * absent or empty. The result is memoized per cwd so a 200-issue drain pays
 * for the disk probes once.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const STAGED_DIR_RELATIVE = '.sandcastle/staged';

/**
 * Absolute POSIX path inside the sandbox where the staged content is mounted.
 * Sandcastle mounts each worktree at /home/agent/workspace (documented in
 * @ai-hero/sandcastle's MountConfig). Passing an absolute POSIX sandboxPath
 * sidesteps sandcastle's platform-native path.resolve, which on Windows
 * mangles relative sandboxPath values into `C:\home\agent\workspace\...`
 * and triggers Docker's "too many colons" mount parser.
 */
export const STAGED_SANDBOX_PATH = '/home/agent/workspace/.sandcastle/staged';

/**
 * Idempotently writes the library's content into `<cwd>/.sandcastle/staged/`.
 * Removes any prior staged tree first so a library upgrade is reflected
 * immediately rather than merged into stale files.
 *
 * Safe to call once per CLI invocation, before the drain loop begins.
 */
export async function stage(cwd: string): Promise<void> {
  const libraryRoot = import.meta.dirname;
  const libraryContent = join(libraryRoot, 'content');

  const stagedDir = join(cwd, STAGED_DIR_RELATIVE);
  const stagedPrinciples = join(stagedDir, 'principles');
  const stagedAgentDocs = join(stagedDir, 'agent-docs');

  await rm(stagedDir, { recursive: true, force: true });
  await mkdir(stagedPrinciples, { recursive: true });
  await mkdir(stagedAgentDocs, { recursive: true });

  await cp(join(libraryContent, 'principles'), stagedPrinciples, { recursive: true });
  await cp(join(libraryContent, 'agent-docs'), stagedAgentDocs, { recursive: true });
}

/**
 * Rubric-availability flags the reviewer template branches on. `hasContextMd`
 * is true when `CONTEXT.md` exists at the host root and is non-empty (an empty
 * stub shouldn't enable the glossary rubric category). `hasAdrs` is true when
 * `docs/adr/` exists at the host root and contains at least one `.md` file
 * other than `README.md`.
 */
export interface HostRubricFlags {
  readonly hasContextMd: boolean;
  readonly hasAdrs: boolean;
}

const rubricFlagsCache = new Map<string, HostRubricFlags>();

/**
 * Detects whether the host project has a populated `CONTEXT.md` and/or
 * non-empty `docs/adr/` directory. Memoized per `cwd` so the reviewer can call
 * this once per issue and only the first call hits disk.
 *
 * Exposed for the orchestrator to pass into the reviewer's prompt rendering.
 * The wrapper does not call this for the implementer prompt — the implementer
 * is supposed to populate CONTEXT.md / ADRs as part of its work and shouldn't
 * be told they're absent.
 */
export function detectRubricFlags(cwd: string): HostRubricFlags {
  const cached = rubricFlagsCache.get(cwd);
  if (cached !== undefined) return cached;
  const result: HostRubricFlags = {
    hasContextMd: hasNonEmptyContextMd(cwd),
    hasAdrs: hasAnyAdr(cwd),
  };
  rubricFlagsCache.set(cwd, result);
  return result;
}

/** Test-only escape hatch: clears the memoization table. */
export function resetRubricFlagsCache(): void {
  rubricFlagsCache.clear();
}

function hasNonEmptyContextMd(cwd: string): boolean {
  const path = join(cwd, 'CONTEXT.md');
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function hasAnyAdr(cwd: string): boolean {
  const dir = join(cwd, 'docs', 'adr');
  if (!existsSync(dir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((name) => name.endsWith('.md') && name !== 'README.md');
}
