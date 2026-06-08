# sandcastle-drain

A wrapper around [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle) that drains a queue of GitHub issues labeled `sandcastle`, runs Claude Code against each in an isolated Docker worktree, and posts results back to the issue. Ships an opinionated set of engineering principles and a reviewer rubric that enforces them.

## Prerequisites

The wrapper relies on the host machine to supply these. None of them are installed for you.

- **Docker installed and running.** The wrapper builds and manages its own sandbox image, tagged `sandcastle:<host-cwd-basename>`, directly from the Dockerfile bundled in this package (Node 22 + git + gh + Claude Code CLI + Playwright + Chromium + Corepack-enabled pnpm/yarn shims). Build runs automatically on the first `npx sandcastle-drain drain` and rebuilds only when the bundled Dockerfile changes (detected via a SHA-256 content label). You do **not** need to run `sandcastle init` or `sandcastle docker build-image`; any `.sandcastle/Dockerfile` in the host project is ignored.
- **Node.js 20+** on the host (the wrapper itself is a Node CLI).
- **`gh` CLI installed and `gh auth login` complete.** The wrapper shells out to `gh issue list / edit / comment / create` and `gh pr create / merge`.
- **Claude Code CLI installed locally**, with OAuth credentials persisted to `~/.config/sandcastle-claude-creds/`. The wrapper bind-mounts that directory into every sandbox so the agent reuses your Pro/Max subscription. Bootstrap once with:
  ```sh
  mkdir -p ~/.config/sandcastle-claude-creds
  docker run -it --rm \
    --entrypoint claude \
    -v ~/.config/sandcastle-claude-creds:/home/agent/.claude \
    sandcastle:<your-image-name> \
    login
  ```
  `--entrypoint claude` overrides the base image's `sleep infinity` so the device-code flow runs. Re-run if a drain reports auth errors mid-flight.
- **Matt Pocock's `tdd` and `diagnose` skills** installed at `<host>/.claude/skills/{tdd,diagnose}/` via:
  ```sh
  npx skills@latest add mattpocock/skills/tdd mattpocock/skills/diagnose
  ```
  The wrapper probes for these at startup and refuses to drain without them.
- **A GitHub repo with the canonical labels.** The wrapper auto-creates any missing labels (`sandcastle`, `in-progress`, `needs-review`, `blocked`, `retry`, `priority`, `oversized`, `skipped-this-run`, `needs-info`, `ui`) on first run. `ui` is the per-issue opt-in for the Visual-Iteration Engine — see [Public API](#public-api).

## Install

```sh
npm install --save-dev sandcastle-drain
```

The package exposes a single binary, `sandcastle-drain`. Invoke it via `npx`:

```sh
npx sandcastle-drain <subcommand>
```

## Usage

| Command                 | What it does                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `npx sandcastle-drain drain`  | Process every open issue labeled `sandcastle`. One agent run per issue, on a branch `agent/issue-N`.    |
| `npx sandcastle-drain ship N` | Push `agent/issue-N`, open a PR with `Closes #N`, squash-merge it, and delete the remote branch.       |
| `npx sandcastle-drain sweep N`| Post-merge cleanup: pull main, remove the worktree directory, prune git's worktree metadata, delete the local branch. Refuses to run unless a MERGED PR exists for the branch. |
| `npx sandcastle-drain visual`| Run the Visual-Iteration Engine once on the current worktree against caller-supplied routes/rubric, and print the iteration report as JSON to stdout. The standalone surface website-midwife's human-in-the-loop pre-draft flow consumes. Run `--help` for flags (`--routes`, `--breakpoints`, `--rubric`, `--preview-adapter`, `--branch`, `--out-dir`, `--ceiling`). |

All paths resolve relative to the host working directory where you ran `npx sandcastle-drain`. The wrapper writes runtime artifacts to `<host-cwd>/.sandcastle-drain/` (logs, worktrees, staged content, optional `splits.json`).

## Public API

Beyond the `sandcastle-drain` binary, the package exposes the **Visual-Iteration Engine** as supported public API on two surfaces:

- **Subpath export — `sandcastle-drain/visual-engine`.** Programmatic access to the engine. The primary entry points are `runVisualEngine` (drive the `capture → critique → edit → recapture` loop) and `computeVerdict` (map findings to a `pass`/`fail` verdict), alongside the engine's public types (`Finding`, `IterationReport`, `Verdict`, `VerdictPolicy`, `Target`, `Rubric`, `PreviewAdapter`, …).

  ```ts
  import { runVisualEngine, computeVerdict } from 'sandcastle-drain/visual-engine';
  ```

- **CLI subcommand — `sandcastle-drain visual`.** The thin command-line surface over the same loop (see [Usage](#usage)).

The engine is rubric-agnostic and stack-agnostic: the visual rubric (taste) and the preview adapter (how to boot a given project) are injected by the consumer, not baked in.

**Why the engine lives here.** It ships *inside* sandcastle-drain — as this subpath export plus the CLI subcommand — rather than as its own package, because it legitimately needs dependencies this package already owns (the sandboxed editor, the bundled Docker image, Playwright). website-midwife depends on sandcastle-drain for exactly this engine. Extraction into a standalone shared package is **deferred to the third-consumer trigger**: two consumers is the count this design anticipated, and the cost of premature extraction exceeds the benefit until a third appears. See [ADR 0003](docs/adr/0003-owns-visual-iteration-engine.md) for the ownership decision and [ADR 0005](docs/adr/0005-visual-engine-execution-architecture.md) for the execution architecture.

## What the wrapper enforces

Two layers run on every implementer commit: a fixed set of **development principles** the implementer must follow, and a four-category **reviewer rubric** that audits the diff after the commits land.

The principle files ship inside the package at `dist/content/principles/` and are staged into `<host-cwd>/.sandcastle-drain/staged/principles/` before each drain so the agent can read them from inside the sandbox. Twelve files cover language and types, architecture (onion layers), CQRS, frontend organization, domain modeling, testing, linting and tooling, clean code, personal-use trade-offs, context-budget discipline (100k target / 150k ceiling), Claude Code interactive-vs-autonomous mode deltas, and a README that indexes the rest. Both the implementer and the reviewer eager-load the relevant files.

The reviewer rubric is four categories. **Domain integrity** flags anemic-model violations and any aggregate-specific invariants the host has written into `CONTEXT.md` or an ADR. **Test discipline** enforces the behavior-required test rule (every commit that introduces testable behavior ships with tests), property-based testing on state machines, and integration tests that hit real infrastructure rather than mocks. **Architecture intent** rejects inheritance of domain classes, impurity in the domain layer, and cross-layer imports that violate the onion direction. **Glossary & ADR alignment** checks that new names match `CONTEXT.md` verbatim and that diffs don't contradict any ADR under `docs/adr/`.

## Reviewer-gating behavior

The reviewer is **gating in the success path** and emits findings advisorily on the rejection path — it is not "advisory only." `handleRejection` in `dist/orchestrator/main.ts` is the load-bearing function; the flow is:

1. After the implementer commits and the CI gate passes, the reviewer sub-agent runs read-only against the worktree and emits a JSON verdict (`PASS` or `FAIL`) with a structured findings array.
2. **`PASS` + CI green** → the wrapper auto-ships and sweeps: push, open a PR with `Closes #N`, squash-merge, delete the remote branch. The issue auto-closes via the squash-merge body.
3. **`FAIL`** → `handleRejection` tags the branch tip as `rejected/issue-N-attempt-K` (preserving the work), discards the local branch, files a new GitHub issue titled `[follow-up #N] <original title>` labeled `sandcastle` + `priority` whose body carries the reviewer findings + the list of changed files + commit titles, comments on the original linking the follow-up, and closes the original. The next drain cycle picks up the `priority`-labeled follow-up first, combined with auto-ship this prevents the rejected branch from merging until a follow-up passes.
4. **Reviewer parse error or throw** → the wrapper posts an error comment on the issue, labels it `needs-review`, and leaves the branch in place for the human to inspect.

So `PASS` is required for auto-merge, and `FAIL` actively gates the merge by closing the original issue out and queueing a follow-up. The reviewer's findings remain advisory only in the sense that the wrapper does not modify the rejected diff for you — the next implementer run on the follow-up is what addresses them.

**The visual verdict is a third observable terminal outcome**, alongside auto-merge and rejection. On a `ui` issue (see [Public API](#public-api)), the Visual-Iteration Engine runs before the reviewer and produces a `pass`/`fail` verdict. A visual **ceiling-fail** — the engine exhausting its iteration budget without reaching `pass` — blocks auto-merge even when the reviewer returns `PASS`, parking the issue at `needs-review` with the branch preserved and dependents skipped. This is **not** rejection-equivalent: unlike a reviewer `FAIL`, a visual fail keeps the editor's commits (they *are* the work) rather than discarding the branch and filing a follow-up. Hosts that parse outcomes should treat parked-at-`needs-review` as the third terminal state. See [ADR 0004](docs/adr/0004-visual-engine-drain-integration.md).

## Optional host content

Two host artifacts deepen the reviewer rubric. Both are optional; the wrapper degrades gracefully when they're absent.

- **`CONTEXT.md`** is the canonical domain glossary. If populated, the reviewer enforces nomenclature binding — every new type / table / file path / UI label in a diff must use the exact names defined in `CONTEXT.md`. If `CONTEXT.md` is still the empty stub, the nomenclature check is silently dropped (per the conditional rubric).
- **`docs/adr/`** holds architectural decision records. If populated, the reviewer reads the ADR index and flags any diff that contradicts a written decision. If the directory is empty, the ADR-alignment check is silently dropped.

Both files / directories live in the **host project's** working directory, not inside the installed library. The reviewer prompt template eager-loads them from the worktree at review time.

## Configuration knobs that exist today

One, narrowly scoped. The wrapper is otherwise opinionated:

- Model is pinned to `claude-opus-4-7`.
- Label set is fixed (`sandcastle`, `in-progress`, `needs-review`, `blocked`, `retry`, `priority`, `oversized`, `skipped-this-run`, `needs-info`, `ui`). `ui` is user-applied and opt-in per issue: add it to route an issue's UI work through the Visual-Iteration Engine. The engine only runs when the issue carries `ui` **and** the project ships a visual rubric + preview-adapter config — see [ADR 0004](docs/adr/0004-visual-engine-drain-integration.md).
- Paths are fixed (`<host-cwd>/.sandcastle-drain/staged/`, `<host-cwd>/.sandcastle-drain/worktrees/`, `<host-cwd>/.sandcastle-drain/logs/`).
- Implementer idle timeout: 10 minutes per run, **overridable via `--idle-timeout <seconds>`**. Wall-clock cap: 90 minutes per run. One auto-retry on idle / wall-clock timeout.
- Pre-agent dependency install timeout: 45 minutes, **overridable via `--pre-install-timeout <seconds>`** (or the `SANDCASTLE_DRAIN_PRE_INSTALL_TIMEOUT_SECONDS` env var, for projects that invoke `drain` through a fixed `npx` script; the flag wins when both are set). The default is generous because a large monorepo's install is slow on a Windows host — see [Windows install performance](#windows-install-performance).
- Reviewer / fixer budget: 5 minute idle, 30 minute wall-clock. Not user-tunable.

The `--idle-timeout` flag exists for one reason: a fresh-worktree cold start (especially a full `pnpm install` on a now-large monorepo) can legitimately exceed 10 minutes. If your runs are dying with `AgentIdleTimeoutError` during setup before the agent produces any output, raising the flag is the right fix. Don't raise it to mask a hanging hook — see the next section.

The dependency install runs *before* the agent boots (off the idle/wall-clock budget) as a sandbox hook. If it times out you'll see `HookTimeoutError: Hook 'pnpm install --frozen-lockfile' timed out`. The install's full stdout+stderr is captured to `<worktree>/.sandcastle/logs/pre-agent-install-<issue>.log` (under `.sandcastle/worktrees/agent-issue-<N>/`, which survives a Windows teardown failure) — read that to see *where* it stalled before raising `--pre-install-timeout`.

## Sandbox environment

The implementer, fixer, and reviewer agents all run inside the sandcastle Docker sandbox with two env vars set on top of whatever the image provides:

- `HUSKY=0` — **disables every git hook inside the sandbox.** Husky's recommended bypass, no `--no-verify` argument needed at the commit call site. The rationale: the wrapper's CI gate (`pnpm run typecheck && pnpm run lint && pnpm run test` in a clean worktree) is the canonical check. A downstream `pre-commit` hook running the same checks is redundant AND catastrophic — it produces no stdout the idle watcher can see, so a slow hook silently burns the idle budget and kills the run with no diagnostic. The wrapper's CI gate + fixer loop covers the same surface and reports failures explicitly.
- `CI=true` — parallel signal a lot of tools respect for "unattended run, skip interactive prompts."

On **Windows hosts running pnpm**, one more env var is set for the install (no-op on Linux/Mac, where the worktree bind mount is native and it isn't needed):

- `npm_config_virtual_store_dir=/home/agent/.pnpm-vstore` — relocates pnpm's virtual store off the bind mount. Docker Desktop's virtiofs/9p layer rejects pnpm's rename-into-place with `EACCES`; moving the store onto the container's own filesystem keeps every rename off the mount.

If your project has a `pre-commit` hook that does something the wrapper's CI gate genuinely doesn't replicate (e.g. secret scanning), move it to a `pre-push` hook the wrapper never invokes, or run it as a separate `package.json` script that the CI gate could pick up.

If you need to fork off these defaults for other reasons, fork the wrapper or open an issue. Future versions may expose a `sandcastle.config.ts` if users need it; today there is no escape hatch beyond editing source.

## Windows install performance

On a Windows host the agent worktree is bind-mounted into the Linux container through Docker Desktop's virtiofs/9p layer, and **writing a large monorepo's `node_modules` tree across that layer is slow** — measured at ~30 minutes for a ~1500-package pnpm workspace. That cost is the filesystem, not the network: warming the package store makes no meaningful difference, because the time goes into creating the symlink farm and per-workspace `node_modules` over the mount, not fetching from the registry. The 45-minute default install timeout exists to absorb this; raise it with `--pre-install-timeout` for an even larger repo.

The install runs *before* the agent boots (off the idle/wall-clock budget) as a sandbox hook. If it times out you'll see `HookTimeoutError: Hook 'pnpm install --frozen-lockfile' timed out`. Its full stdout+stderr is captured to `<worktree>/.sandcastle/logs/pre-agent-install-<issue>.log` — read that to see where it stalled.

**If you want fast installs on Windows, run the repo from the WSL2 filesystem** (a native ext4 mount, no virtiofs) rather than from `C:\…`. This is not required — the wrapper works from a native-Windows checkout — but it's the only thing that makes the install fast.

## Versioning discipline

This package follows semver with two specific contracts:

- **Principle file changes are minor.** Renaming a rule, adding a new principle file, tightening guidance — the host's `^x.y.z` range picks them up automatically and the next drain enforces them.
- **Reviewer rubric changes and reviewer JSON output schema changes are major.** Hosts may parse the verdict comment, and the set of review outcomes hosts see is part of the public contract. A new severity level, a renamed category, or a changed field shape bumps the major version. Pin the major version (`~x.y.z` or `x.y.x`) if you depend on a specific rubric shape.

Other public-API changes (CLI subcommand names, the staged-content layout under `dist/content/`, the orchestrator's exit codes, the `sandcastle-drain/visual-engine` subpath export and its types, the `visual` subcommand, the `ui` label, and the visual verdict / parked-at-`needs-review` outcome) also bump major.

> The package is pre-1.0, so the breaking-change slot is the **minor** version (`0.x.0`); `^0.x.y` already pins the minor for you. Introducing the visual-engine public surface bumped 0.3.x → 0.4.0 under exactly this discipline.

## Limitations

- **Windows worktree teardown.** pnpm's `node_modules/.pnpm/` symlink farm defeats standard recursive deletion on Windows; `git worktree remove` surfaces `Function not implemented`. The wrapper ships `removeWorktreeDir` in `dist/orchestrator/worktree-cleanup.ts` (uses `robocopy /MIR` against an empty source) and runs it before every drain to clean up orphans. Sandcastle's own internal teardown still throws on Windows after a successful agent run — the wrapper recovers commits via `tryRecoverCommits` and labels the run `ok (windows-teardown)`. This is the documented success path on Windows, not a failure mode.
- **No CI / GitHub Actions variant in v1.** The wrapper runs locally only. Authentication uses your volume-mounted Pro/Max OAuth credentials, which Sandcastle upstream does not first-class — don't deploy this to a cloud VM. See [issue #191 on mattpocock/sandcastle](https://github.com/mattpocock/sandcastle/issues/191) for upstream context.
- **Sandcastle is pinned to an exact version** in this package's dependencies. Treat upstream upgrades as breaking until you've re-tested the auth path and the worktree lifecycle.

## License

MIT. See [`LICENSE`](LICENSE).
