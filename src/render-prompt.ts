/**
 * Renders the bundled implementer / reviewer prompt templates with
 * caller-supplied `{{KEY}}` substitutions. The orchestrator passes the result
 * as `prompt: <string>` to `sandcastle.run()` so the host's `.sandcastle/`
 * directory never needs to materialize a `prompt.md` / `reviewer.md` file.
 *
 * Templates live next to the compiled output as `dist/prompts/*.md.tpl` (the
 * `.tpl` suffix is documentary — these are source templates, not finished
 * prompts). The build step (`scripts/copy-library-assets.mjs`) copies them
 * from `src/prompts/` so `import.meta.dirname` resolves identically under tsx
 * (dev) and node (`dist/`).
 *
 * The renderer also handles `{{#if FLAG}}…{{/if}}` blocks so the reviewer
 * rubric can degrade gracefully when host content (CONTEXT.md, docs/adr/) is
 * absent. Conditionals are stripped or retained in a single regex pass before
 * `{{KEY}}` substitution runs; no nesting, no `{{else}}`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PromptName = 'implementer' | 'reviewer';

const PROMPT_FILES: Record<PromptName, string> = {
  implementer: 'implementer.md.tpl',
  reviewer: 'reviewer.md.tpl',
};

const PLACEHOLDER_REGEX = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
const CONDITIONAL_REGEX = /\{\{#if ([A-Z_][A-Z0-9_]*)\}\}([\s\S]*?)\{\{\/if\}\}/g;

/**
 * Resolves `{{#if FLAG}}…{{/if}}` blocks, then replaces every `{{KEY}}` with
 * `vars[KEY]`. Throws if a placeholder or conditional names a key/flag not
 * supplied — silently leaving `{{ISSUE_NUMBER}}` or `{{#if X}}` in a rendered
 * prompt would surface as a confusing agent failure rather than a clear setup
 * error.
 *
 * Conditional blocks are stripped (when the flag is false) before the
 * placeholder pass runs, so placeholders inside a stripped block don't need
 * to appear in `vars`.
 */
export function substitute(
  template: string,
  vars: Record<string, string>,
  flags: Record<string, boolean> = {},
): string {
  const resolved = template.replace(CONDITIONAL_REGEX, (_match, flag: string, body: string) => {
    if (!Object.prototype.hasOwnProperty.call(flags, flag)) {
      throw new Error(`render-prompt: missing template flag {{#if ${flag}}}`);
    }
    return flags[flag] ? body : '';
  });
  return resolved.replace(PLACEHOLDER_REGEX, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`render-prompt: missing template variable {{${key}}}`);
    }
    return vars[key];
  });
}

/**
 * Reads the named prompt template from the library's bundled `prompts/`
 * directory and returns it with `vars` substituted and `flags` resolved. The
 * orchestrator owns the variable + flag contract per template (implementer:
 * ISSUE_NUMBER + ISSUE_TITLE + SIBLING_CONTEXT, no flags; reviewer:
 * ISSUE_NUMBER + BRANCH, plus HAS_CONTEXT_MD + HAS_ADRS).
 */
export async function renderPrompt(
  name: PromptName,
  vars: Record<string, string>,
  flags: Record<string, boolean> = {},
): Promise<string> {
  const libraryRoot = import.meta.dirname;
  const path = join(libraryRoot, 'prompts', PROMPT_FILES[name]);
  const template = await readFile(path, 'utf8');
  return substitute(template, vars, flags);
}
