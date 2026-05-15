# 0001 — Compiled library + staged content

## Context

Sandcastle-drain ships as an npm-installable library (`npx sandcastle <subcommand>`). The implementer and reviewer agents it spawns run inside per-issue Sandcastle worktrees and need to read three things at runtime:

- The project's principle files (`src/content/principles/*.md`).
- Agent-facing docs (`src/content/agent-docs/*.md`).
- The implementer and reviewer prompt templates (`src/prompts/{implementer,reviewer}.md.tpl`).

These files exist in this repo's source tree, but a host project that installs this package via npm has no `src/content/` or `src/prompts/` directory of its own. Sandcastle's sandbox mounts host-relative paths into the per-issue worktree at sandbox start; that mechanism does not reach inside the installed package's own files.

Prompt templates are passed to `@ai-hero/sandcastle`'s `run()` as `prompt: <string>` (a verified-supported alternative to `promptFile`), so they only need to be readable from within this library's own bundled assets — not staged onto the host filesystem.

## Decision

Compile to `dist/` and stage library content into the host's `.sandcastle/staged/` at drain time. Render prompts in memory and pass them as inline strings.

1. **Build pipeline.** `npm run build` runs `tsc && node scripts/copy-library-assets.mjs`. The copy step puts `src/content/` and `src/prompts/` next to the compiled `dist/stage.js` so `import.meta.dirname` resolves the assets the same way under tsx (dev) and node (`dist/`).
2. **Runtime staging.** `src/stage.ts` exposes `stage(cwd)`, which the CLI calls once before the drain loop. It copies the library's `content/principles/` and `content/agent-docs/` into `<host-cwd>/.sandcastle/staged/{principles,agent-docs}/`. Each call wipes the prior `.sandcastle/staged/` tree so a library upgrade is reflected immediately.
3. **Prompt rendering.** `src/render-prompt.ts` reads the bundled `dist/prompts/{implementer,reviewer}.md.tpl`, substitutes simple `{{KEY}}` placeholders, and returns the rendered string. The orchestrator passes the result as `prompt: <string>` to `sandcastle.run()`. The host's `.sandcastle/` directory never sees a `prompt.md` / `reviewer.md` file.
4. **Plumbing.** Each `run()` invocation bind-mounts `<host-cwd>/.sandcastle/staged/` into the sandbox at the same relative path, read-only, via sandcastle's docker `mounts` option. The agent sees `.sandcastle/staged/...` from inside the worktree exactly as if it had been copied in.
5. **Prompt path references.** Path references inside the prompt templates (e.g. principle filenames the reviewer eager-loads) point at `.sandcastle/staged/principles/...` — what the agent sees from inside the worktree — not the library-source `src/content/principles/...`.

## Update (2026-05-14)

Staged content is delivered to the sandbox as a **read-only bind-mount**, not via `copyToWorktree`. The mount semantics are identical from the agent's perspective (same path, same contents), but the mount avoids `@ai-hero/sandcastle`'s `CopyToWorktree` codepath, which hardcodes a Unix `cp` spawn with no `process.platform` branch and therefore fails on Windows with `spawn cp ENOENT`. The bind-mount works cross-platform without depending on an upstream fix. `STAGED_DIR_RELATIVE` is still the single source of truth for both the host path and the sandbox path; the orchestrator passes `mounts: [{ hostPath: join(REPO_ROOT, STAGED_DIR_RELATIVE), sandboxPath: STAGED_DIR_RELATIVE, readonly: true }]` to `docker()`.

## Consequences

- **Host projects must run `npm run build` before `npm run drain`.** The `tsc` step alone is insufficient; the asset-copy must have run too.
- **`.sandcastle/staged/` is a runtime artifact and is gitignored.** A host project should never commit it — it gets rewritten every drain. No prompt files materialize on the host filesystem at all.
- **Prompt path references are decoupled from this repo's directory layout.** Renaming `src/content/principles/` here would not break agents in host projects; only the prompt body's `.sandcastle/staged/principles/...` references need to stay stable.
- **A single source of truth for the staged-tree path string.** `STAGED_DIR_RELATIVE` is exported from `src/stage.ts` and imported by `main.ts` and `reviewer.ts`.
- **Per-template variable contracts live with the orchestrator.** The implementer call site supplies `ISSUE_NUMBER`, `ISSUE_TITLE`, `SIBLING_CONTEXT`; the reviewer call site supplies `ISSUE_NUMBER`, `BRANCH`. `render-prompt.ts` throws if a template references a `{{KEY}}` the caller didn't supply.
