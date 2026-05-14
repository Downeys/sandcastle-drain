# Frontend organization

One rule generates the whole structure: **every piece of code is co-located at the lowest level it is shared.** If a util, hook, mock, or style is used by exactly one component, it lives in that component's folder. If two sibling components share it, it moves up to their common parent's folder. If two features share it, it moves to `apps/ui/src/shared/`. Code rises as it gains consumers; it never sits higher than it needs to.

The component is the unit of organization, not the file.

This applies to `apps/ui/`. The other apps (`apps/api/`, `apps/agent/`) follow [architecture.md](architecture.md)'s server-side layout.

## Per-component folder

A component folder is named after the component (PascalCase). It contains whichever of these files the component actually needs — none are required except the `.tsx` itself:

- `Component.tsx` — the component
- `Component.test.tsx` — its tests
- `Component.mock.ts` — test/storybook mocks for this component
- `Component.module.scss` — component-local styles
- `Component.util.ts` / `Component.util.test.ts` — component-local pure helpers
- `Component.hook.tsx` / `Component.hook.test.tsx` — component-local hooks

The naming convention (`Component.<role>.<ext>`) keeps the folder grepable and the relationship between files explicit. A util that has graduated to multiple consumers gets renamed and lifted; until then, it stays scoped to the component that owns it.

No `index.ts` barrel by default. Add one only when it meaningfully shortens imports across feature boundaries — barrels in every folder create maintenance load and obscure the call graph.

## Nested components

A component that owns sub-components puts each sub-component in its own folder _inside_ the parent's folder, with the same co-location rules. Nesting is recursive: a sub-component with its own private util keeps that util next to it, not at the parent level.

```
apps/ui/src/strategy/
├── StrategyList/
│   ├── StrategyList.tsx
│   ├── StrategyList.test.tsx
│   ├── StrategyList.hook.tsx          // private to StrategyList
│   ├── StrategyRow/                   // sub-component, owned by StrategyList
│   │   ├── StrategyRow.tsx
│   │   ├── StrategyRow.test.tsx
│   │   └── StrategyRow.module.scss    // private to StrategyRow
│   └── RenameForm/                    // sub-component, owned by StrategyList
│       ├── RenameForm.tsx
│       ├── RenameForm.util.ts         // private to RenameForm
│       └── RenameForm.util.test.ts
```

If `StrategyRow` later gets reused outside `StrategyList`, it graduates up to `apps/ui/src/strategy/` (still feature-local) or to `apps/ui/src/shared/components/StrategyRow/` (if used across features). The promotion is driven by the second consumer, never predicted.

## Feature directories

When the UI grows to multiple distinct concerns — pages, routes, or major feature areas — each gets a top-level folder under `apps/ui/src/<feature>/`. The feature folder contains:

- The feature's top-level component(s)
- Per-component folders (same rules as above)
- Feature-private hooks/utils/mocks alongside the components that use them

```
apps/ui/src/
├── strategy/                          // feature
│   ├── StrategyList/...
│   ├── StrategyCreateForm/...
│   └── strategy.hook.tsx              // hook shared across components in this feature
├── insights/                          // a second feature, hypothetical
│   └── ...
└── shared/
    ├── components/
    │   └── ErrorBoundary/...          // used by both strategy and insights
    ├── hooks/
    │   └── useAuth.ts
    └── utils/
        └── format-date.ts
```

A second feature consuming the same code is the trigger to lift it — to `shared/` if it crosses features, to the feature root if it crosses components within a feature.

## Shared code

Cross-feature shared code lives under `apps/ui/src/shared/`:

- `apps/ui/src/shared/components/<ComponentName>/...` — components used by ≥ 2 features
- `apps/ui/src/shared/hooks/...` — hooks used by ≥ 2 features
- `apps/ui/src/shared/utils/...` — utils used by ≥ 2 features

The `shared/` prefix makes scope explicit at the import path. `import { ErrorBoundary } from '@/shared/components/ErrorBoundary'` reads as "this is intentionally cross-feature." Imports that pierce a feature boundary _without_ going through `shared/` (e.g., `import from '@/strategy/StrategyList'` from inside `insights/`) are a structural smell — either lift the import target to `shared/`, or duplicate (rare) and revisit when a third consumer shows up.

No generic top-level `apps/ui/src/components/`, `apps/ui/src/hooks/`, or `apps/ui/src/utils/`. Those names hide the sharing scope; `shared/` makes it explicit.

## Tests are co-located

Test files sit next to the code they test. No parallel `__tests__/` directory tree. Vitest discovery (see [testing.md](testing.md)) follows the standard `*.test.ts(x)` glob, which works regardless of folder depth.

E2E tests stay in `apps/ui/e2e/` — those are not unit tests; they exercise the wired-up app from the outside and are organized by user flow, not by component.

## Why these rules

- **Co-location at lowest-shared-level minimizes the radius of any change.** Editing a component's private util touches one folder. Lifting it later is mechanical: copy folder up, update imports. Lifting prematurely costs nothing on day one but creates re-coupling pressure (everyone now reaches for the "shared" thing because it's there, not because they need it).
- **The component-as-folder unit makes deletes safe.** Deleting a feature deletes a folder — all its private utils, hooks, mocks, and tests go with it. A flat layout strands the private helpers in `utils/`, where they outlive their consumers and accumulate.
- **The `shared/` prefix is a documentation artifact.** Imports declare scope. A reviewer scanning a diff sees `from '@/strategy/...'` (feature-internal) vs `from '@/shared/...'` (cross-cutting) and can judge coupling without reading the file.
- **It scales with the project.** A 5-component SPA fits one feature folder. A 50-component app with 6 features fits the same rules unchanged — the only difference is more feature folders and a fuller `shared/`.

## Existing code: forward-looking

The current `apps/ui/src/` does not follow this layout:

- 7 components flat in [apps/ui/src/components/](../../apps/ui/src/components/), only `ErrorTagMessage` has a co-located test.
- 6 hooks plus utilities flat in [apps/ui/src/hooks/](../../apps/ui/src/hooks/), each with a co-located test (already correct for the co-location rule, but lives under the wrong top-level name).
- No feature folders. No `shared/`.

The SPA has one concern (strategy CRUD) and no natural feature boundaries yet, so a retrofit is deferred until the second feature lands. The forcing function is the second consumer.

**New components MUST follow this standard.** The next component added is the test case: create a feature folder for it if one doesn't exist, put the component in its own folder inside, co-locate everything it owns.

When retrofit eventually happens:

- `apps/ui/src/components/` and `apps/ui/src/hooks/` get moved into either a `strategy/` feature folder (if everything is in fact strategy-specific) or `apps/ui/src/shared/components/` and `apps/ui/src/shared/hooks/` (if they're genuinely cross-feature).
- Per-component folders get created. Test files that already exist stay co-located; `.util.ts` / `.hook.tsx` files are extracted as opportunities arise.
- This is one PR's worth of mechanical work and an opportunity to delete anything that's been dead since the original flat layout — not a separate principle to enforce.

## Relation to other principles

- [architecture.md](architecture.md) — onion rings. `apps/ui/` is the Presentation ring. This file describes how it's structured _internally_.
- [testing.md](testing.md) — Vitest discovery, co-located tests.
- [clean-code.md](clean-code.md) — small focused functions, DRY/YAGNI/KISS. The co-location rule is a YAGNI in spatial form: don't hoist to `shared/` what only one component uses.
