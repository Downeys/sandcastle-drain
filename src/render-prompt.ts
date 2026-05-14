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
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PromptName = 'implementer' | 'reviewer';

const PROMPT_FILES: Record<PromptName, string> = {
  implementer: 'implementer.md.tpl',
  reviewer: 'reviewer.md.tpl',
};

const PLACEHOLDER_REGEX = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

/**
 * Replaces every `{{KEY}}` in `template` with `vars[KEY]`. Throws if a
 * placeholder appears in the template but not in `vars` — silently leaving
 * `{{ISSUE_NUMBER}}` in a rendered prompt would surface as a confusing agent
 * failure rather than a clear setup error.
 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_REGEX, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`render-prompt: missing template variable {{${key}}}`);
    }
    return vars[key];
  });
}

/**
 * Reads the named prompt template from the library's bundled `prompts/`
 * directory and returns it with `vars` substituted. The orchestrator owns the
 * variable contract per template (implementer: ISSUE_NUMBER + ISSUE_TITLE +
 * SIBLING_CONTEXT; reviewer: ISSUE_NUMBER + BRANCH).
 */
export async function renderPrompt(
  name: PromptName,
  vars: Record<string, string>,
): Promise<string> {
  const libraryRoot = import.meta.dirname;
  const path = join(libraryRoot, 'prompts', PROMPT_FILES[name]);
  const template = await readFile(path, 'utf8');
  return substitute(template, vars);
}
