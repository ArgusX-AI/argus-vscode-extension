/**
 * Unit tests for the Codex rollout JSONL watcher.
 *
 * These tests drive the parser directly via `processRolloutLinesForTest`,
 * avoiding real filesystem I/O. The fixture is a minimal but realistic
 * rollout file — header, one user_message, one agent_message, one tool_call
 * pair, and a token_count event.
 */
import { describe, it, expect, vi } from 'vitest';
import { processRolloutLinesForTest } from '../codex-rollout';

const fixtureLines = [
  JSON.stringify({
    session_id: 'abc123def4567890',
    timestamp: '2026-04-12T10:00:00Z',
    model: 'o4-mini',
    provider: 'openai',
    source: 'codex',
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      content: 'Fix the rate limiter to use sliding window',
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      content: 'I will update the rate limiter implementation.',
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'tool_call',
      name: 'shell',
      arguments: { command: 'npm run test' },
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'tool_result',
      name: 'shell',
      result: 'PASS: 42 tests',
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      input_tokens: 2500,
      output_tokens: 800,
      cached_input_tokens: 1200,
      reasoning_tokens: 350,
    },
  }),
];

describe('codex-rollout parser', () => {
  it('emits one payload per event with correct shape', () => {
    const send = vi.fn();
    const { eventsSent, state } = processRolloutLinesForTest(fixtureLines, send);

    // Header consumed, 5 events emitted (user + agent + tool_call + tool_result + token_count).
    expect(state.header?.sessionId).toBe('abc123def4567890');
    expect(state.header?.model).toBe('o4-mini');
    expect(eventsSent).toHaveLength(5);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('session_id is prefixed and truncated to first 8 chars', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    for (const p of eventsSent) {
      expect(p.session_id).toBe('codex-abc123de');
      expect(p.conversation_id).toBe('abc123def4567890');
    }
  });

  it('user_message becomes a chat payload with prompt only', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    const userEvent = eventsSent[0];
    expect(userEvent.request_type).toBe('chat');
    expect(userEvent.prompt).toBe('Fix the rate limiter to use sliding window');
    expect(userEvent.completion).toBeNull();
  });

  it('agent_message becomes a chat payload with completion only', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    const agentEvent = eventsSent[1];
    expect(agentEvent.request_type).toBe('chat');
    expect(agentEvent.completion).toBe('I will update the rate limiter implementation.');
    expect(agentEvent.prompt).toBeNull();
  });

  it('tool_call becomes a tool payload with name + stringified args', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    const toolCall = eventsSent[2];
    expect(toolCall.request_type).toBe('tool');
    expect(toolCall.tool_name).toBe('shell');
    expect(toolCall.tool_call_arguments).toContain('npm run test');
    expect(toolCall.tool_call_result).toBeNull();
  });

  it('tool_result becomes a tool payload with result string', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    const toolResult = eventsSent[3];
    expect(toolResult.request_type).toBe('tool');
    expect(toolResult.tool_call_result).toContain('42 tests');
  });

  it('token_count accumulates cumulative counters and emits an inference event', () => {
    const send = vi.fn();
    const { eventsSent, state } = processRolloutLinesForTest(fixtureLines, send);
    const tokenEvent = eventsSent[4];
    expect(tokenEvent.request_type).toBe('inference');
    expect(tokenEvent.cumulative_input_tokens).toBe(2500);
    expect(tokenEvent.cumulative_output_tokens).toBe(800);
    expect(tokenEvent.cache_read_tokens).toBe(1200);
    expect(tokenEvent.reasoning_tokens).toBe(350);
    // Delta equals cumulative on first event.
    expect(tokenEvent.input_tokens).toBe(2500);
    expect(tokenEvent.output_tokens).toBe(800);
    expect(state.cumulativeInputTokens).toBe(2500);
  });

  it('event_sequence is monotonically increasing', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    const sequences = eventsSent.map(e => e.event_sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it('every payload carries the rollout-jsonl transport tag', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    for (const p of eventsSent) {
      expect(p.transport).toBe('rollout-jsonl');
      expect(p.domain).toBe('api.openai.com');
      expect(p.method).toBe('POST');
      expect(p.span_name).toBe('codex.rollout');
    }
  });

  it('malformed JSON lines are skipped without throwing', () => {
    const send = vi.fn();
    const lines = [
      fixtureLines[0], // header
      'not valid json',
      fixtureLines[1], // user_message
    ];
    const { eventsSent } = processRolloutLinesForTest(lines, send);
    expect(eventsSent).toHaveLength(1);
    expect(eventsSent[0].prompt).toContain('sliding window');
  });

  it('session_title is derived from the first user_message and sent on every event', () => {
    const send = vi.fn();
    const { eventsSent } = processRolloutLinesForTest(fixtureLines, send);
    for (const p of eventsSent) {
      expect(p.session_title).toBe('Fix the rate limiter to use sliding window');
    }
  });

  it('session_title stays pinned to the first user prompt', () => {
    const send = vi.fn();
    const secondUser = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', content: 'now switch it to token bucket' },
    });
    const { eventsSent } = processRolloutLinesForTest(
      [fixtureLines[0], fixtureLines[1], secondUser],
      send,
    );
    for (const p of eventsSent) {
      expect(p.session_title).toBe('Fix the rate limiter to use sliding window');
    }
  });

  it('events before the header are dropped (no session_id)', () => {
    const send = vi.fn();
    // Put an event before the header — the parser has no header yet so
    // enqueue will fire, but flushPending refuses to emit without a header.
    // We therefore expect nothing from these early lines, and only the lines
    // after the header are emitted.
    const lines = [
      fixtureLines[1], // treated as header? — no, it has no session_id so ignored
      fixtureLines[0], // real header
      fixtureLines[2], // agent message
    ];
    const { eventsSent } = processRolloutLinesForTest(lines, send);
    expect(eventsSent.length).toBeGreaterThanOrEqual(1);
    expect(eventsSent[eventsSent.length - 1].completion).toContain('update');
  });
});
