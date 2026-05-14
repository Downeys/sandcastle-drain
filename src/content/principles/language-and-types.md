# Language and types

TypeScript, run on Node, with strict-mode flags maxed and Zod parsing every external boundary.

## Why TS strict + Zod, not Effect-ts

Effect-ts is a stronger guarantee — its type system can refuse to compile code that violates architectural invariants the way TS+Zod cannot. We chose against it for this project because:

- The user is not yet familiar with Effect's `Layer` / `Schema` / `Effect` idioms; learning them alongside building a complex agent + experimenting with memory architectures would compound learning curves.
- For a single-operator personal project, "the lint rules + pre-commit hook + ADR review enforces the architecture" is good enough — _if_ the lint rules and pre-commit hook are taken seriously.

The trade-off: with Effect, the _compiler_ refuses to let you violate the architecture. With TS strict + Zod + ESLint, the _project_ refuses, but only because we wired up the rules to enforce it. If you `// @ts-expect-error` your way past a problem or skip a lint rule, the system rots. **Effect makes that rot impossible; we make it visible.**

Re-examine this choice in an ADR if Effect-ts familiarity grows or if architectural drift becomes painful.

## tsconfig strictness

The project's `tsconfig.json` sets _every_ strictness flag worth setting:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitReturns": true,
    "useUnknownInCatchVariables": true,
  },
}
```

These catch whole classes of agent-introduced bugs. Expect lint failures often early on. **Soften specific rules only if a real false positive shows up — never globally relax for convenience.**

## Branded types for every domain identifier and value object

```ts
// in packages/domain/aggregates/order/order-id.ts
export type OrderId = string & { readonly _brand: 'OrderId' };

export const OrderId = (raw: string): Result<OrderId, ParseError> => {
  // validation here
};
```

- No raw `string` IDs cross a function boundary, ever.
- The factory in `packages/domain` is the _only_ place a brand is minted; consumers receive it pre-validated.
- Branded value objects (e.g. `EmailAddress`, `MoneyUSD`, `Url`) follow the same pattern.

## Zod at every boundary

Anything entering the system from outside our type-checked code gets Zod-parsed. **Parse, don't validate** — the schema generates the type via `z.infer`, so the runtime check and the static type can never disagree.

Boundaries that require Zod parsing:

- LLM output (every structured agent response)
- Database row (every read from a persistent store)
- Web fetch (LLM tool-use results, HTTP responses, JSON APIs)
- HTTP request body / query / params
- Config files / environment variables at startup
- File reads where shape matters

The schemas live next to the code that uses them, in the layer that owns the boundary (External adapters own the persistence schemas; the API owns the HTTP schemas; etc.).

## Tagged unions for fallible operations in the domain layer

`throw` is reserved for _bug, kill the process_ — not for control flow. Domain functions that can fail return:

```ts
type Result<T, E> = { tag: 'ok'; value: T } | { tag: 'err'; error: E };
```

A custom ESLint rule (`local/no-throw-in-domain`, see [linting-and-tooling.md](linting-and-tooling.md)) bans `throw` inside `packages/domain/`. The `application` layer can lift `Result` into thrown errors at the API edge if it wants — but the domain itself stays totally exception-free.

Match on `tag` exhaustively (TS strict + `noFallthroughCasesInSwitch` + `@typescript-eslint/switch-exhaustiveness-check` covers this). A new `tag` variant that isn't handled is a compile error.

## What this enables

- Every dataflow has a `Schema` parse at its boundary — untyped or string-typed agent outputs are a recipe for silent wrong answers.
- Branded IDs prevent accidental cross-aggregate mixing (an `OrderId` cannot be silently passed where a `CustomerId` is expected).
- Tagged-union results force callers to handle both success and failure paths at compile time.

The rest of the architecture (see [architecture.md](architecture.md), [domain-modeling.md](domain-modeling.md)) is built on top of these primitives.
