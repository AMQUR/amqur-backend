import {
  replyEvents,
  SSE_HEADERS,
  sseFrame,
  streamErrorEvent,
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
});
