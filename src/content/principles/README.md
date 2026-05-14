# Development principles

The rules Claude Code (interactive + Sandcastle-autonomous) follows when building code in this repo, plus the architectural constraints those rules force the _product code_ to take.

These principles serve two readers:

- **Claude Code** — what to enforce when writing TypeScript, when to skip ceremony, how to size Sandcastle issues, what's relaxed because this is personal-use, what is not.
- **The product code itself** — what shape the codebase must take to remain testable, maintainable, and faithful to the domain.

The product itself — its lifecycle, domain types, workflows — is **out of scope** here. Those decisions land in [CONTEXT.md](../../../CONTEXT.md) and [docs/adr/](../../../docs/adr/) as they crystallise.

## Index

| File                                                   | Scope            | Topic                                                                                                                                                                      |
| ------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [language-and-types.md](language-and-types.md)         | Dev              | TypeScript strict mode, Zod at boundaries, branded types, tagged-union results, no-Effect rationale                                                                        |
| [architecture.md](architecture.md)                     | Dev + Product    | Onion layers (Domain / Application / External / Presentation), package layout, dependency direction                                                                        |
| [cqrs.md](cqrs.md)                                     | Dev + Product    | Read/write port separation at the Application boundary; one `<Aggregate>CommandRepository` + one `<Aggregate>QueryRepository` per new aggregate                            |
| [frontend-organization.md](frontend-organization.md)   | Dev              | Co-locate at the lowest level shared; per-component folders with `Component.{tsx,test,hook,util,mock,module.scss}`; feature folders; `shared/` for cross-feature            |
| [domain-modeling.md](domain-modeling.md)               | Dev + Product    | DDD ceremony rule (wrong-if-violated), anemic-model ban, reified-association pattern, decomposed-display values, nomenclature binding to CONTEXT.md                        |
| [testing.md](testing.md)                               | Dev              | Vitest + Playwright, per-layer coverage, property-based for domain, testcontainers + recorded fixtures, behavior-required test rule                                        |
| [linting-and-tooling.md](linting-and-tooling.md)       | Dev              | ESLint + plugins, three custom rules, Husky + lint-staged + pre-commit, no `--no-verify` ever                                                                              |
| [clean-code.md](clean-code.md)                         | Dev              | DRY / YAGNI / KISS, small focused functions with lint-enforced max-depth and complexity, composition over inheritance, pure functions and immutability in the domain layer |
| [personal-use-tradeoffs.md](personal-use-tradeoffs.md) | Dev + Product    | What's relaxed (UI, auth, ops), what's not (domain correctness, types, backups), tech-selection rule with paid-service ADR requirement                                     |
| [context-budget.md](context-budget.md)                 | Dev (Sandcastle) | 100k target / 150k ceiling, BUDGET config location, mechanical post-run measurement, summarize-don't-paste                                                                 |
| [claude-code-modes.md](claude-code-modes.md)           | Dev              | Universal rules + Sandcastle-only deltas (token budget, summarize-don't-paste, no-push, no-clarification)                                                                  |

## How to use this folder

- **Read [CLAUDE.md](../../../CLAUDE.md) first** — it links here and to the other agent-skill docs in [src/content/agent-docs/](../agent-docs/).
- **Then read the file relevant to what you're about to do.** Don't load the whole folder unless you're auditing.
- **If two files contradict, the more specific one wins** (e.g. `claude-code-modes.md` overrides general guidance for autonomous runs).
- **If a principle conflicts with what you're being asked to do**, surface the conflict in the issue or session — don't silently override.

## What's deliberately _not_ here

- The product's lifecycle, workflow, domain types — those go in CONTEXT.md and ADRs once decided.
- Tooling enforcement (lint config, tsconfig flags, pre-commit hook wiring) — those are queued as separate Sandcastle issues; principles describe the rules, follow-up issues implement them.
- Scaffolded package folders — created when the first product issue needs them.
