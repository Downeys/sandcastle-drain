# Architectural Decision Records

Each ADR lives in its own file named `NNNN-short-title.md`. See https://adr.github.io for format guidance.

The Sandcastle reviewer reads this directory and flags any diff that contradicts a written ADR.

## When to write one

- A material architectural choice (database, language feature, framework, persistence strategy).
- An exception to a default rule from `src/content/principles/` (e.g. a paid managed service over an OSS alternative — see `personal-use-tradeoffs.md`).
- A rename of a domain concept in `CONTEXT.md`.

## Format

Short. One page. The minimum: **Context** (the problem), **Decision** (what we chose), **Consequences** (what this commits us to). Optional: alternatives considered, references.

## Index

- [0001 — Compiled library + staged content](0001-compiled-library-and-staged-content.md)
