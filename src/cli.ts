#!/usr/bin/env node
/**
 * `sandcastle-drain` CLI — the single entry point users invoke via `npx sandcastle-drain
 * <subcommand>`. Three subcommands route to the existing orchestrators:
 *
 *   sandcastle-drain drain          — drain the GitHub issue queue
 *   sandcastle-drain ship <issue>   — push, PR, squash-merge an `agent/issue-N` branch
 *   sandcastle-drain sweep <issue>  — post-merge worktree/branch cleanup
 *
 * Startup probes (`probeSkills`, `probeAuth`, `probeGhAuth`, `probeLabels`) run
 * once up-front regardless of subcommand so the user gets an actionable error
 * before any work begins. Paths inside the orchestrators resolve relative to
 * `process.cwd()` — the host project where `npx sandcastle-drain` was invoked — not
 * the installed library's directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_PRE_INSTALL_TIMEOUT_SECONDS, runDrain } from './orchestrator/main.js';
import { runAllPrereqs } from './orchestrator/prereqs.js';
import { ShipError, shipBranch } from './orchestrator/ship.js';
import { SweepError, sweepBranch } from './orchestrator/sweep.js';
import { stage } from './stage.js';

const HELP_TEXT = `Usage: sandcastle-drain <command> [args]

Commands:
  drain               Drain the queue of \`sandcastle\`-labeled GitHub issues
  ship <issue>        Push, open a PR, and squash-merge \`agent/issue-<N>\`
  sweep <issue>       Post-merge cleanup: remove worktree, delete local branch

Options:
  -h, --help                  Show this help message
  --idle-timeout <seconds>    (drain only) Override the implementer idle timeout
                              (default 600). Raise this for projects whose first
                              tool calls in a fresh worktree legitimately exceed
                              10 minutes (e.g. huge install or codegen step).
  --pre-install-timeout <seconds>
                              (drain only) Override the pre-agent dependency
                              install timeout (default 2700 = 45 min). On a
                              Windows host a large monorepo's install is slow
                              (~30 min over the virtiofs bind mount); raise this
                              for an even larger repo. Also settable via the
                              SANDCASTLE_DRAIN_PRE_INSTALL_TIMEOUT_SECONDS env var
                              (the flag wins when both are set).

All paths resolve relative to the current working directory.`;

function printHelp(): void {
  console.log(HELP_TEXT);
}

function fail(msg: string, opts: { showHelp?: boolean } = {}): never {
  console.error(msg);
  if (opts.showHelp) {
    console.error('');
    console.error(HELP_TEXT);
  }
  process.exit(1);
}

function parseIssueArg(subcommand: string, arg: string | undefined): number {
  if (!arg || !/^\d+$/.test(arg)) {
    fail(`Usage: sandcastle-drain ${subcommand} <issue-number>  (e.g. \`sandcastle-drain ${subcommand} 3\`)`);
  }
  return Number(arg);
}

// Minimum guards against foot-guns (`--idle-timeout 0` would immediately kill
// every run); upper bound is left open because legitimate slow paths exist
// (cold pnpm install on a now-large monorepo, heavy codegen).
const MIN_IDLE_TIMEOUT_SECONDS = 60;

export interface DrainFlags {
  idleTimeoutSeconds?: number;
  preInstallTimeoutSeconds?: number;
}

// Matches `arg` against the known flag names in both `--flag value` and
// `--flag=value` forms. Returns the canonical flag name plus the inline value
// when the `=` form was used (undefined means "value is the next arg").
function matchFlag(
  arg: string,
  names: readonly string[],
): { name: string; inlineValue: string | undefined } | null {
  for (const name of names) {
    if (arg === name) return { name, inlineValue: undefined };
    if (arg.startsWith(`${name}=`)) return { name, inlineValue: arg.slice(name.length + 1) };
  }
  return null;
}

// Parses `drain`-subcommand flags: `--idle-timeout <seconds>` and
// `--pre-install-timeout <seconds>` (both also accept the `--flag=<seconds>`
// form). Unknown flags fail fast so a typo doesn't silently get ignored mid-run.
export function parseDrainFlags(args: readonly string[]): DrainFlags {
  const out: DrainFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const match = matchFlag(arg, ['--idle-timeout', '--pre-install-timeout']);
    if (!match) {
      fail(`Unknown drain flag: ${arg}`, { showHelp: true });
    }
    let value = match.inlineValue;
    if (value === undefined) {
      value = args[i + 1];
      i += 1;
    }
    if (!value || !/^\d+$/.test(value)) {
      fail(`${match.name} expects a positive integer (got: ${value ?? '<missing>'})`);
    }
    const seconds = Number(value);
    if (match.name === '--idle-timeout') {
      if (seconds < MIN_IDLE_TIMEOUT_SECONDS) {
        fail(
          `--idle-timeout must be at least ${MIN_IDLE_TIMEOUT_SECONDS}s (got: ${seconds}). Setting it below the cold-start budget guarantees timeouts.`,
        );
      }
      out.idleTimeoutSeconds = seconds;
    } else {
      if (seconds < MIN_PRE_INSTALL_TIMEOUT_SECONDS) {
        fail(
          `--pre-install-timeout must be at least ${MIN_PRE_INSTALL_TIMEOUT_SECONDS}s (got: ${seconds}). Setting it below the cold-install budget guarantees timeouts.`,
        );
      }
      out.preInstallTimeoutSeconds = seconds;
    }
  }
  return out;
}

function reportUnexpectedError(when: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : String(err);
  const logPath = join(process.cwd(), '.sandcastle-drain', 'logs', 'sandcastle-startup.log');
  let logRef = logPath;
  try {
    mkdirSync(join(process.cwd(), '.sandcastle-drain', 'logs'), { recursive: true });
    writeFileSync(logPath, `${new Date().toISOString()}\n${stack}\n`);
  } catch {
    logRef = '(could not write log file)';
  }
  console.error(`sandcastle-drain: unexpected error ${when}: ${message}`);
  console.error(`See ${logRef} for details.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    printHelp();
    return;
  }

  // Validate args before running prereqs so usage errors don't depend on
  // `gh` being authed — a missing issue number should fail fast with help text.
  let issue: number | undefined;
  let drainFlags: DrainFlags = {};
  switch (subcommand) {
    case 'drain':
      drainFlags = parseDrainFlags(rest);
      break;
    case 'ship':
    case 'sweep':
      issue = parseIssueArg(subcommand, rest[0]);
      break;
    default:
      fail(`Unknown command: ${subcommand}`, { showHelp: true });
  }

  // Prereqs run once before any subcommand. The probes are cheap (a few exec
  // calls + a single `gh label list`), and surfacing a missing skill or
  // expired token up-front beats failing mid-drain. Wrap in a try/catch so an
  // unexpected throw (e.g. `gh` returning unparseable JSON, an EACCES on the
  // skills check) becomes a clean one-liner with a log file pointer instead
  // of a raw stack trace.
  let token: string;
  try {
    ({ token } = await runAllPrereqs());
  } catch (err) {
    reportUnexpectedError('during startup', err);
  }

  switch (subcommand) {
    case 'drain':
      // Stage library content (principles, agent-docs) into
      // <host-cwd>/.sandcastle-drain/staged/ before the drain begins, so the
      // per-issue worktrees can copy it in via `copyToWorktree`. Prompts are
      // rendered in memory by `src/render-prompt.ts` and never materialize on
      // the host filesystem.
      await stage(process.cwd());
      await runDrain({
        token,
        idleTimeoutSeconds: drainFlags.idleTimeoutSeconds,
        preInstallTimeoutSeconds: drainFlags.preInstallTimeoutSeconds,
      });
      return;
    case 'ship':
      try {
        await shipBranch({ issue: issue as number });
      } catch (err) {
        if (err instanceof ShipError) fail(`[ship] ${err.message}`);
        throw err;
      }
      return;
    case 'sweep':
      try {
        await sweepBranch({ issue: issue as number });
      } catch (err) {
        if (err instanceof SweepError) fail(`[sweep] ${err.message}`);
        throw err;
      }
      return;
  }
}

try {
  await main();
} catch (err) {
  // Catches anything that escaped the subcommand handlers (the prereq path
  // has its own wrapper that adds "during startup" context).
  reportUnexpectedError('after startup', err);
}
