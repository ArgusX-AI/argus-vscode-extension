import { describe, it, expect } from 'vitest';
import { makeSessionTitle } from '../session-title';

describe('makeSessionTitle', () => {
  it('returns null for non-string input', () => {
    expect(makeSessionTitle(null)).toBeNull();
    expect(makeSessionTitle(undefined)).toBeNull();
    expect(makeSessionTitle(42)).toBeNull();
    expect(makeSessionTitle({})).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(makeSessionTitle('')).toBeNull();
    expect(makeSessionTitle('   ')).toBeNull();
    expect(makeSessionTitle('\n\t  \r\n')).toBeNull();
  });

  it('returns short prompts unchanged', () => {
    expect(makeSessionTitle('waht is xss')).toBe('waht is xss');
    expect(makeSessionTitle('fix bug')).toBe('fix bug');
  });

  it('collapses whitespace and trims', () => {
    expect(makeSessionTitle('  fix   the   rate\tlimiter  ')).toBe(
      'fix the rate limiter',
    );
    expect(makeSessionTitle('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('strips zero-width and control characters', () => {
    expect(makeSessionTitle('hello\u200Bworld')).toBe('hello world');
    expect(makeSessionTitle('a\x00b\x07c')).toBe('a b c');
  });

  it('cuts long text at a word boundary and appends ellipsis', () => {
    const long =
      'Please refactor the authentication middleware to support JWT and sessions at the same time';
    const out = makeSessionTitle(long, 60)!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('  ');
    expect(long.startsWith(out.slice(0, -1).trim())).toBe(true);
  });

  it('respects a custom maxLen', () => {
    const out = makeSessionTitle('one two three four five six seven', 15)!;
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to a hard cut when the first word is longer than maxLen', () => {
    const out = makeSessionTitle('supercalifragilisticexpialidocious', 20)!;
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns null when maxLen is unreasonably small', () => {
    expect(makeSessionTitle('hello', 1)).toBeNull();
  });
});
