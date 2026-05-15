/**
 * Reviewer sub-agent invocation.
 *
 * After the implementer commits on `agent/issue-N`, the wrapper spawns a
 * separate Sandcastle run with the rendered reviewer prompt. The reviewer is
 * read-only against the worktree, eager-loads the project's principles, and
 * emits a single fenced JSON block as its final message. This module owns:
 *
 * - `runReviewer` — spawn the reviewer run, capture stdout + log
 * - `parseReviewerOutput` — extract the JSON verdict from stdout
 * - `formatReviewerComment` — render the verdict as a GitHub issue comment
 *
 * The reviewer is advisory: a `FAIL` verdict produces a comment for the human
 * to weigh; it does not gate the merge. See `src/prompts/reviewer.md.tpl`.
 */
import { run, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { detectRubricFlags, STAGED_SANDBOX_PATH } from '../stage.js';
import { REPO_ROOT } from './prereqs.js';
import { renderPrompt } from '../render-prompt.js';

export type ReviewerVerdict = 'PASS' | 'FAIL';
export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewerFinding {
  severity: FindingSeverity;
  principle: string;
  file: string;
  line: number;
  message: string;
  suggestedFix: string;
}

export interface ReviewerOutput {
  verdict: ReviewerVerdict;
  findings: readonly ReviewerFinding[];
  summary: string;
}

export type ReviewerParseResult =
  | { ok: true; value: ReviewerOutput }
  | { ok: false; reason: string };

const FENCED_JSON_REGEX = /```json\s*\n([\s\S]*?)\n```/g;

const VALID_VERDICTS = new Set<ReviewerVerdict>(['PASS', 'FAIL']);
const VALID_SEVERITIES = new Set<FindingSeverity>(['high', 'medium', 'low']);

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseFinding(raw: unknown): ReviewerFinding | string {
  if (raw === null || typeof raw !== 'object') return 'finding is not an object';
  const f = raw as Record<string, unknown>;
  if (!isString(f.severity) || !VALID_SEVERITIES.has(f.severity as FindingSeverity)) {
    return `severity must be one of ${[...VALID_SEVERITIES].join('|')}; got ${JSON.stringify(f.severity)}`;
  }
  if (!isString(f.principle)) return 'principle must be a string';
  if (!isString(f.file)) return 'file must be a string';
  if (!isNumber(f.line)) return 'line must be a number';
  if (!isString(f.message)) return 'message must be a string';
  if (!isString(f.suggestedFix)) return 'suggestedFix must be a string';
  return {
    severity: f.severity as FindingSeverity,
    principle: f.principle,
    file: f.file,
    line: f.line,
    message: f.message,
    suggestedFix: f.suggestedFix,
  };
}

/**
 * Extracts the last fenced ```json``` block from the reviewer's stdout and
 * validates it against the expected shape. We take the *last* block to be
 * resilient against the reviewer including an example JSON block earlier in
 * its thinking — the final answer is always the last one.
 */
export function parseReviewerOutput(stdout: string): ReviewerParseResult {
  const matches = [...stdout.matchAll(FENCED_JSON_REGEX)];
  if (matches.length === 0) {
    return { ok: false, reason: 'no fenced ```json``` block found in reviewer output' };
  }
  const lastMatch = matches[matches.length - 1];
  const rawJson = lastMatch[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false,
      reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'top-level JSON value is not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!isString(obj.verdict) || !VALID_VERDICTS.has(obj.verdict as ReviewerVerdict)) {
    return {
      ok: false,
      reason: `verdict must be "PASS" or "FAIL"; got ${JSON.stringify(obj.verdict)}`,
    };
  }
  if (!Array.isArray(obj.findings)) {
    return { ok: false, reason: 'findings must be an array' };
  }
  if (!isString(obj.summary)) {
    return { ok: false, reason: 'summary must be a string' };
  }
  const findings: ReviewerFinding[] = [];
  for (let i = 0; i < obj.findings.length; i++) {
    const result = parseFinding(obj.findings[i]);
    if (typeof result === 'string') {
      return { ok: false, reason: `findings[${i}]: ${result}` };
    }
    findings.push(result);
  }
  return {
    ok: true,
    value: {
      verdict: obj.verdict as ReviewerVerdict,
      findings,
      summary: obj.summary,
    },
  };
}

function severityBadge(s: FindingSeverity): string {
  if (s === 'high') return '🔴 high';
  if (s === 'medium') return '🟡 medium';
  return '🔵 low';
}

function formatFinding(f: ReviewerFinding): string {
  const location = f.line > 0 ? `${f.file}:${f.line}` : f.file;
  return [
    `**${severityBadge(f.severity)} — ${f.principle}**`,
    `\`${location}\``,
    '',
    f.message,
    '',
    `_Suggested fix:_ ${f.suggestedFix}`,
  ].join('\n');
}

/**
 * Renders the reviewer's verdict as a GitHub issue comment body. The summary
 * leads, then findings are listed by severity (high → medium → low) so the
 * human sees the load-bearing items first.
 */
export function formatReviewerComment(output: ReviewerOutput): string {
  const verdictEmoji = output.verdict === 'PASS' ? '✅' : '❌';
  const lines: string[] = [];
  lines.push(
    `**Reviewer verdict:** ${verdictEmoji} \`${output.verdict}\` _(advisory — not a merge gate)_`,
  );
  lines.push('');
  lines.push(output.summary);
  if (output.findings.length > 0) {
    const ordered = [...output.findings].sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    );
    lines.push('');
    lines.push(`### Findings (${output.findings.length})`);
    lines.push('');
    for (const f of ordered) {
      lines.push(formatFinding(f));
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

function severityRank(s: FindingSeverity): number {
  if (s === 'high') return 0;
  if (s === 'medium') return 1;
  return 2;
}

/**
 * Formats a fallback comment when the reviewer either didn't run, or ran but
 * didn't emit parseable JSON. We still want the human to know the reviewer
 * was invoked and that its output is in the log file.
 */
export function formatReviewerErrorComment(args: { reason: string; logFilePath?: string }): string {
  const lines: string[] = [];
  lines.push('**Reviewer verdict:** ⚠️ `error` _(advisory — not a merge gate)_');
  lines.push('');
  lines.push(`The reviewer sub-agent ran but produced no parseable verdict: ${args.reason}`);
  if (args.logFilePath) {
    lines.push('');
    lines.push(`See \`${args.logFilePath}\` for the full reviewer transcript.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunReviewerArgs {
  imageName: string;
  hostCredsPath: string;
  sandboxCredsPath: string;
  stagedHostPath: string;
  ghToken: string;
  issueNumber: number;
  branch: string;
  reviewerLogPath: string;
  idleTimeoutSeconds: number;
  wallClockTimeoutMs: number;
}

export interface ReviewerRunResult {
  output: ReviewerOutput | undefined;
  parseError: string | undefined;
  stdout: string;
  logFilePath: string | undefined;
}

/**
 * Spawns the reviewer Sandcastle run. The branch already exists with the
 * implementer's commits — the reviewer checks it out into a separate worktree,
 * reads the diff, and emits its verdict. We do not pass a `branchStrategy` that
 * would create a new branch; sandcastle reuses the existing one.
 *
 * On any failure (timeout, missing JSON, throw), we return a result with
 * `output: undefined` and a non-empty `parseError`. The wrapper posts an error
 * comment in that case rather than skipping the comment entirely — the absence
 * of a reviewer verdict on an issue would itself be confusing.
 */
export async function runReviewer(args: RunReviewerArgs): Promise<ReviewerRunResult> {
  let result: Awaited<ReturnType<typeof run>> | undefined;
  let runError: unknown;
  try {
    const flags = detectRubricFlags(REPO_ROOT);
    const prompt = await renderPrompt(
      'reviewer',
      {
        ISSUE_NUMBER: String(args.issueNumber),
        BRANCH: args.branch,
      },
      {
        HAS_CONTEXT_MD: flags.hasContextMd,
        HAS_ADRS: flags.hasAdrs,
        HAS_PROJECT_RULES: flags.hasContextMd || flags.hasAdrs,
      },
    );
    result = await run({
      agent: claudeCode('claude-opus-4-7'),
      sandbox: docker({
        imageName: args.imageName,
        mounts: [
          { hostPath: args.hostCredsPath, sandboxPath: args.sandboxCredsPath },
          { hostPath: args.stagedHostPath, sandboxPath: STAGED_SANDBOX_PATH, readonly: true },
        ],
        env: { GH_TOKEN: args.ghToken },
      }),
      prompt,
      branchStrategy: { type: 'branch', branch: args.branch },
      idleTimeoutSeconds: args.idleTimeoutSeconds,
      signal: AbortSignal.timeout(args.wallClockTimeoutMs),
    });
  } catch (err) {
    runError = err;
  }

  const stdout =
    result?.stdout ?? (runError instanceof Error ? runError.message : String(runError ?? ''));
  const sourceLogPath = result?.logFilePath;

  // Best-effort copy the sandcastle log to our well-known path. The branch's
  // implementer log lives alongside the reviewer log so post-mortem is easy.
  let copiedLogPath: string | undefined;
  if (sourceLogPath !== undefined) {
    try {
      await mkdir(dirname(args.reviewerLogPath), { recursive: true });
      await copyFile(sourceLogPath, args.reviewerLogPath);
      copiedLogPath = args.reviewerLogPath;
    } catch (err) {
      console.error(
        `[reviewer] failed to copy log ${sourceLogPath} → ${args.reviewerLogPath}:`,
        (err as Error).message,
      );
    }
  }

  if (runError !== undefined && result === undefined) {
    return {
      output: undefined,
      parseError: `reviewer run threw: ${runError instanceof Error ? runError.message : String(runError)}`,
      stdout,
      logFilePath: copiedLogPath,
    };
  }

  const parsed = parseReviewerOutput(stdout);
  if (!parsed.ok) {
    return {
      output: undefined,
      parseError: parsed.reason,
      stdout,
      logFilePath: copiedLogPath,
    };
  }

  return {
    output: parsed.value,
    parseError: undefined,
    stdout,
    logFilePath: copiedLogPath,
  };
}
