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

  it('keeps the contents of {{#if FLAG}}…{{/if}} when flags[FLAG] is true', () => {
    expect(
      substitute('a{{#if SHOW}}b{{/if}}c', {}, { SHOW: true }),
    ).toBe('abc');
  });

  it('strips the contents of {{#if FLAG}}…{{/if}} when flags[FLAG] is false', () => {
    expect(
      substitute('a{{#if SHOW}}b{{/if}}c', {}, { SHOW: false }),
    ).toBe('ac');
  });

  it('handles multiple sibling conditional blocks independently', () => {
    const tpl = '[{{#if A}}A{{/if}}][{{#if B}}B{{/if}}]';
    expect(substitute(tpl, {}, { A: true, B: false })).toBe('[A][]');
    expect(substitute(tpl, {}, { A: false, B: true })).toBe('[][B]');
    expect(substitute(tpl, {}, { A: true, B: true })).toBe('[A][B]');
    expect(substitute(tpl, {}, { A: false, B: false })).toBe('[][]');
  });

  it('processes conditionals before placeholder substitution', () => {
    expect(
      substitute('{{#if SHOW}}name={{NAME}}{{/if}}', { NAME: 'world' }, { SHOW: true }),
    ).toBe('name=world');
  });

  it('drops placeholders inside a stripped conditional without requiring vars', () => {
    expect(
      substitute('{{#if SHOW}}{{MISSING}}{{/if}}stable', {}, { SHOW: false }),
    ).toBe('stable');
  });

  it('throws when a conditional names a flag not in the flags map', () => {
    expect(() => substitute('{{#if UNKNOWN}}x{{/if}}', {})).toThrow(/UNKNOWN/);
  });

  it('matches conditional blocks across newlines', () => {
    const tpl = 'before\n{{#if SHOW}}line one\nline two\n{{/if}}after';
    expect(substitute(tpl, {}, { SHOW: true })).toBe('before\nline one\nline two\nafter');
    expect(substitute(tpl, {}, { SHOW: false })).toBe('before\nafter');
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
    const out = await renderPrompt(
      'reviewer',
      {
        ISSUE_NUMBER: '11',
        BRANCH: 'agent/issue-11',
      },
      { HAS_CONTEXT_MD: true, HAS_ADRS: true, HAS_PROJECT_RULES: true },
    );
    expect(out).toContain('# Reviewer for issue #11');
    expect(out).toContain('`agent/issue-11`');
    expect(out).toContain('CONTEXT.md');
    expect(out).toContain('docs/adr');
    expect(out).toContain('Glossary & ADR alignment');
    expect(out).toContain('Project-specific aggregate rules');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(out).not.toMatch(/\{\{#if/);
    expect(out).not.toMatch(/\{\{\/if\}\}/);
  });

  it('strips CONTEXT.md and ADR rubric sections when both flags are false', async () => {
    const out = await renderPrompt(
      'reviewer',
      {
        ISSUE_NUMBER: '11',
        BRANCH: 'agent/issue-11',
      },
      { HAS_CONTEXT_MD: false, HAS_ADRS: false, HAS_PROJECT_RULES: false },
    );
    expect(out).not.toMatch(/CONTEXT\.md/);
    expect(out).not.toMatch(/docs\/adr/);
    expect(out).not.toMatch(/Glossary & ADR alignment/);
    expect(out).not.toMatch(/Project-specific aggregate rules/);
    expect(out).not.toMatch(/\{\{#if/);
    expect(out).not.toMatch(/\{\{\/if\}\}/);
  });

  it('keeps CONTEXT.md references but strips ADR references when only HAS_CONTEXT_MD is true', async () => {
    const out = await renderPrompt(
      'reviewer',
      {
        ISSUE_NUMBER: '11',
        BRANCH: 'agent/issue-11',
      },
      { HAS_CONTEXT_MD: true, HAS_ADRS: false, HAS_PROJECT_RULES: true },
    );
    expect(out).toContain('CONTEXT.md');
    expect(out).not.toMatch(/docs\/adr/);
    expect(out).toContain('Glossary & ADR alignment');
  });

  it('keeps ADR references but strips CONTEXT.md references when only HAS_ADRS is true', async () => {
    const out = await renderPrompt(
      'reviewer',
      {
        ISSUE_NUMBER: '11',
        BRANCH: 'agent/issue-11',
      },
      { HAS_CONTEXT_MD: false, HAS_ADRS: true, HAS_PROJECT_RULES: true },
    );
    expect(out).not.toMatch(/CONTEXT\.md/);
    expect(out).toContain('docs/adr');
    expect(out).toContain('Glossary & ADR alignment');
  });
});
