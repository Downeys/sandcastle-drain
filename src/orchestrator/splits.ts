/**
 * Split protocol — let an implementer hand the wrapper a list of new issues.
 *
 * When an implementer realises mid-run that the issue won't fit under the
 * 150k context ceiling, the right move is to commit what does fit, write the
 * remaining acceptance criteria as a list of follow-up issues into
 * `.sandcastle-drain/splits.json` in the worktree, then emit `<promise>COMPLETE</promise>`.
 *
 * The wrapper picks up the file after the run, files each entry as a new
 * `sandcastle` + `priority` issue (so it jumps the queue on the next refetch,
 * matching the rejection-loop precedent), comments on the original linking
 * the new issues, and applies the `oversized` label so the audit trail is
 * unambiguous.
 *
 * This module owns the pure pieces: locating + reading the splits file,
 * validating the shape, and rendering the comments. The actual `gh issue
 * create` and label/comment plumbing lives in `main.ts` next to the
 * analogous rejection-loop calls.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SPLITS_FILE_RELATIVE_PATH = '.sandcastle-drain/splits.json';
export const OVERSIZED_LABEL = 'oversized';
export const MAX_SPLITS = 10;
export const MAX_TITLE_LENGTH = 256;

export interface Split {
  title: string;
  body: string;
}

export interface CreatedSplit {
  number: number;
  url: string;
  title: string;
}

export type SplitsParseResult = { ok: true; value: Split[] } | { ok: false; reason: string };

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function parseSplit(raw: unknown, index: number): Split | string {
  if (raw === null || typeof raw !== 'object') return `splits[${index}] is not an object`;
  const s = raw as Record<string, unknown>;
  if (!isString(s.title)) return `splits[${index}].title must be a string`;
  if (s.title.length === 0) return `splits[${index}].title must not be empty`;
  if (s.title.length > MAX_TITLE_LENGTH) {
    return `splits[${index}].title must be <= ${MAX_TITLE_LENGTH} chars (got ${s.title.length})`;
  }
  if (!isString(s.body)) return `splits[${index}].body must be a string`;
  if (s.body.length === 0) return `splits[${index}].body must not be empty`;
  return { title: s.title, body: s.body };
}

/**
 * Validates the raw JSON read from `.sandcastle-drain/splits.json`. The shape is
 * intentionally tiny: an array of `{ title, body }`. Body is markdown the
 * implementer wrote — we never massage it on the way through.
 */
export function parseSplitsFile(rawJson: string): SplitsParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false,
      reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'splits file must contain a top-level JSON array' };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: 'splits array must contain at least one entry' };
  }
  if (parsed.length > MAX_SPLITS) {
    return {
      ok: false,
      reason: `splits array must contain at most ${MAX_SPLITS} entries (got ${parsed.length})`,
    };
  }
  const splits: Split[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const result = parseSplit(parsed[i], i);
    if (typeof result === 'string') return { ok: false, reason: result };
    splits.push(result);
  }
  return { ok: true, value: splits };
}

export function splitsFilePath(worktreePath: string): string {
  return join(worktreePath, SPLITS_FILE_RELATIVE_PATH);
}

/**
 * Reads + parses the splits file from a worktree. Returns `undefined` when
 * the file isn't present — the common case, since most implementers won't
 * split. File-read failures other than ENOENT surface as parse errors so the
 * wrapper can post the same error-comment path.
 */
export async function readSplitsFile(worktreePath: string): Promise<SplitsParseResult | undefined> {
  const path = splitsFilePath(worktreePath);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: `failed to read ${SPLITS_FILE_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseSplitsFile(raw);
}

/**
 * Renders the comment left on the parent issue when splits land successfully.
 * The reader gets a numbered checklist of the follow-ups so they can spot at a
 * glance how the work was decomposed, plus a note explaining the label.
 */
export function buildOriginalIssueSplitComment(args: {
  parentIssue: number;
  splits: readonly CreatedSplit[];
}): string {
  const lines: string[] = [];
  lines.push(
    `**sandcastle-drain implementer split this issue into ${args.splits.length} follow-up${args.splits.length === 1 ? '' : 's'}.**`,
  );
  lines.push('');
  lines.push(
    `The implementer wrote \`.sandcastle-drain/splits.json\` during the run, signalling that the remaining acceptance criteria could not fit under the 150k context ceiling. Each follow-up has been filed with the \`sandcastle\` + \`priority\` labels and will run on the next drain.`,
  );
  lines.push('');
  for (const split of args.splits) {
    lines.push(`- #${split.number} — ${split.title}`);
  }
  lines.push('');
  lines.push(
    `This issue has been labelled \`${OVERSIZED_LABEL}\`. The commits made during this run still flow through the normal review path — splitting does not throw away the work the implementer did finish.`,
  );
  return lines.join('\n');
}

/**
 * Renders the error comment when the splits file is malformed. We still want
 * the human to know the implementer tried to split — silent dropping would
 * make the next drain look like the implementer just bailed out.
 */
export function buildSplitErrorComment(args: { reason: string }): string {
  const lines: string[] = [];
  lines.push(`**sandcastle-drain implementer wrote \`.sandcastle-drain/splits.json\` but it was malformed.**`);
  lines.push('');
  lines.push(`Parse error: \`${args.reason}\``);
  lines.push('');
  lines.push(
    `No follow-up issues were filed. The implementer's commits (if any) still flow through the normal review path; re-file the splits by hand or apply \`retry\` after fixing the prompt.`,
  );
  return lines.join('\n');
}

/**
 * Renders the message the wrapper logs to its own stdout when the splits
 * flow fires. Not posted to GitHub — this is just for the drain operator.
 */
export function formatSplitsLogLine(args: {
  parentIssue: number;
  splits: readonly CreatedSplit[];
}): string {
  const numbers = args.splits.map((s) => `#${s.number}`).join(', ');
  return `[wrapper] split #${args.parentIssue} into ${args.splits.length} follow-up(s): ${numbers}`;
}
