import { describe, expect, it } from 'vitest';
import { renderPrompt, substitute } from './render-prompt.js';

describe('substitute()', () => {
  it('replaces a single placeholder', () => {
    expect(substitute('hello {{NAME}}', { NAME: 'world' })).toBe('hello world');
  });

  it('replaces multiple distinct placeholders', () => {
    expect(
      substitute('issue #{{NUM}} — {{TITLE}}', { NUM: '42', TITLE: 'do the thing' }),
    ).toBe('issue #42 — do the thing');
  });

  it('replaces every occurrence of a repeated placeholder', () => {
    expect(substitute('{{N}} + {{N}} = ?', { N: '2' })).toBe('2 + 2 = ?');
  });

  it('leaves text without placeholders unchanged', () => {
    expect(substitute('no placeholders here', { UNUSED: 'x' })).toBe('no placeholders here');
  });

  it('throws when a placeholder has no matching key in vars', () => {
    expect(() => substitute('hello {{MISSING}}', { OTHER: 'x' })).toThrow(/MISSING/);
  });
});

describe('renderPrompt()', () => {
  it('renders the implementer template with all required vars substituted', async () => {
    const out = await renderPrompt('implementer', {
      ISSUE_NUMBER: '7',
      ISSUE_TITLE: 'Demonstrate rendering',
      SIBLING_CONTEXT: '<no siblings yet>',
    });
    expect(out).toContain('# Working on issue #7');
    expect(out).toContain('**#7 — Demonstrate rendering**');
    expect(out).toContain('<no siblings yet>');
    expect(out).toContain('Closes #7');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('renders the reviewer template with all required vars substituted', async () => {
    const out = await renderPrompt('reviewer', {
      ISSUE_NUMBER: '11',
      BRANCH: 'agent/issue-11',
    });
    expect(out).toContain('# Reviewer for issue #11');
    expect(out).toContain('`agent/issue-11`');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
