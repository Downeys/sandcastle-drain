# Clean code

Four rules that don't fit anywhere else in the principles folder. Each section: definition, why-it-matters-here, enforcement-or-convention, link to the related file.

These overlap with SOLID (see [architecture.md](architecture.md)) but operate at the level of individual functions and small modules — SOLID describes _how rings and modules relate_; this file describes _what a single function looks like_.

## DRY / YAGNI / KISS

**DRY** — Don't Repeat Yourself. Two copies of the same domain rule are two places to update when the rule changes; one will be missed.

**YAGNI** — You Aren't Gonna Need It. Don't add config knobs, plugin points, or generic abstractions for a second use-case that doesn't yet exist.

**KISS** — Keep It Simple, Stupid. The simpler shape that satisfies the current requirement wins, even when a fancier shape would be defensible.

### Why these matter on this project specifically

This is a personal-use, single-operator project (see [personal-use-tradeoffs.md](personal-use-tradeoffs.md)) being built partially by autonomous agents. Two failure modes loom:

- **Premature abstraction by the agent.** Agents trained on enterprise codebases will reach for plugin systems, dependency-injection containers, and config-driven dispatch on the second example of a pattern. We have one user, one deployment, one of each external service. YAGNI hard.
- **Duplicated domain rules.** A re-derivation of a transition rule or a derived-value formula in two files is a correctness landmine — the system silently disagrees with itself. DRY hard _for domain logic_.

### Enforcement / convention

- **Domain rules live in exactly one place** — the aggregate method that owns the invariant. Use-cases call it; renderers call it; tests assert on it. Re-deriving the rule elsewhere is a review-blocker.
- **Boilerplate duplication (e.g. similar Zod schema shape across DTOs) is fine** — the cost of a wrong abstraction is higher than the cost of two parallel schemas. DRY applies to _meaning_, not syntax.
- **No config-driven branching for hypothetical second cases.** If the project later grows a second LLM provider, second search backend, or second persistence target, _that_ is when the abstraction is added — driven by the second concrete case, not predicted.

Related: [personal-use-tradeoffs.md](personal-use-tradeoffs.md) (the relaxed column is YAGNI by another name), [domain-modeling.md](domain-modeling.md) (the ceremony rule is KISS — only DDD where it pays).

## Small focused functions, low nesting

A function does one thing. Branches stay shallow. If a function needs three levels of indentation to express its logic, the inner branches are usually a separate function waiting to be extracted.

### Why on this project

- **Pure-function unit tests stay cheap** when each function does one thing. A function that fans into four nested ifs has 16 paths; coverage gates (90% line + branch in the domain layer, see [testing.md](testing.md)) start lying.
- **Agent code review benefits from short functions.** A reviewer (human or agent) can hold a 15-line function in working memory and verify it. A 60-line function with nested control flow gets skimmed.
- **Property-based tests (`fast-check`, see [testing.md](testing.md)) shrink poorly** when the unit-under-test mixes side-effects with computation. Small pure functions shrink to minimal failing cases.

### Enforcement (lint config)

ESLint core rules added to [linting-and-tooling.md](linting-and-tooling.md)'s "Specific rules" block:

```jsonc
{
  "max-depth": ["error", 3],
  "complexity": ["error", 10],
  "max-lines-per-function": ["error", { "max": 50, "skipBlankLines": true, "skipComments": true }],
  "max-params": ["error", 4],
}
```

`max-depth: 3` is generous enough for a sane `if / for / try` nesting and tight enough to flag a fourth level. `complexity: 10` (cyclomatic) catches over-branched switches without flagging legitimate state-machine handlers — a typical aggregate's transition switch sits comfortably under 10. `max-lines-per-function: 50` is loose for orchestration in the application layer and tight enough that a domain method past 50 lines is suspicious. `max-params: 4` pushes overflow into a parameter object, which makes the call-site readable and improves Zod-schema-at-the-boundary ergonomics.

These thresholds are starting points; raise a specific rule for a specific function via `// eslint-disable-next-line` _with a comment explaining why_, never globally.

## Composition over inheritance

No `extends` between domain classes. Behavior is shared by composing aggregates, value objects, and pure functions — not by class hierarchies.

### Why on this project

The onion (see [architecture.md](architecture.md)) already gives us composition as the substitution mechanism: the Application layer composes a use-case from a port (interface) and a handful of pure domain functions, then the composition root (`apps/agent`, `apps/api`) wires a concrete adapter to the port. There is no role left for class inheritance to play, and adding one would create a parallel substitution mechanism that fights the port pattern.

Concretely:

- **Domain aggregates are stand-alone classes**, not subclasses. Each aggregate (see [domain-modeling.md](domain-modeling.md)) owns its state and methods directly.
- **Shared behavior across aggregates** — e.g. an append-only versioning pattern — is a function in `packages/domain/` that aggregates _call_, not a base class they extend.
- **Polymorphism uses tagged unions**, not subtyping. Status types are discriminated unions; new variants are new tags, exhaustively checked by `noFallthroughCasesInSwitch` and `@typescript-eslint/switch-exhaustiveness-check` (see [language-and-types.md](language-and-types.md)).
- **Adapters implement ports**; they do not extend a base adapter. If two adapters share helper logic, the helper is a function they both import, not a parent class they both subclass.

### Convention

No ESLint rule enforces this directly — the `functional` plugin from [linting-and-tooling.md](linting-and-tooling.md) discourages classes broadly. The structural enforcement is the ring layout: there is nowhere for an inheritance hierarchy to root that wouldn't either duplicate the port pattern (in Application) or import inward (in External).

## Pure functions and immutability — domain layer only

Functions in `packages/domain/` are pure: same inputs → same outputs, no I/O, no time, no randomness. State they mutate is their own argument, returned, never an external store. Data structures passed across function boundaries are `readonly`.

### Why on this project

- **Domain methods are tested by `fast-check` property-based tests** (see [testing.md](testing.md)). Property-based testing requires referential transparency — a function that reads `Date.now()` or a global cache cannot be shrunk to a minimal failing case.
- **Domain functions are called from multiple call sites** — the use-case that performs the transition, the renderer that previews the next state, the test suite. If the function had I/O, the renderer would either stub the I/O or perform real I/O during a render — both are failure modes.
- **`Clock` and `Random` are ports**, not direct imports (see [architecture.md](architecture.md)'s ports section). The current time and a random seed enter the domain as _arguments_, never as ambient calls.

### Scope: domain only

This rule scopes strictly to `packages/domain/`. The other rings _must_ have side effects:

- **Application** orchestrates I/O via ports — that's its job.
- **External** performs the actual I/O.
- **Presentation** holds React state, browser-side mutability, network calls.

The `functional` ESLint plugin (see [linting-and-tooling.md](linting-and-tooling.md)) is configured to apply its strict immutability rules _only inside `packages/domain/`_ — applying them globally would fight the necessary mutability of UI and adapters.

### Enforcement

- `local/no-throw-in-domain` — already exists, see [linting-and-tooling.md](linting-and-tooling.md).
- `functional/no-let`, `functional/immutable-data`, `functional/no-this-expressions` — apply with `files: ["packages/domain/**"]` override in the ESLint config.
- `readonly` keyword on every aggregate field, every value-object property, every parameter array. Already implied by the existing aggregate examples in [domain-modeling.md](domain-modeling.md).

A pure-function rule cannot be fully lint-enforced (a hand-rolled `Math.random()` call is syntactically fine), so this is partly convention. Code review and property-based tests catch what lint cannot.
