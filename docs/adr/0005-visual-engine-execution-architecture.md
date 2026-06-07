# 0005 — Visual-Iteration Engine execution architecture

## Context

The engine ([0003](0003-owns-visual-iteration-engine.md)) must run in two environments — the autonomous drain and website-midwife's interactive flow — and capture screenshots, which is the hard part. Lived experience: the Docker sandbox **cannot run the app** (insufficient memory) and getting an in-sandbox agent to screenshot a running site requires serving on the host, a Playwright/MCP bridge on `0.0.0.0`, and proxy tweaks — fragile and non-deterministic.

The drain's two existing agent patterns frame the choice: the CI gate ([ci-gate.ts](../../src/orchestrator/ci-gate.ts)) is **host-side deterministic code** driving `execa` against the worktree; the Code Reviewer ([reviewer.ts](../../src/orchestrator/reviewer.ts)) is an **agent prompt** run via `sandcastle.run()` inside Docker. The engine needs both shapes.

## Decision

**Host-side deterministic orchestration; capture decoupled from consumption; agents sandboxed.**

1. **Engine = host-side module (the ci-gate pattern).** Loop control, breakpoint capture, ceiling, findings→verdict mapping, and report assembly are deterministic TypeScript with the capture step **mockable** (drop fixture PNGs to test orchestration without a browser). Not a free-form agent prompt.

2. **Programmatic capture, not agent capture.** The engine itself drives Playwright host-side: `goto(baseUrl + route)` at each breakpoint → `screenshot({ fullPage: true })` → write PNGs **into the worktree** (a host directory bind-mounted into the sandbox). The app is served on the **host** (the [[Preview adapter]]'s single `start` command boots it — a production-like *built* artifact, not a dev server — behind a readiness probe). **No agent ever takes a screenshot or touches the network**, which dissolves the proxy/MCP bridge entirely: agents read PNGs as files.

3. **Critic and editor are separate, both sandboxed.** Splitting generation from critique avoids self-grading bias (the editor would rubber-stamp its own work). Both run via `sandcastle.run()` like the Code Reviewer:
   - **Editor** — worktree mounted **read-write**; edits source and commits.
   - **Critic (Slop-Check)** — worktree mounted **read-only**. The read-only mount is a *filesystem-enforced* no-write guarantee (not a prompt instruction): any edit/commit attempt fails with a read-only error, and the container bounds the blast radius regardless. The critic only reads the PNGs + rubric and emits findings JSON.

4. **Reuse the worktree install; do not reinstall.** Neither agent run configures the pre-agent install hook (mirroring [reviewer.ts](../../src/orchestrator/reviewer.ts), which already runs hook-free). The implementer's install — refreshed by the upstream ci-gate — is reused in place.

5. **One execution shape for both callers.** website-midwife also runs its agents sandboxed with host-side capture, so the drain and the interactive flow share a single execution path (differing only in autonomous-vs-HITL and worktree-vs-project-dir). This is what makes "build and maintain in one place" real.

6. **Distribution.** The engine ships inside sandcastle-drain as a subpath export (`sandcastle-drain/visual-engine`) plus a CLI subcommand; website-midwife depends on this package. The engine legitimately needs `@ai-hero/sandcastle` (sandboxed editor), the bundled Dockerfile/image, and Playwright — all already owned here — so the dependency is real, not bloat. Extraction to a standalone package is deferred to [0003](0003-owns-visual-iteration-engine.md)'s third-consumer trigger.

## Consequences

- **The proxy/0.0.0.0/MCP setup is eliminated** for the steady-state loop: host code captures, agents consume files.
- **Worktree-install reuse is a Windows-path property.** On Windows the implementer's worktree persists with `node_modules` intact (the documented teardown success path) and ci-gate reuses it (`createdTempWorktree: false`). On **Linux**, ci-gate creates and removes a temp worktree in its `finally`, so a Linux run has no persisted install for the engine to reuse and would need its own worktree+install — a known gap, recorded so it isn't mistaken for an oversight.
- **Per-`ui`-issue cost rises by up to ~6 sandbox boots** (editor + critic, ceiling 3), but each is a *cheap* boot — no install — and the critic does no build. Mitigated by the low ceiling and install reuse.
- **The editor writes code in a sandbox**, consistent with the implementer/fixer invariant; nothing that writes runs unsandboxed on the host. Host-side processes (capture, the orchestrating module) execute no model-authored code.
