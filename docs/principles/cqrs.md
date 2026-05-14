# CQRS

Command-Query Responsibility Segregation, applied at the Application port boundary. Reads and writes for an aggregate go through separate ports, implemented by separate adapters (or one adapter exposing both). Domain stays unaware.

This composes with Onion (see [architecture.md](architecture.md)); it does not replace it. The onion describes _which ring code lives in_; CQRS describes _what shape the ports in `packages/application/ports/` take_.

## Rule

For each aggregate, the Application layer defines two ports:

- **`<Aggregate>CommandRepository`** — writes only. `save`, `delete`, `apply<Event>`. Returns `Result<Unit | <Aggregate>Snapshot, RepositoryError>`.
- **`<Aggregate>QueryRepository`** — reads only. `loadById`, `loadBy<NaturalKey>`, `listBy*`, projected views. Returns `Result<<ReadModel>, RepositoryError>`.

Use-cases compose one or both as needed. A use-case that only reads imports only the query port; a use-case that only writes imports only the command port. A use-case that does both takes both (and is a candidate for splitting — see anti-patterns below).

Adapters in `packages/external/<adapter-name>/` may share storage and even share a class internally — but the file they export must declare two interface implementations, never a single union of methods.

## Why this matters

The structural payoff is concrete:

- A read-path's signature cannot accidentally introduce a write, because its port has no write method.
- A projection-only read can return whatever shape best fits the caller (denormalized view, joined snapshot, aggregated count) without forcing the write model to grow methods that serve it.
- The Liskov substitution rule from [architecture.md](architecture.md) ("every adapter is fully substitutable for its port") tightens — a real adapter and an in-memory test double satisfy the _same_ narrow query interface, with no write methods to drift on.
- If your persistence model is append-only (audit aggregates, event-sourced state), CQRS at the port layer mirrors that asymmetry at the code level. A single combined repository ends up carrying both `appendX` and `listX`, and the use-case signature stops telling the reader whether this is a write-path or a read-path.

## How it composes with Onion

- **Domain knows nothing of CQRS.** No `<Aggregate>Command` types. No `<Aggregate>Query` types. Aggregates have their behavior methods (`Thing.archive()`, `Order.ship()`); that's it. CQRS lives at the port boundary, not in the domain language. [CONTEXT.md](../../CONTEXT.md) does not need a "command" or "query" entry.
- **Application defines the two ports.** Ports live in `packages/application/ports/<aggregate>-command-repository.ts` and `packages/application/ports/<aggregate>-query-repository.ts`. Use-cases import only what they need.
- **External implements them.** An adapter in `packages/external/<adapter-name>/` may expose both interfaces from one file. The implementation can share a connection pool, transaction handling, and helpers freely — splitting is at the _interface_, not the _runtime_.
- **The composition root in `apps/<app>/composition-root.ts` wires both.** Same place as today; just two bindings per aggregate instead of one.

Example port shapes:

```ts
// packages/application/ports/order-command-repository.ts
import type { Order, OrderId } from '@your-project/domain';
import type { Result } from '@your-project/domain';

export interface OrderCommandRepository {
  save(order: Order): Promise<Result<OrderId, RepositoryError>>;
  applyTransition(id: OrderId, event: OrderEvent): Promise<Result<Unit, RepositoryError>>;
}
```

```ts
// packages/application/ports/order-query-repository.ts
import type { OrderId, OrderSnapshot, CustomerId } from '@your-project/domain';
import type { Result } from '@your-project/domain';

export interface OrderQueryRepository {
  loadById(id: OrderId): Promise<Result<OrderSnapshot, RepositoryError>>;
  listForCustomer(customerId: CustomerId): Promise<Result<readonly OrderSnapshot[], RepositoryError>>;
}
```

## Anti-patterns

- **`<Aggregate>Command` / `<Aggregate>Query` types in `packages/domain/`.** CQRS is a port-boundary pattern, not a domain-modeling pattern. Domain stays in the vocabulary of [CONTEXT.md](../../CONTEXT.md) — not Commands and Queries.
- **Splitting ports without splitting use-cases.** If a use-case takes both `<Aggregate>CommandRepository` and `<Aggregate>QueryRepository` and uses them interleaved, the separation buys nothing. Either split the use-case (the read piece is a query use-case, the write piece is a command use-case) or accept that this specific use-case is intrinsically mixed and document why.
- **Duplicating a shared snapshot DTO into command-side and query-side variants when the shape is identical.** Reuse the snapshot from `packages/domain/dtos/`. Split only when read needs genuinely diverge (e.g., the query side wants a denormalized view with joined data).
- **Putting query ports in `packages/external/<adapter>/` and command ports in `packages/application/ports/`.** Both ports live in Application — they describe what Application needs. External implements both.
- **Sneaking writes into query methods.** A `loadById` that lazily backfills cache rows is a write disguised as a read. The cache-miss case still goes through the command path or stays out of the port entirely (handled by the adapter internally, transparent to the use-case).

## Relation to other principles

- [architecture.md](architecture.md) — onion rings, port pattern, dependency inversion. CQRS narrows what a port looks like; the ring rules are unchanged.
- [domain-modeling.md](domain-modeling.md) — aggregates, value objects, reified-association pattern. None of these require CQRS knowledge; CQRS does not change how the domain expresses itself.
- [testing.md](testing.md) — port-stub tests in Application now use two stubs instead of one. The cost is one extra file per use-case test; the win is that command stubs never accidentally serve reads and vice versa.
