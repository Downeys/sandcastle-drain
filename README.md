# Sandcastle drain

A local, attended autonomous-coding setup. Claude Code runs inside [Sandcastle](https://github.com/mattpocock/sandcastle) sandboxes, draining a queue of `sandcastle`-labeled GitHub issues one at a time and committing to per-issue branches that you review and push by hand.

> **This is not for unattended cloud operation.** Authentication uses your Claude Pro/Max subscription via a volume-mounted OAuth credential — an unsupported path that future Sandcastle releases may break (see [Auth caveat](#auth-caveat)). Run it on your own hardware while you're around to interrupt it.

## Customize for your project

Before the first drain, do the following in the project you've dropped this template into:

- **Populate `CONTEXT.md`** with your domain vocabulary. Until you do, the reviewer's nomenclature-binding check is a no-op.
- **Start writing ADRs in `docs/adr/`** as material decisions land. The reviewer reads them and flags diffs that contradict written decisions.
- **Add `typecheck`, `lint`, and `test` scripts to your `package.json`** — the wrapper's CI gate (`.sandcastle/ci-gate.ts`) invokes `pnpm typecheck`, `pnpm lint`, and `pnpm test` after every implementer commit, and refuses to ship if any fail. Stub them out (`"echo skip"`) only as a starting point; the gate is only useful once they actually run.
- **Optionally extend the reviewer rubric.** The genericized rubric in [.sandcastle/reviewer.md](.sandcastle/reviewer.md) Step 3 covers principle-level checks. Project-specific aggregate rules and ADR-grounded checks live in `CONTEXT.md` and `docs/adr/` — the reviewer eager-loads both and applies them automatically. If you want extra hard-coded checks (e.g. "no class extends X"), add them under the relevant category in `reviewer.md`.
- **The wrapper's Docker image** is named `sandcastle:<your-directory-name>` (derived from `basename(REPO_ROOT)` in [.sandcastle/main.ts](.sandcastle/main.ts)). `npx sandcastle docker build-image` produces this name without a flag.

## Contributing

Before making changes, read the development principles in [`docs/principles/`](docs/principles/README.md). Key files:

- **Language & types** — TypeScript strict mode, Zod at boundaries, branded types, tagged-union `Result<T,E>`
- **Architecture** — Onion rings (Domain / Application / External / Presentation), lint-enforced inward deps
- **Testing** — Vitest, 90% coverage gate on `packages/domain`, property-based with `fast-check`
- **Linting** — ESLint + `eslint-plugin-boundaries`, Prettier, Husky pre-commit

## Prerequisites

- Docker Desktop running
- Node 22+
- The `gh` CLI, authenticated against a GitHub remote on this repo
- The Claude Code CLI, authenticated locally with your Pro/Max subscription

## One-time setup

1. **Install dependencies**

   ```sh
   npm install
   ```

2. **Build the sandbox image**

   ```sh
   npx sandcastle docker build-image
   ```

   This builds the image declared in [`.sandcastle/Dockerfile`](.sandcastle/Dockerfile) (Node 22 + git + gh + Claude Code CLI + Playwright + Chromium) and tags it `sandcastle:<your-directory-name>`. Re-run it after editing the Dockerfile.

3. **Bootstrap auth into a host directory** (one shot)

   Replace `<your-dir-name>` with the directory this template lives in (e.g. `sandcastle-drain`, or whatever you renamed it to).

   PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force -Path "$HOME/.config/sandcastle-claude-creds" | Out-Null
   docker run -it --rm `
     --entrypoint claude `
     -v "${HOME}/.config/sandcastle-claude-creds:/home/agent/.claude" `
     sandcastle:<your-dir-name> `
     login
   ```

   Bash / zsh:

   ```sh
   mkdir -p ~/.config/sandcastle-claude-creds
   docker run -it --rm \
     --entrypoint claude \
     -v ~/.config/sandcastle-claude-creds:/home/agent/.claude \
     sandcastle:<your-dir-name> \
     login
   ```

   `--entrypoint claude` is required because the Sandcastle base image sets `ENTRYPOINT ["sleep", "infinity"]`. Without the override, `claude login` would be appended as arguments to `sleep` instead of replacing it. In the PowerShell version, `${HOME}` is expanded by PowerShell before docker sees the `-v` argument — `~` would be passed through literally and docker would create a directory named `~`.

   This runs the device-code OAuth flow once and persists the resulting credentials to `~/.config/sandcastle-claude-creds/`. The wrapper bind-mounts that directory into every subsequent run. Re-run this command if a drain reports auth errors mid-flight.

4. **Make sure this clone has a GitHub remote**

   ```sh
   git remote -v
   # If empty:
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```

   The wrapper's first run also probes that every label it touches (`sandcastle`, `in-progress`, `needs-review`, `blocked`, `retry`, `priority`, `needs-info`, `oversized`) exists in the repo and creates any that are missing — no manual label bootstrap needed.

5. **Install workflow skills to your home directory** (one-time, not tied to this repo)

   PowerShell:

   ```powershell
   Set-Location $HOME
   npx skills@latest add mattpocock/skills `
     -s grill-me -s to-prd -s to-issues -s triage -s grill-with-docs `
     -a claude-code -y
   ```

   Bash / zsh:

   ```sh
   cd ~
   npx skills@latest add mattpocock/skills \
     -s grill-me -s to-prd -s to-issues -s triage -s grill-with-docs \
     -a claude-code -y
   ```

   These are interactive skills you use from your local Claude Code, not the agent — they live in `~/.claude/skills/` and never enter any container. The agent-side skills (`tdd`, `diagnose`, `zoom-out`) are committed to this repo under [`.claude/skills/`](.claude/skills/).

## Daily workflow

1. **Fill the backlog (locally, with you driving)**

   Use Claude Code interactively in this repo and invoke `grill-me` → `to-prd` → `to-issues` to spec a piece of work, then create one or more `sandcastle`-labeled issues from the resulting PRD.

2. **Drain the queue**

   ```sh
   npx tsx .sandcastle/main.ts
   ```

   The wrapper:
   - Probes `.claude/skills/{tdd,diagnose}/SKILL.md` and `claude --version` before doing anything network-side.
   - Picks the oldest open issue with `sandcastle` that doesn't also have `in-progress` or `blocked`.
   - Adds `in-progress`, runs the agent in a fresh sandbox on a branch named `agent/issue-<N>`, then posts a status comment to the issue and applies outcome labels.
   - Continues until the queue is empty, a rate-limit signal is detected, or you Ctrl-C it.

3. **Review each `agent/issue-*` branch**

   The wrapper transitions issues to one of three terminal states (see [docs/agents/triage-labels.md](docs/agents/triage-labels.md) for the full table):

   | Outcome from wrapper                                                    | Your move                                                                                                                                                                                                                                                                                                                                                            |
   | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `needs-review` (commits exist)                                          | Check out the branch. **Branch is good** → `git push` + open PR + merge. **Branch is wrong-headed** → comment what was wrong, swap `needs-review` for `sandcastle` + `retry`; the next drain discards the branch and re-attempts. **Branch needs minor tweaks** → just standard git: `git checkout`, edit, commit, push, PR. No agent involvement, no label changes. |
   | `needs-info` (no commits, agent emitted COMPLETE)                       | The agent had a question rather than work. Read the comment + the agent's output, clarify on the issue, then re-add `sandcastle` if you want to re-queue it.                                                                                                                                                                                                         |
   | `sandcastle` (no commits, no completion signal — timeout or hard error) | The wrapper leaves the issue in the queue. Re-run the drain, or if the issue is consistently failing, swap `sandcastle` for `blocked` and look at the log.                                                                                                                                                                                                           |

## Label vocabulary

Five canonical triage states and the Sandcastle workflow labels — see [docs/agents/triage-labels.md](docs/agents/triage-labels.md). The wrapper-managed transitions live there too. Don't duplicate the table here; two sources of truth will drift.

## Auth caveat

Sandcastle issue [#191](https://github.com/mattpocock/sandcastle/issues/191) ("support Claude subscription auth") is closed wontfix; the maintainers' first-class auth path is `ANTHROPIC_API_KEY`. This template uses volume-mounted Pro/Max OAuth credentials anyway because the alternative is double-paying for Pro/Max + API access on a single-user, attended tool.

Three guardrails:

- **Sandcastle is pinned to an exact version** in `package.json` (currently `0.5.7`). Don't bump with `^` — read the changelog and re-test before upgrading.
- **The wrapper does a startup auth probe** — it checks the credential dir exists and `claude --version` succeeds before entering the loop. If you get an auth-related failure mid-drain, re-run the bootstrap from step 3 of one-time setup.
- **The wrapper is local-only.** Don't deploy it to a cloud VM under a Pro/Max subscription.

Symptoms that mean re-bootstrap auth: the agent's first iteration fails with an auth-style error within ~30s of the run starting (the wrapper logs it under `.sandcastle/logs/`), or every issue in the drain fails identically with no visible work.

## Timeouts

The wrapper sets two timeouts on every run:

- **`idleTimeoutSeconds: 600`** — 10 minutes of agent silence kills the run. Resets on every line of output, so a chatty-but-looping agent doesn't trip it.
- **`signal: AbortSignal.timeout(5_400_000)`** — 90 minutes of wall-clock catches the chatty-loop case.

If a 90-minute run isn't enough, the right move is to split the issue smaller, not to bump this number.

## Rate-limit handling

The wrapper detects rate limits by string-matching the agent's output for any of:

```
rate limit
usage limit
Please try again
```

If hit, the loop exits cleanly and the remaining issues are reported as `skipped (rate-limited)` in the summary. Update the [`RATE_LIMIT_MARKERS` constant in `.sandcastle/main.ts`](.sandcastle/main.ts) if you encounter different language in real errors.

## Don't push from inside the sandbox

The agent is instructed not to run `git push` or `gh pr create`. The wrapper does a cheap defensive check after every run (`git rev-parse --verify origin/agent/issue-<N>`) and surfaces a warning in the status comment if the branch was pushed anyway. **If you ever see `agent/issue-N` on the remote, that's a bug in this wrapper or the prompt — file an issue.**

## Project layout

```
.
├── .claude/
│   └── skills/         (agent-side skills: tdd, diagnose, zoom-out — committed)
├── .sandcastle/
│   ├── Dockerfile      (Node 22 + git + gh + Claude Code CLI + Playwright)
│   ├── main.ts         (wrapper: queue + per-issue flow + state machine)
│   ├── prompt.md       (agent prompt; uses {{ISSUE_NUMBER}} / {{ISSUE_TITLE}})
│   ├── reviewer.md     (advisory reviewer prompt)
│   └── ...             (ship, sweep, ci-gate, rejection, splits, etc.)
├── docs/
│   ├── adr/            (architectural decisions — start empty, add as you decide)
│   ├── agents/         (issue-tracker / triage-labels / windows-cleanup)
│   └── principles/     (development principles — apply to every commit)
├── CLAUDE.md           (project guidance for Claude Code)
├── CONTEXT.md          (canonical domain vocabulary — populate before domain code)
└── README.md
```
