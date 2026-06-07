import { describe, expect, it } from 'vitest';
import { computeVerdict, DEFAULT_VERDICT_POLICY } from './verdict.js';
import type { Finding } from './types.js';

function f(severity: Finding['severity'], signal = 'sig'): Finding {
  return {
    signal,
    severity,
    breakpoint: '375',
    route: '/',
    suggestedFix: 'fix it',
  };
}

describe('computeVerdict', () => {
  it('returns pass when there are no findings', () => {
    expect(computeVerdict([], DEFAULT_VERDICT_POLICY)).toBe('pass');
  });

  it('returns fail when any finding is high-severity', () => {
    expect(computeVerdict([f('high')], DEFAULT_VERDICT_POLICY)).toBe('fail');
  });

  it('returns fail when one high mixed with mediums', () => {
    const findings = [f('medium'), f('high'), f('low')];
    expect(computeVerdict(findings, DEFAULT_VERDICT_POLICY)).toBe('fail');
  });

  it('passes with mediums + lows when policy is permissive (default)', () => {
    const findings = [f('medium'), f('medium'), f('low'), f('low'), f('low')];
    expect(computeVerdict(findings, DEFAULT_VERDICT_POLICY)).toBe('pass');
  });

  it('fails when medium count exceeds mediumMax threshold', () => {
    const findings = [f('medium'), f('medium'), f('medium')];
    const policy = { mediumMax: 2, lowMax: Number.POSITIVE_INFINITY };
    expect(computeVerdict(findings, policy)).toBe('fail');
  });

  it('passes when medium count is exactly mediumMax (inclusive boundary)', () => {
    const findings = [f('medium'), f('medium')];
    const policy = { mediumMax: 2, lowMax: Number.POSITIVE_INFINITY };
    expect(computeVerdict(findings, policy)).toBe('pass');
  });

  it('fails when low count exceeds lowMax threshold', () => {
    const findings = [f('low'), f('low'), f('low'), f('low')];
    const policy = { mediumMax: Number.POSITIVE_INFINITY, lowMax: 3 };
    expect(computeVerdict(findings, policy)).toBe('fail');
  });

  it('treats mediumMax: 0 as "any medium fails"', () => {
    const policy = { mediumMax: 0, lowMax: Number.POSITIVE_INFINITY };
    expect(computeVerdict([f('medium')], policy)).toBe('fail');
    expect(computeVerdict([f('low')], policy)).toBe('pass');
  });

  it('high-severity overrides permissive thresholds', () => {
    const policy = {
      mediumMax: Number.POSITIVE_INFINITY,
      lowMax: Number.POSITIVE_INFINITY,
    };
    expect(computeVerdict([f('high')], policy)).toBe('fail');
  });

  it('is a pure function — same inputs return same output, no mutation', () => {
    const findings: readonly Finding[] = Object.freeze([f('medium'), f('low')]);
    const policy = Object.freeze({ mediumMax: 5, lowMax: 5 });
    const first = computeVerdict(findings, policy);
    const second = computeVerdict(findings, policy);
    expect(first).toBe(second);
  });
});
