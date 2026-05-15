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
import { runDrain } from './orchestrator/main.js';
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
  -h, --help          Show this help message

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
  switch (subcommand) {
    case 'drain':
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
      await runDrain({ token });
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
