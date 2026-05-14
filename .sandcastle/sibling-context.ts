import { execa } from 'execa';

export interface SiblingSummary {
  issue: number;
  branch: string;
  changedFiles: string[];
  newExports: string[];
}

// Match `+export ...` lines added in a unified diff. Intentionally narrow:
// missing matches just don't appear in the prompt — the goal is informational
// hints, not a complete export index.
const EXPORT_REGEX = /^\+export (?:async )?(?:function|const|class|type|interface|enum) (\w+)/gm;

export function extractNewExports(diff: string): string[] {
  const found = new Set<string>();
  for (const match of diff.matchAll(EXPORT_REGEX)) {
    found.add(match[1]);
  }
  return [...found];
}

export async function summarizeBranch(args: {
  issue: number;
  branch: string;
  baseBranch: string;
  cwd: string;
}): Promise<SiblingSummary> {
  const { issue, branch, baseBranch, cwd } = args;
  const range = `${baseBranch}..${branch}`;

  const namesResult = await execa('git', ['diff', '--name-only', range], {
    cwd,
    reject: false,
  });
  const changedFiles =
    namesResult.exitCode === 0
      ? namesResult.stdout.split(/\r?\n/).filter((line: string) => line.length > 0)
      : [];

  const diffResult = await execa('git', ['diff', range], { cwd, reject: false });
  const newExports = diffResult.exitCode === 0 ? extractNewExports(diffResult.stdout) : [];

  return { issue, branch, changedFiles, newExports };
}

// Rough token estimate: Anthropic tokenizers average ~3.5–4 chars/token for
// English prose. We use 4 because it's the standard heuristic and we only need
// an order-of-magnitude signal to monitor for context bloat. Empty string → 0.
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function buildSiblingContextBlock(siblings: readonly SiblingSummary[]): string {
  if (siblings.length === 0) return '';

  const header = [
    '## Sibling work in this drain session',
    '',
    'The following branches were just created by this same drain run and are awaiting review. They are NOT yet on `main`. If your work overlaps with any of them:',
    '',
    '- Prefer importing their exported symbols over re-implementing.',
    '- If you import, your PR will be reviewed as a stack with the sibling.',
    '- If you have a strong reason to differ, do so and explain in the commit.',
    '',
    'Siblings:',
    '',
  ].join('\n');

  const siblingLines = siblings
    .map((s) =>
      [
        `- \`${s.branch}\` (issue #${s.issue}):`,
        s.changedFiles.length > 0 ? `  - Changed: ${s.changedFiles.join(', ')}` : null,
        s.newExports.length > 0 ? `  - New exports: ${s.newExports.join(', ')}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )
    .join('\n');

  return `${header}\n${siblingLines}`;
}
