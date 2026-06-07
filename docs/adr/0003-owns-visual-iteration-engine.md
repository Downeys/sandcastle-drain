# 0003 — sandcastle-drain owns the generic Visual-Iteration Engine

## Context

A consumer building UI needs to *see* what an agent rendered and drag it toward a quality bar. Two callers want this: sandcastle-drain's own autonomous drain (an automated visual reviewer/editor before auto-merge) and a separate static-first website tool, **website-midwife** (an interactive, human-in-the-loop pre-draft check). If each reimplements the loop, the definition of "acceptable" drifts and "passed interactively" stops meaning "passes the drain gate."

The crown-jewel asset is *taste* — what counts as "not slop" — which differs per project (and, for website-midwife, per client). The reusable asset is the *mechanism* — serve, screenshot, critique, iterate, report. These must not be coupled.

## Considered Options

- **Duplicate the loop per consumer** — rejected: the bar drifts; "passes interactively" silently diverges from "passes the drain gate." It is *one engine, many callers*.
- **Put the engine in the consumer (website-midwife)** — rejected: inverts the dependency (a generic mechanism would depend on a specific website project) and drags consumer-specific taste/stack logic into shared infrastructure.
- **Engine in sandcastle-drain, taste and stack injected (chosen)** — the engine is reusable mechanism; the rubric stays in the consumer and is passed in opaque. sandcastle-drain stays generic: "iterate until the injected rubric passes."

## Decision

sandcastle-drain owns the generic **Visual-Iteration Engine** and **Slop-Check** mechanism. The engine is **rubric-agnostic and stack-agnostic**: the [[Visual rubric]] (taste) and the [[Preview adapter]] (how to serve a given project) are injected by the consumer.

1. **Contract.** `runVisualEngine({ target, rubric, previewAdapter }) → iterationReport`. The engine treats `rubric` as opaque criteria and `previewAdapter` as a narrow "boot the project, hand back a base URL" interface. (An earlier draft proposed also injecting the critic/editor agents; that was reverted — sandcastle-drain owns those agents. Only taste and serve are the consumer's.)
2. **Two anticipated consumers.** The drain's reviewer/editor step (autonomous) and website-midwife's interactive flow (HITL). Both are first-class; neither is special-cased in the engine.
3. **Generic by construction.** Supporting a new framework is a consumer concern (supply a preview adapter); supporting a new aesthetic is a consumer concern (supply a rubric). Neither is ever an engine change.

## Consequences

- **The engine encodes nothing consumer-specific.** No default rubric, no hardcoded serving logic. A house aesthetic baked into shared infra is the failure mode this ADR exists to prevent.
- **Distribution: the engine ships inside this package** (subpath export + CLI subcommand), and website-midwife depends on sandcastle-drain. See [0005](0005-visual-engine-execution-architecture.md).
- **Escape hatch.** If a *third* consumer emerges or the standalone entry point becomes awkward to maintain here, extract the engine into its own small shared package consumed by all callers. Not done preemptively — two consumers is the count this design always anticipated; the cost of premature extraction exceeds the benefit until a third appears.
- See [0004](0004-visual-engine-drain-integration.md) for how the engine plugs into the drain loop, and [0005](0005-visual-engine-execution-architecture.md) for how it runs.
