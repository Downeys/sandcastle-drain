# Canonical domain vocabulary

The sandcastle-drain reviewer reads this file as the source of truth for nomenclature binding (see [src/content/principles/domain-modeling.md](src/content/principles/domain-modeling.md)) — every type / table / file path / UI label in new code must use these exact names. Synonyms are flagged as findings.

## Code Reviewer

The existing read-only review sub-agent (`src/prompts/reviewer.md.tpl`, `src/orchestrator/reviewer.ts`). After the implementer commits, it reads the diff against `main` and audits it against the **textual rubric** — the bundled principles plus the host's `CONTEXT.md` glossary and `docs/adr/`. It emits a JSON verdict (`PASS`/`FAIL`) with findings and never edits, renders, or screenshots. Distinct from the [[Visual-Iteration Engine]] and [[Slop-Check]], which grade *appearance*, not *code*.

## Visual-Iteration Engine

A generic, **rubric-agnostic and stack-agnostic** loop that boots/serves a target, screenshots it at configured breakpoints, critiques the screenshots against an injected [[Visual rubric]] (via [[Slop-Check]]), edits the site, and re-captures — iterating to a ceiling — then returns a structured iteration report. It knows nothing about any project's taste or tech stack; both the [[Visual rubric]] and the [[Preview adapter]] are injected by the consumer. In sandcastle-drain's drain loop it runs as a pipeline step *before* the [[Code Reviewer]] (and after a ci/fixer pass, since it must serve a working build to render it), gated per-issue by the `ui` label.

The engine is an **editor, not a rejecter**: when it exhausts its iteration ceiling still failing the [[Visual rubric]], it commits its best-effort polish and the issue is parked at `needs-review` rather than discarded — it never routes through the code-rejection (`handleRejection`) path, which would throw the polish away. It does **not** short-circuit the [[Code Reviewer]], which still runs and may reject on code grounds. A visual ceiling-fail simply makes the issue "not land" (un-merged), which both blocks auto-merge and — via the existing `failedThisRun` machinery — skips any dependent issue that names it under `## Blocked by`.

## Slop-Check

The single-responsibility adversarial reviewer that runs *inside* the [[Visual-Iteration Engine]]: given screenshots and a [[Visual rubric]], it returns structured findings (`{ signal, severity, breakpoint, suggested-fix }`). Generation is split from critique on purpose — Slop-Check does not see edit history, so it cannot rationalize the engine's own changes. Also invokable standalone for a one-off visual audit. It grades; it does not edit.

## Visual rubric

A consumer-owned definition of what good UI looks like: Art Directions (do/don't rules, exemplars) plus the slop-signal list. Opaque to the [[Visual-Iteration Engine]], which applies it but never interprets or ships a default — each project owns its own (the engine is generic; taste is the consumer's). Distinct from the **textual rubric** the [[Code Reviewer]] uses (principles / ADRs / glossary).

## Preview adapter

The injected mechanism the [[Visual-Iteration Engine]] uses to boot and serve a project so it can be screenshotted — supplied by the host, never hardcoded in the engine. It abstracts "how to serve *this* project": a static-first Astro site serves differently from an app that needs a backend API plus a frontend. The engine only needs a base URL to point the headless browser at; the host owns whatever process orchestration sits behind that.
