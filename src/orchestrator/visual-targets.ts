/**
 * Parses the `## Visual targets` section of a GitHub issue body and returns the
 * route paths the Visual-Iteration Engine should capture for that issue.
 *
 * Convention (mirrors parseBlockedBy in shape — see blocked-by.ts):
 *
 *   ## Visual targets
 *
 *   - /dashboard                                       (short form)
 *   - [Settings page](/settings)                       (markdown-link form, path in target)
 *   - [/admin](https://staging.example.com/admin)      (markdown-link form, path in label)
 *
 * The section ends at the next markdown heading or EOF. Routes outside the
 * section are ignored. Order is preserved; duplicates are de-duplicated.
 *
 * A missing section returns `[]`; the engine gate degrades a `ui`-labeled
 * issue to capturing `/` and flags that in the report (per ADR 0004). That
 * degradation lives at the caller, not here — the parser stays pure.
 */

const HEADING_RE = /^##\s+visual\s+targets\b/i;
const ANY_HEADING_RE = /^#{1,6}\s/;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/;
const BARE_PATH_RE = /(?:^|[\s>(])(\/[^\s)\]]*)/;

export function parseVisualTargets(body: string): readonly string[] {
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

  const routes: string[] = [];
  const seen = new Set<string>();
  for (let i = start; i < end; i++) {
    const route = extractRouteFromLine(lines[i]);
    if (route && !seen.has(route)) {
      seen.add(route);
      routes.push(route);
    }
  }
  return routes;
}

function extractRouteFromLine(line: string): string | null {
  // Markdown link form: [label](target). Prefer the target if it's a relative
  // path (the common case); fall back to the label if it's a path (the
  // [/admin](https://staging.example.com/admin) form, where the visible label
  // is the in-app route and the target is an external preview URL).
  const md = MD_LINK_RE.exec(line);
  if (md) {
    const [, label, target] = md;
    if (target.startsWith('/')) return target;
    if (label.startsWith('/')) return label;
  }
  const bare = BARE_PATH_RE.exec(line);
  return bare ? bare[1] : null;
}
