/**
 * Parses the `## Blocked by` section of a GitHub issue body and returns the
 * referenced issue numbers. The wrapper uses this to skip dependents of an
 * issue that failed to land in the current drain run.
 *
 * Convention (from src/content/agent-docs/issue-tracker.md and existing issue bodies):
 *
 *   ## Blocked by
 *
 *   - #33 (short reference)
 *   - [#34](https://github.com/owner/repo/issues/34) (markdown link form)
 *
 * The section ends at the next markdown heading or EOF. References anywhere
 * else in the body are ignored.
 */

const HEADING_RE = /^##\s+blocked\s+by\b/i;
const ANY_HEADING_RE = /^#{1,6}\s/;
const REF_RE = /#(\d+)/g;

export function parseBlockedBy(body: string): number[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (ANY_HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end).join('\n');
  const numbers = new Set<number>();
  for (const m of section.matchAll(REF_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}
