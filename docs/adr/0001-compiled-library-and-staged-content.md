# 0001 — Compiled library + staged content

## Context

Sandcastle-drain ships as an npm-installable library (`npx sandcastle <subcommand>`). The implementer and reviewer agents it spawns run inside per-issue Sandcastle worktrees and need to read three things at runtime:

- The project's principle files (`src/content/principles/*.md`).
- Agent-facing docs (`src/content/agent-docs/*.md`).
- The implementer and reviewer prompt templates (`src/prompts/{implementer,reviewer}.md`).

These files exist in this repo's source tree, but a host project that installs this package via npm has no `src/content/` or `src/prompts/` directory of its own. Sandcastle's `copyToWorktree` option copies host-relative paths into the per-issue worktree at sandbox start; it does not reach inside the installed package's own files.

In addition, `@ai-hero/sandcastle`'s `run()` resolves `promptFile` against `process.cwd()` (the host project root), not against any other anchor — so prompt files must also live somewhere under the host's tree at run time.

## Decision

Compile to `dist/` and stage library content into the host's `.sandcastle/` at drain time.

1. **Build pipeline.** `npm run build` runs `tsc && node scripts/copy-library-assets.mjs`. The copy step puts `src/content/` and `src/prompts/` next to the compiled `dist/stage.js` so `import.meta.dirname` resolves the assets the same way under tsx (dev) and node (`dist/`).
2. **Runtime staging.** `src/stage.ts` exposes `stage(cwd)`, which the CLI calls once before the drain loop. It copies the library's `content/principles/`, `content/agent-docs/`, and `prompts/*.md` into `<host-cwd>/.sandcastle/staged/{principles,agent-docs}/`, `<host-cwd>/.sandcastle/prompt.md`, and `<host-cwd>/.sandcastle/reviewer.md`. Each call wipes the prior `.sandcastle/staged/` tree so a library upgrade is reflected immediately.
3. **Plumbing.** Each `run()` invocation passes `copyToWorktree: ['.sandcastle/staged']` so the staged tree appears in every worktree. The prompt files are referenced by the same host-relative paths (`.sandcastle/prompt.md`, `.sandcastle/reviewer.md`).
4. **Prompt paths.** Path references inside the prompt templates (e.g. principle filenames the reviewer eager-loads) point at `.sandcastle/staged/principles/...` — what the agent sees from inside the worktree — not the library-source `src/content/principles/...`.

## Consequences

- **Host projects must run `npm run build` before `npm run drain`.** The `tsc` step alone is insufficient; the asset-copy must have run too.
- **`.sandcastle/staged/`, `.sandcastle/prompt.md`, and `.sandcastle/reviewer.md` are runtime artifacts and are gitignored.** A host project should never commit them — they get rewritten every drain.
- **Prompt path references are decoupled from this repo's directory layout.** Renaming `src/content/principles/` here would not break agents in host projects; only the prompt body's `.sandcastle/staged/principles/...` references need to stay stable.
- **A single source of truth for the staged-tree path strings.** `STAGED_DIR_RELATIVE`, `IMPLEMENTER_PROMPT_RELATIVE`, and `REVIEWER_PROMPT_RELATIVE` are exported from `src/stage.ts` and imported by `main.ts` and `reviewer.ts`; the strings are not duplicated.
