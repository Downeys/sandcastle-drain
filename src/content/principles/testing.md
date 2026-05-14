# Testing

Vitest for unit + integration. Playwright for the chat-UI E2E flow. `fast-check` for property-based tests on the domain layer. Coverage targets and enforcement vary per layer — flat targets produce ritual tests where they don't matter and miss coverage where they do.

## Runner choices

- **Vitest** for unit + integration. TS+ESM-native, fast, watch mode, parallel workers, integrates with `fast-check`.
- **Playwright Test** for the chat-UI E2E flow. Already implied by the Sandcastle Dockerfile baking in Playwright + Chromium.
- **`node:test`** is available but not used; Vitest's DX (built-in expect, watch UI, snapshot) wins for the costs of one extra dep.

## Per-layer coverage policy

| Layer                  | Coverage target                            | Test type                                                | Enforcement                                 |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------- |
| `packages/domain`      | **≥ 90% gate, 95% target (line + branch)** | Pure unit; property-based for state machines and math    | **Gated** — pre-commit / CI fails below 90% |
| `packages/application` | **≥ 85% line**                             | Use-case tests with in-memory port stubs                 | **Report-only** — printed, not gated        |
| `packages/external/*`  | **No coverage target**                     | Integration tests against real services where reasonable | Tests gated to pass; coverage not enforced  |
| `apps/api`             | Smoke + Zod contract tests                 | Endpoint smoke, schema round-trips                       | Tests gated to pass                         |
| `apps/ui`              | **No coverage target**                     | A few Playwright smoke tests on the golden chat flow     | Smoke tests gated to pass                   |
| `apps/agent`           | Composition root, mostly untested          | Wiring integration test only                             | —                                           |

The 90%-gated / 95%-target rule on `packages/domain` is the load-bearing one. The domain layer is where bugs cause silent wrong answers, and where the agent is most likely to skip tests without something forcing them. The 5% gap between gate and target is deliberate: 95% as a hard gate forces ritual tests on trivial getters and coverage-of-coverage games that corrupt the discipline; 90% as a hard gate stays tight on real behavior. Aim for 95%; the commit fails below 90%.

## Property-based testing on the domain

Required for state machines and pure math in `packages/domain`; encouraged elsewhere; optional in adapters.

Use `fast-check` to express invariants like:

```ts
import fc from 'fast-check';
import { test } from 'vitest';

test('transition to shipped preserves prior status as snapshot', () => {
  fc.assert(
    fc.property(arbOrder(), arbShipmentEvent(), (order, event) => {
      const before = order.status;
      order.ship(event);
      expect(before).toMatchInlineSnapshot(/* ... */);
    }),
  );
});
```

The cost is real (property tests take longer to write than examples) but for state machines, derived math, and aggregations — the parts of the domain where bugs cause silent wrong answers — property tests pay back many times over.

## Integration tests: real services or recorded fixtures

| Service                                                 | Strategy                                           | Why                                                                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres / databases**                                | **Testcontainers**                                 | Real schema, real migrations, real query plans. Cheap and fast in a container.                                                                                                                                |
| **LLM APIs (Anthropic, OpenAI, etc.)**                  | **Recorded fixtures** with explicit re-record flag | Calls cost money and take seconds. Replay deterministically; re-record when the agent's prompt changes.                                                                                                       |
| **Other paid APIs (embeddings, web search, etc.)**      | **Recorded fixtures** with explicit re-record flag | Same reasoning.                                                                                                                                                                                               |
| **HTTP GET against arbitrary URLs**                     | **Recorded fixtures** keyed by URL                 | Real fetches are non-deterministic (paywalls, redirects, content drift); fixtures pin the bytes for stable test behavior.                                                                                     |
| **Filesystem**                                          | Real, in a tmp directory                           | No reason to mock; filesystem is fast.                                                                                                                                                                        |

**No mocking the database.** A recurring failure mode: mocked DB tests pass while a real production migration breaks. Integration tests for your persistence adapters hit a real database in testcontainers.

## Behavior-required test rule

Tests are required when introducing testable _behavior_:

- A new domain function
- A new invariant
- A new state-machine transition
- A new use-case orchestration
- A new parser, schema, or math routine

Tests are **not** required for:

- Type-only changes
- Dependency bumps
- Comment / doc edits
- Config tweaks
- UI cosmetic changes
- Log-message changes

This inherits verbatim from `src/prompts/implementer.md.tpl`'s existing rule. The rationale: forcing tests on type-only changes produces theater tests that pass for the wrong reason and rot when the type changes.

## Test file layout

- Tests colocated with code: `foo.ts` + `foo.test.ts` in the same folder.
- Integration tests in `*.integration.test.ts` (separate suite, slower, can be `--exclude`'d in dev loop).
- E2E tests in `apps/ui/e2e/*.spec.ts` (Playwright's convention).
- `vitest.config.ts` at the workspace root configures per-package projects with the right thresholds.

## What to do when a test would be obviously theater

Don't write it. Instead, add a one-line note in the PR / commit explaining the work has no testable behavior. The pre-commit hook does not require _every_ change to add tests — it requires the test suite to _pass_ and (in the domain) coverage thresholds to hold. If you remove a tested behavior, remove the test in the same commit.
