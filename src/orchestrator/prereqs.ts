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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Host-project root: when `npx sandcastle-drain` is run, this is the user's project
// directory (where their `.sandcastle-drain/`, `.git/`, etc. live), NOT the installed
// library's directory. Computed once at module load — `process.cwd()` is stable
// for the lifetime of the process.
export const REPO_ROOT = process.cwd();

// Matches Sandcastle's default image-name convention: `sandcastle:<dir-name>`.
// `npx sandcastle docker build-image` (the @ai-hero/sandcastle CLI, not this
// wrapper) produces this name without a flag; we derive it from the host
// project's directory name so the wrapper stays portable across user projects.
export const IMAGE_NAME = `sandcastle:${basename(REPO_ROOT)}`;

export const HOST_CREDS_PATH = join(homedir(), '.config', 'sandcastle-claude-creds');
export const SANDBOX_CREDS_PATH = '/home/agent/.claude';

// Path to the Dockerfile bundled inside this package. Same relative path
// resolves correctly from both `src/orchestrator/prereqs.ts` (dev via tsx)
// and `dist/orchestrator/prereqs.js` (installed npm package), because
// `docker/Dockerfile` sits at the package root in both layouts and is
// declared in package.json#files. probeImage builds the wrapper's sandbox
// image directly from this file — sandcastle's default `.sandcastle/`
// directory in the host project is deliberately not consulted.
export const BUNDLED_DOCKERFILE_PATH = fileURLToPath(
  new URL('../../docker/Dockerfile', import.meta.url),
);
const DOCKERFILE_SHA_LABEL = 'sandcastle-drain.dockerfile-sha';

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
    description: 'Queued for sandcastle-drain to process',
    color: '5319E7',
  },
  {
    name: 'in-progress',
    description: 'sandcastle-drain picked up the issue (wrapper-managed)',
    color: 'FEF2C0',
  },
  {
    name: 'needs-review',
    description: 'sandcastle-drain run produced commits — review before merging',
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
    description: 'sandcastle-drain rejection-loop follow-up jumps the queue (wrapper-managed)',
    color: 'E11D21',
  },
  { name: 'needs-info', description: 'Waiting for more information', color: 'D93F0B' },
  {
    name: 'oversized',
    description: 'sandcastle-drain run exceeded the 150k context ceiling — split via to-issues',
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
    return `\`claude --version\` failed on the host — the Claude Code CLI is not installed or not on PATH. Install with:\n  npm install -g @anthropic-ai/claude-code`;
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
    return `\`gh --version\` failed on the host — the GitHub CLI is not installed or not on PATH. Install from:\n  https://cli.github.com/`;
  }
  const tokenResult = await execa('gh', ['auth', 'token'], { reject: false });
  if (tokenResult.exitCode !== 0) {
    return `GitHub CLI is not authenticated on the host. Run:\n  gh auth login`;
  }
  const token = tokenResult.stdout.trim();
  if (!token) {
    return `GitHub CLI returned an empty auth token. Run:\n  gh auth login`;
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

// Ensures the sandbox image (sandcastle:<basename(REPO_ROOT)>) exists and was
// built from the Dockerfile bundled in this package version. Compares a
// SHA-256 of the bundled Dockerfile against a label baked into the image at
// build time; rebuilds when the label is missing or mismatched.
//
// Why this exists: sandcastle's docker provider only starts containers, it
// doesn't build images, and its standalone `docker build-image` CLI reads
// `<cwd>/.sandcastle/Dockerfile` — a file the wrapper has no control over.
// Without this probe, fixes shipped in `docker/Dockerfile` (e.g. the Corepack
// lines that make pnpm/yarn install hooks work) never reach the running
// image.
export async function probeImage(): Promise<string | null> {
  const dockerfile = readFileSync(BUNDLED_DOCKERFILE_PATH);
  const expectedSha = createHash('sha256').update(dockerfile).digest('hex');

  const inspectResult = await execa(
    'docker',
    [
      'image',
      'inspect',
      '--format',
      `{{ index .Config.Labels "${DOCKERFILE_SHA_LABEL}" }}`,
      IMAGE_NAME,
    ],
    { reject: false },
  );
  if (inspectResult.exitCode === 0 && inspectResult.stdout.trim() === expectedSha) {
    console.log(`[wrapper] image ${IMAGE_NAME} up to date`);
    return null;
  }

  const reason = inspectResult.exitCode === 0 ? 'stale' : 'missing';
  console.log(
    `[wrapper] image ${IMAGE_NAME} is ${reason}; rebuilding from bundled Dockerfile (one-time, ~5 min)…`,
  );
  const buildResult = await execa(
    'docker',
    [
      'build',
      '--build-arg',
      `DOCKERFILE_SHA=${expectedSha}`,
      '-f',
      BUNDLED_DOCKERFILE_PATH,
      '-t',
      IMAGE_NAME,
      dirname(BUNDLED_DOCKERFILE_PATH),
    ],
    { stdio: 'inherit', reject: false },
  );
  if (buildResult.exitCode !== 0) {
    return `docker build failed for ${IMAGE_NAME} (exit ${buildResult.exitCode}). Bundled Dockerfile: ${BUNDLED_DOCKERFILE_PATH}`;
  }
  console.log(`[wrapper] image ${IMAGE_NAME} rebuilt`);
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
    const installArgs = missingSkills.map((s) => `mattpocock/skills/${s}`).join(' ');
    console.error(
      `sandcastle-drain: missing required skills under .claude/skills/: ${missingSkills.join(', ')}. Install with:\n  npx skills@latest add ${installArgs}`,
    );
    process.exit(1);
  }

  // Image goes before auth: the OAuth bootstrap step (in probeAuth's error
  // message) shells out to `docker run … sandcastle:<dir> claude login`, so
  // the image must exist before a fresh user can complete that bootstrap.
  const imageError = await probeImage();
  if (imageError) {
    console.error(`sandcastle-drain: ${imageError}`);
    process.exit(1);
  }

  const authError = await probeAuth();
  if (authError) {
    console.error(`sandcastle-drain: ${authError}`);
    process.exit(1);
  }

  const ghAuth = await probeGhAuth();
  if (typeof ghAuth === 'string') {
    console.error(`sandcastle-drain: ${ghAuth}`);
    process.exit(1);
  }

  const labelsError = await probeLabels();
  if (labelsError) {
    console.error(`sandcastle-drain: ${labelsError}`);
    process.exit(1);
  }

  return { token: ghAuth.token };
}
