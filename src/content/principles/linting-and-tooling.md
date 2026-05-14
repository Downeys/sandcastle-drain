# Linting and tooling

ESLint + typescript-eslint + Prettier + custom local rules. Pre-commit hook via Husky + lint-staged. No `--no-verify` ever.

## Why ESLint, not Biome

Three reasons we picked ESLint:

1. **`eslint-plugin-boundaries` is non-negotiable.** Our entire onion architecture (see [architecture.md](architecture.md)) relies on a real boundary-enforcement plugin. Biome does not have an equivalent. Without lint-enforced boundaries, the layers become honor-system, and we already decided we cannot afford honor-system on architecture rules in autonomous Sandcastle runs.
2. **Custom rules are easier in ESLint.** We need three (`no-throw-in-domain`, `no-anemic-aggregate`, `domain-names-match-context-md`). In ESLint these are 50–150 lines of TypeScript each; in Biome they require GritQL or Rust.
3. **Speed isn't the bottleneck on a personal project.** Biome's main pitch is speed at scale. With ~50–100 source files, ESLint's 10–30s runs are fine. `oxlint` can be added as a fast pre-pass later if it becomes annoying.

Re-examine in an ADR if Biome's plugin ecosystem catches up or our project size grows past ESLint's comfort zone.

## Plugin set

```jsonc
{
  "plugins": [
    "@typescript-eslint",
    "boundaries", // onion-direction
    "functional", // immutability, no let, readonly fields
    "unicorn", // sane defaults beyond ESLint core
    "vitest", // test-file rules
  ],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/strict-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
  ],
}
```

## Specific rules to enable

```jsonc
{
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/strict-boolean-expressions": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/consistent-type-imports": "error",
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/no-throw-literal": "error",

  "max-depth": ["error", 3],
  "complexity": ["error", 10],
  "max-lines-per-function": ["error", { "max": 50, "skipBlankLines": true, "skipComments": true }],
  "max-params": ["error", 4],
}
```

The four `max-*` / `complexity` rules are the structural enforcement of the small-functions rule in [clean-code.md](clean-code.md). Thresholds are intentionally tight; loosen one rule for one function with a `// eslint-disable-next-line` comment that explains why, never globally.

## Boundary enforcement

```jsonc
"boundaries/element-types": ["error", {
  "default": "disallow",
  "rules": [
    { "from": "domain",       "allow": ["domain"] },
    { "from": "application",  "allow": ["domain", "application"] },
    { "from": "external",     "allow": ["domain", "application", "external"] },
    { "from": "presentation", "allow": ["*"] }
  ]
}]
```

`boundaries/elements` maps folders to ring labels. Any inner-from-outer import is a hard error. No exemptions, no `// eslint-disable`. If a violation feels necessary, the right move is to define a port in `packages/application/`.

## Three custom local rules

Live in `tools/eslint-rules/` (TypeScript, simple AST walks). Loaded via `eslint-plugin-local-rules` or equivalent.

### `local/no-throw-in-domain`

Bans `throw` (statement and expression) inside `packages/domain/**`. Domain functions return `Result<T, E>` per [language-and-types.md](language-and-types.md). `throw` is reserved for "bug, kill the process" and only appears at the application boundary or above.

### `local/no-anemic-aggregate`

Fails any class exported from `packages/domain/aggregates/**` whose body has only a constructor and getters with no behavioral methods. Aggregates carry their invariants in their behavior; a data-only class belongs in `packages/domain/dtos/` instead. DTOs are explicitly exempt.

### `local/domain-names-match-context-md`

Parses `CONTEXT.md` headings and fails any export from `packages/domain/aggregates/` or `packages/domain/value-objects/` whose name does not appear there. Silent until `CONTEXT.md` is populated — the template ships with a stub.

## Prettier

Formatting only. `eslint-config-prettier` disables the stylistic rules that overlap with Prettier so the two never argue. Run via the same pre-commit hook.

```jsonc
// .prettierrc
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
}
```

## Pre-commit hook (Husky + lint-staged)

`.husky/pre-commit` runs:

1. `pnpm tsc --noEmit` (or `npm run typecheck`) — full project typecheck
2. `lint-staged` — ESLint + Prettier on changed files
3. `vitest related --run` on changed test files
4. **In `packages/domain/`**: coverage check (90% gate, 95% target — line + branch)

**Never `--no-verify`.** If a hook fails, fix the underlying issue. The global CLAUDE.md already records this rule; it stays here too because it's load-bearing for autonomous Sandcastle runs where there's no human reviewer to catch a skipped hook.

If a hook is genuinely too slow (e.g. > 30s on small commits), the right move is to make the hook faster (cache TS server, scope ESLint to staged files, reduce Vitest's "related" scope) — _not_ to skip it.

## Strictness expectation

`@typescript-eslint/strict-type-checked` is genuinely strict — it catches `if (someString)` ambiguity, requires explicit `boolean` checks, etc. **Strict from day one. Soften specific rules only if a real false positive shows up — never globally relax for convenience.** Expect lint failures often early on; treat each as feedback, not friction.

## What lives outside this doc

- The actual `.eslintrc.*` and `tsconfig.json` files don't exist yet — they're queued as follow-up Sandcastle issues. This doc is the spec the issue implements.
- The custom rule implementations live in `tools/eslint-rules/`, also queued as follow-up issues.
- `pg_dump` / backup scheduling lives in [personal-use-tradeoffs.md](personal-use-tradeoffs.md), not here.
