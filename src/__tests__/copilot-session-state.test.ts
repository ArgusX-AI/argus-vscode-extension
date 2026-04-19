/**
 * Unit tests for the Copilot session-state title cache.
 *
 * Mirrors the contract verified by `codex-rollout.test.ts` for the rollout
 * pillar (lines 164–185): a session's title is derived from the first
 * prompt-bearing payload and stays pinned for every subsequent payload, even
 * when the later payload has no prompt content.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  getOrDeriveCopilotTitle,
  clearCopilotSessionTitles,
  _copilotTitleCacheSize,
} from '../copilot-session-state';

describe('copilot-session-state', () => {
  afterEach(() => {
    clearCopilotSessionTitles();
  });

  it('returns null when no prompt has ever arrived for the session', () => {
    expect(getOrDeriveCopilotTitle('copilot-2026-04-19', null)).toBeNull();
    expect(getOrDeriveCopilotTitle('copilot-2026-04-19', undefined)).toBeNull();
    expect(getOrDeriveCopilotTitle('copilot-2026-04-19', '')).toBeNull();
    expect(getOrDeriveCopilotTitle('copilot-2026-04-19', '   ')).toBeNull();
  });

  it('returns null when sessionId is missing', () => {
    expect(getOrDeriveCopilotTitle(null, 'fix the bug')).toBeNull();
    expect(getOrDeriveCopilotTitle(undefined, 'fix the bug')).toBeNull();
    expect(getOrDeriveCopilotTitle('', 'fix the bug')).toBeNull();
  });

  it('derives a title from the first prompt and pins it', () => {
    const sid = 'copilot-2026-04-19';
    expect(getOrDeriveCopilotTitle(sid, 'Fix the rate limiter to use sliding window'))
      .toBe('Fix the rate limiter to use sliding window');
    expect(getOrDeriveCopilotTitle(sid, 'now switch it to token bucket'))
      .toBe('Fix the rate limiter to use sliding window');
    expect(getOrDeriveCopilotTitle(sid, null))
      .toBe('Fix the rate limiter to use sliding window');
  });

  it('keeps separate titles per sessionId', () => {
    expect(getOrDeriveCopilotTitle('s1', 'first session prompt'))
      .toBe('first session prompt');
    expect(getOrDeriveCopilotTitle('s2', 'second session prompt'))
      .toBe('second session prompt');
    expect(getOrDeriveCopilotTitle('s1', null)).toBe('first session prompt');
    expect(getOrDeriveCopilotTitle('s2', null)).toBe('second session prompt');
  });

  it('returns the same pinned title even if a later prompt would derive differently', () => {
    const sid = 'copilot-2026-04-19';
    const longSecond = 'a'.repeat(200);
    expect(getOrDeriveCopilotTitle(sid, 'short first prompt'))
      .toBe('short first prompt');
    expect(getOrDeriveCopilotTitle(sid, longSecond)).toBe('short first prompt');
  });

  it('clearCopilotSessionTitles drops every pinned title', () => {
    getOrDeriveCopilotTitle('s1', 'one');
    getOrDeriveCopilotTitle('s2', 'two');
    expect(_copilotTitleCacheSize()).toBe(2);
    clearCopilotSessionTitles();
    expect(_copilotTitleCacheSize()).toBe(0);
    expect(getOrDeriveCopilotTitle('s1', null)).toBeNull();
  });

  it('LRU evicts the oldest pin when cache exceeds 500 entries', () => {
    for (let i = 0; i < 510; i++) {
      getOrDeriveCopilotTitle(`session-${i}`, `prompt ${i}`);
    }
    expect(_copilotTitleCacheSize()).toBeLessThanOrEqual(500);
    expect(getOrDeriveCopilotTitle('session-0', null)).toBeNull();
    expect(getOrDeriveCopilotTitle('session-509', null)).toBe('prompt 509');
  });
});
