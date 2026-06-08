import { describe, expect, it } from 'vitest';
import { parseVisualTargets } from './visual-targets.js';

describe('parseVisualTargets', () => {
  it('returns [] when the body is empty', () => {
    expect(parseVisualTargets('')).toEqual([]);
  });

  it('returns [] when the section is absent', () => {
    const body = '## What to build\n\nAdd a new dashboard widget.';
    expect(parseVisualTargets(body)).toEqual([]);
  });

  it('parses short-form route bullets', () => {
    const body = `
## Visual targets

- /
- /dashboard
- /settings/profile
`;
    expect(parseVisualTargets(body)).toEqual(['/', '/dashboard', '/settings/profile']);
  });

  it('parses markdown-link bullets where the link target is the route', () => {
    const body = `
## Visual targets

- [Home](/)
- [Dashboard](/dashboard)
`;
    expect(parseVisualTargets(body)).toEqual(['/', '/dashboard']);
  });

  it('parses markdown-link bullets where the link label is the route (target is an external preview URL)', () => {
    const body = `
## Visual targets

- [/admin](https://staging.example.com/admin)
- [/admin/users](https://staging.example.com/admin/users)
`;
    expect(parseVisualTargets(body)).toEqual(['/admin', '/admin/users']);
  });

  it('preserves order and de-duplicates repeats', () => {
    const body = `
## Visual targets

- /dashboard
- /settings
- /dashboard
`;
    expect(parseVisualTargets(body)).toEqual(['/dashboard', '/settings']);
  });

  it('stops at the next heading', () => {
    const body = `
## Visual targets

- /dashboard

## Acceptance criteria

- /this-should-not-be-captured
`;
    expect(parseVisualTargets(body)).toEqual(['/dashboard']);
  });

  it('stops at headings of any level', () => {
    const body = `
## Visual targets

- /a

### Subsection

- /b
`;
    expect(parseVisualTargets(body)).toEqual(['/a']);
  });

  it('ignores routes that appear outside the section', () => {
    const body = `
We want to capture /dashboard and /settings.

## Visual targets

- /admin
`;
    expect(parseVisualTargets(body)).toEqual(['/admin']);
  });

  it('matches the heading case-insensitively', () => {
    const body = `
## VISUAL TARGETS

- /dashboard
`;
    expect(parseVisualTargets(body)).toEqual(['/dashboard']);
  });

  it('tolerates CRLF line endings (GitHub issue bodies often have them)', () => {
    const body = '## Visual targets\r\n\r\n- /dashboard\r\n- /settings\r\n';
    expect(parseVisualTargets(body)).toEqual(['/dashboard', '/settings']);
  });

  it('skips lines that contain no path', () => {
    const body = `
## Visual targets

- /dashboard
- (no route on this line)
- /settings
`;
    expect(parseVisualTargets(body)).toEqual(['/dashboard', '/settings']);
  });
});
