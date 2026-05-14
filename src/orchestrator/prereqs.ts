/**
 * Shared startup probes the CLI runs once before dispatching to drain / ship /
 * sweep. Each probe returns an actionable error string (or `null` on success)
 * rather than throwing or exiting itself — `runAllPrereqs` is the single place
 * that turns a failed probe into a non-zero exit so subcommands can stay pure.
 *
 * Also owns the wrapper's shared host-side constants (REPO_ROOT, IMAGE_NAME,
 * credential paths) so the CLI is the only place that resolves `process.cwd()`
 * and every subcommand sees the same view of "where the host project lives".
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Host-project root: when `npx sandcastle` is run, this is the user's project
// directory (where their `.sandcastle/`, `.git/`, etc. live), NOT the installed
// library's directory. Computed once at module load — `process.cwd()` is stable
// for the lifetime of the process.
export const REPO_ROOT = process.cwd();

// Matches Sandcastle's default image-name convention: `sandcastle:<dir-name>`.
// `npx sandcastle docker build-image` produces this name without a flag; we
// derive it from the host project's directory name so the wrapper stays
// portable across user projects.
export const IMAGE_NAME = `sandcastle:${basename(REPO_ROOT)}`;

export const HOST_CREDS_PATH = join(homedir(), '.config', 'sandcastle-claude-creds');
export const SANDBOX_CREDS_PATH = '/home/agent/.claude';

// Skills the implementer prompt depends on. probeSkills enforces these exist
// under `.claude/skills/` before any subcommand runs.
export const REQUIRED_SKILLS = ['tdd', 'diagnose'] as const;

export interface LabelDefinition {
  name: string;
  description: string;
  color: string;
}

// Canonical wrapper-touched labels. `probeLabels` ensures each exists in the
// GitHub repo before the drain starts — without this, a fresh clone hits a
// hard crash the first time the rejection loop fires (the `priority` label
// is referenced by code but isn't a default GitHub label).
export const LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  {
    name: 'sandcastle',
    description: 'Queued for the Sandcastle wrapper to drain',
    color: '5319E7',
  },
  {
    name: 'in-progress',
    description: 'Sandcastle wrapper picked up the issue (wrapper-managed)',
    color: 'FEF2C0',
  },
  {
    name: 'needs-review',
    description: 'Sandcastle run produced commits — review before merging',
    color: 'E99695',
  },
  { name: 'blocked', description: 'Skip this issue (manually applied)', color: 'B60205' },
  {
    name: 'retry',
    description: 'Discard prior agent attempt and re-run (apply alongside sandcastle)',
    color: 'D4C5F9',
  },
  {
    name: 'priority',
    description: 'Sandcastle rejection-loop follow-up jumps the queue (wrapper-managed)',
    color: 'E11D21',
  },
  { name: 'needs-info', description: 'Waiting for more information', color: 'D93F0B' },
  {
    name: 'oversized',
    description: 'Sandcastle run exceeded the 150k context ceiling — split via to-issues',
    color: 'CCCCCC',
  },
  {
    name: 'skipped-this-run',
    description: 'Most recent drain skipped this issue — see latest comment (wrapper-managed)',
    color: 'BFD4F2',
  },
];

export function probeSkills(): string[] {
  const missing: string[] = [];
  for (const skill of REQUIRED_SKILLS) {
    const path = join(REPO_ROOT, '.claude', 'skills', skill, 'SKILL.md');
    if (!existsSync(path)) missing.push(skill);
  }
  return missing;
}

export async function probeAuth(): Promise<string | null> {
  // Light auth probe: credential file present + claude --version succeeds on
  // the host. We do NOT make a real API call — that's network spend, slow,
  // and the actual sandbox will fail loudly within ~30s of the run starting
  // if the OAuth token has been revoked.
  if (!existsSync(HOST_CREDS_PATH)) {
    return `OAuth credential directory not found at ${HOST_CREDS_PATH}. Bootstrap with:\n  docker run -it --rm --entrypoint claude -v ${HOST_CREDS_PATH}:/home/agent/.claude ${IMAGE_NAME} login`;
  }
  const result = await execa('claude', ['--version'], { reject: false });
  if (result.exitCode !== 0) {
    return `\`claude --version\` failed on the host. Make sure the Claude Code CLI is installed and on PATH.`;
  }
  return null;
}

export async function probeGhAuth(): Promise<{ token: string } | string> {
  // The wrapper itself uses host-side gh for queue / labels / comments — but
  // the prompt's `!gh issue view ...` shell-expansion block runs *inside* the
  // sandbox, where no auth exists by default. Sandcastle does not bridge
  // keyring auth into the container, so we export the token here and pass it
  // through as GH_TOKEN. (On Windows the keyring is Credential Manager, which
  // isn't mountable as a file, so token-via-env is the only viable path.)
  const versionResult = await execa('gh', ['--version'], { reject: false });
  if (versionResult.exitCode !== 0) {
    return '`gh --version` failed on the host. Install GitHub CLI and run `gh auth login`.';
  }
  const tokenResult = await execa('gh', ['auth', 'token'], { reject: false });
  if (tokenResult.exitCode !== 0) {
    return `\`gh auth token\` failed on the host. Run \`gh auth login\`.\n${tokenResult.stderr}`;
  }
  const token = tokenResult.stdout.trim();
  if (!token) {
    return '`gh auth token` returned empty. Run `gh auth login`.';
  }
  return { token };
}

// Ensures every canonical wrapper-touched label exists in the repo. Idempotent:
// only creates missing labels, never edits existing ones (so a human who
// recolored a label keeps their choice). The historical reason this exists:
// the `priority` label is referenced by the rejection-loop code but isn't a
// default GitHub label — a fresh clone would crash the first time the
// reviewer FAILed on a commit.
export async function probeLabels(): Promise<string | null> {
  let existing: ReadonlySet<string>;
  try {
    const listResult = await execa(
      'gh',
      ['label', 'list', '--limit', '200', '--json', 'name'],
      { cwd: REPO_ROOT, reject: false },
    );
    if (listResult.exitCode !== 0) {
      return `\`gh label list\` failed: ${listResult.stderr || listResult.stdout}`;
    }
    const rows = JSON.parse(listResult.stdout) as ReadonlyArray<{ name: string }>;
    existing = new Set(rows.map((r) => r.name));
  } catch (err) {
    return `\`gh label list\` failed: ${(err as Error).message}`;
  }

  const missing = LABEL_DEFINITIONS.filter((d) => !existing.has(d.name));
  if (missing.length === 0) {
    console.log('[wrapper] all canonical labels present');
    return null;
  }

  for (const def of missing) {
    const createResult = await execa(
      'gh',
      [
        'label',
        'create',
        def.name,
        '--description',
        def.description,
        '--color',
        def.color,
      ],
      { cwd: REPO_ROOT, reject: false },
    );
    if (createResult.exitCode !== 0) {
      return `failed to create label '${def.name}': ${createResult.stderr || createResult.stdout}`;
    }
    console.log(`[wrapper] created missing label: ${def.name}`);
  }
  return null;
}

/**
 * Runs every startup probe in order. On any failure, logs the actionable error
 * to stderr and exits the process with code 1. On success, returns the gh
 * token so the caller can pass it into the sandbox as GH_TOKEN.
 *
 * This is the single place the CLI converts probe results into a process exit,
 * keeping the individual probes pure (and unit-testable) functions that just
 * report what they found.
 */
export async function runAllPrereqs(): Promise<{ token: string }> {
  const missingSkills = probeSkills();
  if (missingSkills.length > 0) {
    console.error(
      `[wrapper] FATAL: missing required skills under .claude/skills/: ${missingSkills.join(', ')}`,
    );
    console.error(
      `[wrapper] Install with: npx skills@latest add mattpocock/skills/<name> — and commit them.`,
    );
    process.exit(1);
  }

  const authError = await probeAuth();
  if (authError) {
    console.error(`[wrapper] FATAL: ${authError}`);
    process.exit(1);
  }

  const ghAuth = await probeGhAuth();
  if (typeof ghAuth === 'string') {
    console.error(`[wrapper] FATAL: ${ghAuth}`);
    process.exit(1);
  }

  const labelsError = await probeLabels();
  if (labelsError) {
    console.error(`[wrapper] FATAL: ${labelsError}`);
    process.exit(1);
  }

  return { token: ghAuth.token };
}
