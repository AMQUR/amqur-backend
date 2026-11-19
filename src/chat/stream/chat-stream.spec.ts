import {
  replyEvents,
  SSE_HEADERS,
  sseFrame,
  streamErrorEvent,
  SSE_HEARTBEAT_FRAME,
  STREAM_HEARTBEAT_DEFAULT_MS,
  streamHeartbeatMs,
} from './chat-stream';

describe('chat stream envelope', () => {
  it('frames one JSON object per event, newline-safe', () => {
    const frame = sseFrame({
      type: 'text.delta',
      index: 0,
      text: 'line one\nline two',
    });
    expect(frame).toBe(
      'event: text.delta\ndata: {"type":"text.delta","index":0,"text":"line one\\nline two"}\n\n',
    );
    expect(frame.split('\n\n')).toHaveLength(2);
    expect(JSON.parse(frame.split('\n')[1].slice(6))).toEqual({
      type: 'text.delta',
      index: 0,
      text: 'line one\nline two',
    });
  });

  it('declares an unbuffered, uncached event stream', () => {
    expect(SSE_HEADERS['Content-Type']).toContain('text/event-stream');
    expect(SSE_HEADERS['Cache-Control']).toBe('no-store');
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });

  it('emits each segment once (delta then done), then the full envelope', () => {
    const response = { reply: 'A. B.', segments: ['A.', 'B.'], cards: [] };
    expect(replyEvents(response)).toEqual([
      { type: 'text.delta', index: 0, text: 'A.' },
      { type: 'text.done', index: 0 },
      { type: 'text.delta', index: 1, text: 'B.' },
      { type: 'text.done', index: 1 },
      { type: 'turn.completed', response },
    ]);
  });

  it('falls back to the reply, and sends no text for a staff-handled turn', () => {
    expect(
      replyEvents({ reply: 'Hi', segments: [] }).map((e) => e.type),
    ).toEqual(['text.delta', 'text.done', 'turn.completed']);
    expect(replyEvents({ reply: '', segments: [] }).map((e) => e.type)).toEqual(
      ['turn.completed'],
    );
  });

  it('error event is short, localised and carries no internals', () => {
    for (const lang of ['en', 'es', undefined]) {
      const e = streamErrorEvent(lang);
      expect(e).toMatchObject({
        type: 'turn.error',
        code: 'turn_failed',
        retryable: true,
      });
      expect((e as { message: string }).message).not.toMatch(
        /Error|stack|prisma|\bat\s+\w+\s\(/i,
      );
    }
    expect((streamErrorEvent('es') as { message: string }).message).toMatch(
      /Inténtelo/,
    );
  });

  it('R15: the heartbeat is an SSE comment frame and its interval is bounded', () => {
    // A comment line (":" first) followed by a blank line — no event, no data.
    expect(SSE_HEARTBEAT_FRAME).toBe(': hb\n\n');
    expect(SSE_HEARTBEAT_FRAME).not.toMatch(/^(data|event|id|retry):/m);
    expect(streamHeartbeatMs({})).toBe(STREAM_HEARTBEAT_DEFAULT_MS);
    expect(STREAM_HEARTBEAT_DEFAULT_MS).toBe(15_000);
    expect(streamHeartbeatMs({ CHAT_STREAM_HEARTBEAT_MS: '50' })).toBe(50);
    for (const v of ['0', '-5', '1', '999999', 'abc', '10.5'])
      expect(streamHeartbeatMs({ CHAT_STREAM_HEARTBEAT_MS: v })).toBe(
        STREAM_HEARTBEAT_DEFAULT_MS,
      );
  });
});
