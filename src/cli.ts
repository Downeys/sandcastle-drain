#!/usr/bin/env node
/**
 * `sandcastle` CLI — the single entry point users invoke via `npx sandcastle
 * <subcommand>`. Three subcommands route to the existing orchestrators:
 *
 *   sandcastle drain          — drain the GitHub issue queue
 *   sandcastle ship <issue>   — push, PR, squash-merge an `agent/issue-N` branch
 *   sandcastle sweep <issue>  — post-merge worktree/branch cleanup
 *
 * Startup probes (`probeSkills`, `probeAuth`, `probeGhAuth`, `probeLabels`) run
 * once up-front regardless of subcommand so the user gets an actionable error
 * before any work begins. Paths inside the orchestrators resolve relative to
 * `process.cwd()` — the host project where `npx sandcastle` was invoked — not
 * the installed library's directory.
 */
import { runDrain } from './orchestrator/main.js';
import { runAllPrereqs } from './orchestrator/prereqs.js';
import { ShipError, shipBranch } from './orchestrator/ship.js';
import { SweepError, sweepBranch } from './orchestrator/sweep.js';
import { stage } from './stage.js';

const HELP_TEXT = `Usage: sandcastle <command> [args]

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
    fail(`Usage: sandcastle ${subcommand} <issue-number>  (e.g. \`sandcastle ${subcommand} 3\`)`);
  }
  return Number(arg);
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
  // expired token up-front beats failing mid-drain.
  const { token } = await runAllPrereqs();

  switch (subcommand) {
    case 'drain':
      // Stage library content (principles, agent-docs) into
      // <host-cwd>/.sandcastle/staged/ before the drain begins, so the
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

await main();
