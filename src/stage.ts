/**
 * Stages library-bundled markdown into the host project's `.sandcastle/` so
 * the implementer and reviewer agents — running inside per-issue worktrees —
 * can read the canonical principles, agent-docs, and prompt templates.
 *
 * Two surfaces consume the staged tree:
 *
 *   1. The Sandcastle agents themselves, via `copyToWorktree: ['.sandcastle/staged']`
 *      on `run()`. Anything under `<host-cwd>/.sandcastle/staged/` is copied
 *      into the worktree at the same relative path before the sandbox starts,
 *      so the agent can `Read .sandcastle/staged/principles/testing.md` from
 *      inside the worktree.
 *
 *   2. The implementer / reviewer prompt files, which Sandcastle resolves
 *      against the host's `process.cwd()` (see `node_modules/@ai-hero/sandcastle/dist/run.d.ts:116`).
 *      Staging writes `.sandcastle/prompt.md` and `.sandcastle/reviewer.md`
 *      verbatim from the library's `prompts/` so `promptFile: staged.implementerPromptPath`
 *      points at a file that exists in the host.
 *
 * Library content is resolved relative to `import.meta.dirname`. The build
 * script (`scripts/copy-library-assets.mjs`) copies `src/content/` and
 * `src/prompts/` next to the compiled `dist/stage.js` so the same resolver
 * works under tsx (dev) and node (`dist/`).
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const STAGED_DIR_RELATIVE = '.sandcastle/staged';
export const IMPLEMENTER_PROMPT_RELATIVE = '.sandcastle/prompt.md';
export const REVIEWER_PROMPT_RELATIVE = '.sandcastle/reviewer.md';

export interface StageResult {
  /** Path(s) to pass to `run()`'s `copyToWorktree` option. Host-relative. */
  readonly copyToWorktree: readonly string[];
  /** Host-relative path to the implementer prompt file. */
  readonly implementerPromptPath: string;
  /** Host-relative path to the reviewer prompt file. */
  readonly reviewerPromptPath: string;
}

/**
 * Idempotently writes the library's content + prompt templates into
 * `<cwd>/.sandcastle/`. Removes any prior `.sandcastle/staged/` tree first so
 * a library upgrade is reflected immediately rather than merged into stale
 * files.
 *
 * Safe to call once per CLI invocation, before the drain loop begins.
 */
export async function stage(cwd: string): Promise<StageResult> {
  const libraryRoot = import.meta.dirname;
  const libraryContent = join(libraryRoot, 'content');
  const libraryPrompts = join(libraryRoot, 'prompts');

  const stagedDir = join(cwd, STAGED_DIR_RELATIVE);
  const stagedPrinciples = join(stagedDir, 'principles');
  const stagedAgentDocs = join(stagedDir, 'agent-docs');

  await rm(stagedDir, { recursive: true, force: true });
  await mkdir(stagedPrinciples, { recursive: true });
  await mkdir(stagedAgentDocs, { recursive: true });

  await cp(join(libraryContent, 'principles'), stagedPrinciples, { recursive: true });
  await cp(join(libraryContent, 'agent-docs'), stagedAgentDocs, { recursive: true });

  await cp(
    join(libraryPrompts, 'implementer.md'),
    join(cwd, IMPLEMENTER_PROMPT_RELATIVE),
  );
  await cp(
    join(libraryPrompts, 'reviewer.md'),
    join(cwd, REVIEWER_PROMPT_RELATIVE),
  );

  return {
    copyToWorktree: [STAGED_DIR_RELATIVE],
    implementerPromptPath: IMPLEMENTER_PROMPT_RELATIVE,
    reviewerPromptPath: REVIEWER_PROMPT_RELATIVE,
  };
}
