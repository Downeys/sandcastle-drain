# sandcastle-drain

A wrapper around [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle) that drains a queue of GitHub issues labeled `sandcastle`, runs Claude Code against each in an isolated Docker worktree, and posts results back to the issue. Ships an opinionated set of engineering principles and a reviewer rubric that enforces them.

## Prerequisites

The wrapper relies on the host machine to supply these. None of them are installed for you.

- **Docker installed and running.** The agent runs inside the container declared in `docker/Dockerfile` (Node 22 + git + gh + Claude Code CLI + Playwright + Chromium).
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
- **A GitHub repo with the canonical labels.** The wrapper auto-creates any missing labels (`sandcastle`, `in-progress`, `needs-review`, `blocked`, `retry`, `priority`, `oversized`, `skipped-this-run`, `needs-info`) on first run.

## Install

```sh
npm install --save-dev sandcastle-drain
```

The package exposes a single binary, `sandcastle`. Invoke it via `npx`:

```sh
npx sandcastle <subcommand>
```

## Usage

| Command                 | What it does                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `npx sandcastle drain`  | Process every open issue labeled `sandcastle`. One agent run per issue, on a branch `agent/issue-N`.    |
| `npx sandcastle ship N` | Push `agent/issue-N`, open a PR with `Closes #N`, squash-merge it, and delete the remote branch.       |
| `npx sandcastle sweep N`| Post-merge cleanup: pull main, remove the worktree directory, prune git's worktree metadata, delete the local branch. Refuses to run unless a MERGED PR exists for the branch. |

All paths resolve relative to the host working directory where you ran `npx sandcastle`. The wrapper writes runtime artifacts to `<host-cwd>/.sandcastle/` (logs, worktrees, staged content, optional `splits.json`).

## What the wrapper enforces

Two layers run on every implementer commit: a fixed set of **development principles** the implementer must follow, and a four-category **reviewer rubric** that audits the diff after the commits land.

The principle files ship inside the package at `dist/content/principles/` and are staged into `<host-cwd>/.sandcastle/staged/principles/` before each drain so the agent can read them from inside the sandbox. Twelve files cover language and types, architecture (onion layers), CQRS, frontend organization, domain modeling, testing, linting and tooling, clean code, personal-use trade-offs, context-budget discipline (100k target / 150k ceiling), Claude Code interactive-vs-autonomous mode deltas, and a README that indexes the rest. Both the implementer and the reviewer eager-load the relevant files.

The reviewer rubric is four categories. **Domain integrity** flags anemic-model violations and any aggregate-specific invariants the host has written into `CONTEXT.md` or an ADR. **Test discipline** enforces the behavior-required test rule (every commit that introduces testable behavior ships with tests), property-based testing on state machines, and integration tests that hit real infrastructure rather than mocks. **Architecture intent** rejects inheritance of domain classes, impurity in the domain layer, and cross-layer imports that violate the onion direction. **Glossary & ADR alignment** checks that new names match `CONTEXT.md` verbatim and that diffs don't contradict any ADR under `docs/adr/`.

## Reviewer-gating behavior

The reviewer is **gating in the success path** and emits findings advisorily on the rejection path — it is not "advisory only." `handleRejection` in `dist/orchestrator/main.ts` is the load-bearing function; the flow is:

1. After the implementer commits and the CI gate passes, the reviewer sub-agent runs read-only against the worktree and emits a JSON verdict (`PASS` or `FAIL`) with a structured findings array.
2. **`PASS` + CI green** → the wrapper auto-ships and sweeps: push, open a PR with `Closes #N`, squash-merge, delete the remote branch. The issue auto-closes via the squash-merge body.
3. **`FAIL`** → `handleRejection` tags the branch tip as `rejected/issue-N-attempt-K` (preserving the work), discards the local branch, files a new GitHub issue titled `[follow-up #N] <original title>` labeled `sandcastle` + `priority` whose body carries the reviewer findings + the list of changed files + commit titles, comments on the original linking the follow-up, and closes the original. The next drain cycle picks up the `priority`-labeled follow-up first, combined with auto-ship this prevents the rejected branch from merging until a follow-up passes.
4. **Reviewer parse error or throw** → the wrapper posts an error comment on the issue, labels it `needs-review`, and leaves the branch in place for the human to inspect.

So `PASS` is required for auto-merge, and `FAIL` actively gates the merge by closing the original issue out and queueing a follow-up. The reviewer's findings remain advisory only in the sense that the wrapper does not modify the rejected diff for you — the next implementer run on the follow-up is what addresses them.

## Optional host content

Two host artifacts deepen the reviewer rubric. Both are optional; the wrapper degrades gracefully when they're absent.

- **`CONTEXT.md`** is the canonical domain glossary. If populated, the reviewer enforces nomenclature binding — every new type / table / file path / UI label in a diff must use the exact names defined in `CONTEXT.md`. If `CONTEXT.md` is still the empty stub, the nomenclature check is silently dropped (per the conditional rubric).
- **`docs/adr/`** holds architectural decision records. If populated, the reviewer reads the ADR index and flags any diff that contradicts a written decision. If the directory is empty, the ADR-alignment check is silently dropped.

Both files / directories live in the **host project's** working directory, not inside the installed library. The reviewer prompt template eager-loads them from the worktree at review time.

## Configuration knobs that exist today

None, intentionally. The wrapper is opinionated:

- Model is pinned to `claude-opus-4-7`.
- Label set is fixed (`sandcastle`, `in-progress`, `needs-review`, `blocked`, `retry`, `priority`, `oversized`, `skipped-this-run`, `needs-info`).
- Paths are fixed (`<host-cwd>/.sandcastle/staged/`, `<host-cwd>/.sandcastle/worktrees/`, `<host-cwd>/.sandcastle/logs/`).
- Idle timeout: 10 minutes per run. Wall-clock cap: 90 minutes per run. One auto-retry on idle / wall-clock timeout.
- Reviewer budget: 5 minute idle, 30 minute wall-clock.

If you need different values, fork the wrapper or open an issue. Future versions may expose a `sandcastle.config.ts` if users need it; today there is no escape hatch beyond editing source.

## Versioning discipline

This package follows semver with two specific contracts:

- **Principle file changes are minor.** Renaming a rule, adding a new principle file, tightening guidance — the host's `^x.y.z` range picks them up automatically and the next drain enforces them.
- **Reviewer rubric changes and reviewer JSON output schema changes are major.** Hosts may parse the verdict comment, and the set of review outcomes hosts see is part of the public contract. A new severity level, a renamed category, or a changed field shape bumps the major version. Pin the major version (`~x.y.z` or `x.y.x`) if you depend on a specific rubric shape.

Other public-API changes (CLI subcommand names, the staged-content layout under `dist/content/`, the orchestrator's exit codes) also bump major.

## Limitations

- **Windows worktree teardown.** pnpm's `node_modules/.pnpm/` symlink farm defeats standard recursive deletion on Windows; `git worktree remove` surfaces `Function not implemented`. The wrapper ships `removeWorktreeDir` in `dist/orchestrator/worktree-cleanup.ts` (uses `robocopy /MIR` against an empty source) and runs it before every drain to clean up orphans. Sandcastle's own internal teardown still throws on Windows after a successful agent run — the wrapper recovers commits via `tryRecoverCommits` and labels the run `ok (windows-teardown)`. This is the documented success path on Windows, not a failure mode.
- **No CI / GitHub Actions variant in v1.** The wrapper runs locally only. Authentication uses your volume-mounted Pro/Max OAuth credentials, which Sandcastle upstream does not first-class — don't deploy this to a cloud VM. See [issue #191 on mattpocock/sandcastle](https://github.com/mattpocock/sandcastle/issues/191) for upstream context.
- **Sandcastle is pinned to an exact version** in this package's dependencies. Treat upstream upgrades as breaking until you've re-tested the auth path and the worktree lifecycle.

## License

MIT. See [`LICENSE`](LICENSE).
