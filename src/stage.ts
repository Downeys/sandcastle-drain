/**
 * Stages library-bundled markdown into the host project's `.sandcastle/staged/`
 * so the implementer and reviewer agents — running inside per-issue worktrees —
 * can read the canonical principles and agent-docs from inside the sandbox.
 *
 * Sandcastle copies anything under `<host-cwd>/.sandcastle/staged/` into the
 * worktree at the same relative path before the sandbox starts (via the
 * `copyToWorktree: ['.sandcastle/staged']` option on `run()`). That's how the
 * agent can `Read .sandcastle/staged/principles/testing.md` from inside the
 * worktree.
 *
 * Prompt templates are NOT staged here — they're rendered in memory by
 * `src/render-prompt.ts` and passed to `sandcastle.run()` as `prompt: <string>`.
 *
 * Library content is resolved relative to `import.meta.dirname`. The build
 * script (`scripts/copy-library-assets.mjs`) copies `src/content/` next to the
 * compiled `dist/stage.js` so the same resolver works under tsx (dev) and node
 * (`dist/`).
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const STAGED_DIR_RELATIVE = '.sandcastle/staged';

export interface StageResult {
  /** Path(s) to pass to `run()`'s `copyToWorktree` option. Host-relative. */
  readonly copyToWorktree: readonly string[];
}

/**
 * Idempotently writes the library's content into `<cwd>/.sandcastle/staged/`.
 * Removes any prior staged tree first so a library upgrade is reflected
 * immediately rather than merged into stale files.
 *
 * Safe to call once per CLI invocation, before the drain loop begins.
 */
export async function stage(cwd: string): Promise<StageResult> {
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

  return {
    copyToWorktree: [STAGED_DIR_RELATIVE],
  };
}
