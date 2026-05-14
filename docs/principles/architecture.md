# Architecture

Onion architecture, four rings. Dependencies always point inward. Lint-enforced via `eslint-plugin-boundaries`.

## The four rings

| Ring             | Folder(s)                                           | Knows about                                                                                  | Tests                                                                                                                   |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Domain**       | `packages/domain/`                                  | Nothing else. Zero framework imports, zero I/O.                                              | Pure unit tests, fast (<1s suite), property-based for state machines and math via `fast-check`                          |
| **Application**  | `packages/application/`                             | Domain only. Defines **ports** (TS interfaces) for everything it needs from outside.         | Use-case tests with in-memory port stubs (no DB, no LLM, no network)                                                    |
| **External**     | `packages/external/{db,llm,…}`                      | Application + Domain. **Implements** the ports defined by Application.                       | Integration tests against real services where reasonable (testcontainers for databases, recorded fixtures for paid APIs) |
| **Presentation** | `apps/{ui,api,agent}`                               | All inner rings + the composition root. Wires External implementations to Application ports. | E2E with Playwright on the golden flow                                                                                  |

**Inner rings know nothing of outer rings.** Domain has no imports of Application; Application has no imports of External; External has no imports of Presentation. Presentation is the composition root and may import everything.

## Dependency direction is enforced, not aspired

The honor system does not work for autonomous Sandcastle runs. ESLint enforces:

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

Any inner→outer import is a hard lint failure. No exemptions. If a violation feels necessary, that's a signal a port is missing in `packages/application/` — add the port, don't break the rule.

## What lives where

- **`packages/domain/aggregates/*`** — domain entities with private state, public methods, `Result<T,E>` returns, invariants enforced inside the methods. Aggregates own their child entities and value objects. Anemic-model-banned by ESLint (see [linting-and-tooling.md](linting-and-tooling.md)).
- **`packages/domain/dtos/*`** — transport/log/cache shapes as Zod schemas + plain functions. Anemic by design; exempt from the no-anemic-aggregate rule.
- **`packages/domain/value-objects/*`** — branded value objects (e.g. `Money`, `EmailAddress`, `BrandedUrl`).
- **`packages/application/use-cases/*`** — orchestration; one file per use case; depends on Domain and on ports it defines.
- **`packages/application/ports/*`** — TS interfaces describing what Application needs (a `ThingRepository`, an `LlmClient`, a `Clock`, a `Random`).
- **`packages/external/<adapter>/*`** — implementations of the ports. One folder per logical adapter.
- **`apps/api/*`** — HTTP layer (Hono or similar). Translates HTTP↔domain; runs Zod request/response schemas.
- **`apps/ui/*`** — React. Talks to the API. Plain TS, Zod for form validation.
- **`apps/agent/*`** — composition root for any agent runtime. Wires ports to External implementations. _Does not contain orchestration logic — that lives in `packages/application`._

## Where the API's layers live

A common point of confusion: looking at `apps/api/` alone, the "application layer" and "infrastructure layer" appear missing. They are not — they live in the workspace, not under `apps/api/`. The mapping for the HTTP API is:

| Onion ring     | Location                                           | What's there                                                                                                                                |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Presentation   | `apps/api/routes/*.ts`                             | Thin route handlers. Parse request (Zod), call a use-case from `@your-project/application`, map errors via `error-mapper.ts`, return JSON. |
| Composition    | `apps/api/composition-root.ts`, `apps/api/main.ts` | Instantiates External adapters, binds them to Application ports, hands dependency objects to use-cases. Only place concretes meet ports.    |
| Application    | `packages/application/use-cases/*`                 | Orchestration. One file per use-case. Takes ports as arguments; returns `Result<T, E>`.                                                     |
| Application    | `packages/application/ports/*`                     | TS interfaces that use-cases depend on.                                                                                                     |
| External       | `packages/external/<adapter>/*`                    | Implementations of the ports.                                                                                                               |
| Domain         | `packages/domain/aggregates/*`                     | Aggregates with behavior. No I/O, no framework.                                                                                             |

If business logic appears inside `apps/api/routes/*.ts`, that's a layering bug — it belongs in a use-case under `packages/application/use-cases/`. Routes orchestrate _HTTP_; use-cases orchestrate _domain operations_. The two never collapse into one file.

### End-to-end trace: an example `POST /api/things`

1. `apps/api/routes/things.ts` — Zod-parses the request body, calls `createThing({ name, ... })`.
2. `packages/application/use-cases/thing/create-thing.ts` — validates inputs via domain value-object constructors, checks duplicates via `repo.loadByName()`, constructs the aggregate via `Thing.create()`, persists via `repo.save()`. Returns `Result<ThingSnapshot, CreateThingError>`.
3. `packages/domain/aggregates/thing/thing.ts` — `Thing.create()` enforces invariants and returns the aggregate.
4. `packages/external/thing-store-<backend>/thing-repository.ts` — `save()` writes the underlying store.
5. `apps/api/error-mapper.ts` — maps any `Err` variant from step 2 to an HTTP status code.
6. `apps/api/routes/things.ts` — serializes the success snapshot to JSON.

Each step lives in its named ring. No step reaches across rings except via the explicit dependency injection at `composition-root.ts`.

## Folder scaffolding is created lazily

This principles doc describes what these folders _will be_. The folders themselves are created when the first product issue needs them — not pre-created here. Pre-creating empty folders with placeholder code lies about what the project knows.

When the first product issue lands and the agent needs `packages/domain/`, it scaffolds:

- `packages/domain/package.json` (workspace member)
- `packages/domain/tsconfig.json` (extends root with `composite: true`)
- `packages/domain/index.ts` (just exports)
- The aggregate / dto / value-object subfolders only as needed

Same pattern for `packages/application/`, `packages/external/<adapter>/`, and the apps.

## Ports define the dependency _inversion_

The Application layer defines what it needs as TypeScript interfaces. External adapters implement those interfaces. This is the heart of why Domain stays pure: it never imports a database driver, an HTTP client, or an LLM SDK.

Example shape:

```ts
// packages/application/ports/thing-repository.ts
import type { Thing, ThingId } from '../../domain/index.ts';

export interface ThingRepository {
  save(thing: Thing): Promise<Result<ThingId, RepositoryError>>;
  load(id: ThingId): Promise<Result<Thing, RepositoryError>>;
  listByOwner(ownerId: OwnerId): Promise<Result<readonly Thing[], RepositoryError>>;
}
```

The External adapter (`packages/external/thing-store-<backend>/`) implements `ThingRepository` against actual storage. The Application use-case takes `ThingRepository` by constructor injection or function argument. Tests use an in-memory implementation.

## Composition root

`apps/agent` (and `apps/api`) wire the External implementations to the Application ports at startup. This is the _only_ place concrete implementations are bound to interfaces — every other layer takes ports as dependencies.

No service locators, no singletons, no module-level mutable state. Dependencies are explicit, passed in, and replaceable at the composition root.

## SOLID, named against this onion

The onion already encodes SOLID; this section attaches the names so reviews can refer to them. Each principle here is _grounded in a structural pattern of this codebase_, not taught generically.

**S — Single Responsibility.** One reason to change per module. Aggregates own invariants for one concept; use-cases orchestrate one workflow each (`packages/application/use-cases/*`); adapters wrap one external service each (`packages/external/<adapter>/`). Enforced structurally by the ring/folder layout above and the custom `local/no-anemic-aggregate` rule in [linting-and-tooling.md](linting-and-tooling.md) — a class doing nothing but holding data is structurally a DTO, not an aggregate.

**O — Open/Closed.** New behavior arrives as new files, not by editing existing ones. New aggregate kind → new folder under `packages/domain/aggregates/`. New external service → new folder under `packages/external/`. New port → new file under `packages/application/ports/`. The ring rules (above) refuse the alternative — you cannot extend a domain aggregate by reaching into it from External, you must add a port and a use-case.

**L — Liskov Substitution.** Every adapter under `packages/external/<adapter>/` is fully substitutable for its `packages/application/ports/*` interface. The in-memory test double and any production implementation must all satisfy the same contract — including failure modes (`Result<T, RepositoryError>`, see [language-and-types.md](language-and-types.md)). A port whose real implementation throws where the test double returns `Result` is a Liskov violation; fix by promoting the failure into the port's `E` type.

**I — Interface Segregation.** Ports describe what a _single_ use-case needs, not a kitchen-sink "data access object." If a use-case only reads, its port has only the read method — it does not depend on a larger repository that also writes. The Reified Association pattern in [domain-modeling.md](domain-modeling.md) reinforces this at the schema level (link entities are their own aggregates with their own ports). When two use-cases share an adapter, they import two narrow ports that the adapter happens to implement together — never one fat port.

**D — Dependency Inversion.** Application defines the port (an abstraction); External implements it (a detail). Domain and Application never import External. The composition root in `apps/agent` and `apps/api` is the _only_ place concrete adapters bind to ports — every other layer takes ports as constructor or function arguments. This is enforced by `eslint-plugin-boundaries` (see config above) — the rule forbids inner-from-outer imports outright. Zod parsing at every boundary (see [language-and-types.md](language-and-types.md)) is the runtime complement: the abstraction promises a shape, the boundary parses to confirm.

The naming buys nothing at the implementation level — the rules and rings already exist. It buys vocabulary: a review comment "this violates ISP — the port has read and write methods, the use-case only reads" is faster than re-deriving the principle from first principles each time.
