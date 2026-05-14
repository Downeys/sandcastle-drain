# Domain modeling

How to decide whether a new entity gets full DDD ceremony or just a Zod schema. How to name things. How to model relationships that have their own attributes.

## The ceremony rule (wrong-if-violated)

An entity gets `packages/domain/aggregates/` treatment — class with private state, public methods, `Result<T,E>` returns, repository port — when **any** of these are true:

1. **Lifecycle states with rules about which transitions are legal.** E.g. an `Order` going `placed → shipped`, never directly `placed → delivered` without a `shipped` event in between.
2. **Composes other domain objects under invariants.** E.g. an aggregate that requires every child entity to satisfy a structural constraint before the parent is valid.
3. **Computed fields whose correctness depends on inputs the type system can't validate.** E.g. financial math, completeness checks, derived totals.
4. **Misuse causes silent wrong answers, not just crashes.** This is the operational test: *would silent corruption be possible if we used a plain shape here?* If yes, DDD.

If none of these apply, **use a Zod schema in `packages/domain/dtos/` plus plain functions.** Examples that go in `dtos/`: chat messages, tool-call traces, search-result caches, config, UI form state. These are transport/log/cache shapes — anemic by design and exempt from the no-anemic-aggregate rule.

## Anemic models banned in `aggregates/`

A custom ESLint rule (`local/no-anemic-aggregate`, see [linting-and-tooling.md](linting-and-tooling.md)) fails any class exported from `packages/domain/aggregates/` that has only a constructor and getters with no behavioral methods. Aggregates carry their invariants *inside* themselves; a class that's just a data bag belongs in `dtos/`, not `aggregates/`.

DTOs in `packages/domain/dtos/` are explicitly exempt — they are *supposed* to be data bags.

## Reified-Association pattern

When a relationship between two aggregates has its own attributes and its own lifecycle, model it as a **Reified Association** (sometimes called Associative Entity or Link Entity) — its own aggregate root, with its own repository port.

Symptoms that point to this pattern:

- The relationship itself has attributes (e.g. role, weight, validity window, last-verified-at).
- The relationship can be revised independently of either end (e.g. update the role, mark it expired).
- The relationship can be queried as a fleet (e.g. "all approvals for document X with status `expired`").

Concretely, given two aggregates `A` and `B` whose link has its own data and lifecycle:

- Create an aggregate `AbLink` (or whatever the canonical name in `CONTEXT.md` is).
- It is an Entity, **its own aggregate root**.
- It has methods that mutate its own attributes (`revise(...)`, `expire(reason)`, etc.) — not setters.
- Cross-aggregate references via IDs (`aId: AId`, `bId: BId`), never direct object references.
- Has its own repository port in `packages/application/ports/`.

A bare `bId: BId` field on `A` is the wrong shape when the link has data of its own — that flattens the association into a foreign-key and loses the place where the relationship's attributes and lifecycle live.

## Decomposed display values (no premature scalar collapse)

When a user-facing value summarises several independent inputs (e.g. an overall confidence, a risk score, a recommendation rank), prefer keeping the constituent values addressable rather than collapsing them into a single stored scalar.

The default: render the components side-by-side at read time, and compute any composed sort key as a **pure domain function** that has no persisted value backing it. The composed value is a function of the constituents, not a field on any aggregate.

This avoids the silent-staleness failure mode where the stored scalar diverges from the source values after a related field is revised. ADR the formula when one is first needed — including which constituent fields feed it and what the function is. See [architecture.md](architecture.md) for where pure functions live.

## Nomenclature: CONTEXT.md is the canonical vocabulary

> **CONTEXT.md is the single source of truth for domain vocabulary.** Every type, table, file path, and UI label uses the names defined there without aliasing. New domain concepts are added to CONTEXT.md **before** code uses them.

If CONTEXT.md defines a concept as e.g. "Customer Order," the class is `CustomerOrder`, the database table is `customer_order`, the file folder is `customer-order/`, the UI label is "Customer Order". One vocabulary, four representations, no aliases.

A custom ESLint rule (`local/domain-names-match-context-md`) parses CONTEXT.md headings and fails any export from `packages/domain/aggregates/` or `packages/domain/value-objects/` whose name doesn't match an entry. This rule is silent until CONTEXT.md has been populated.

ADRs in `docs/adr/` record *why* a name was chosen. If a rename is justified, it lives in an ADR and the rename happens atomically across CONTEXT.md, code, tables, files, and UI.

## Where domain logic actually runs

Domain methods are pure: same inputs, same outputs, no I/O. Side effects (saving an aggregate after a transition) are orchestrated by the **Application layer's use cases** which load the aggregate via a repository port, mutate it via its own methods, and save it back. The aggregate's transition method *does not* know there is a database. See [architecture.md](architecture.md) for the layer rules that enforce this.
