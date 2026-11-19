/**
 * Server-sent-event envelope for POST /chat/stream (AMQUR's own grammar; additive to
 * POST /chat). One JSON object per frame:
 *
 *   turn.started → [status]* → (text.delta → text.done)* → turn.completed
 *   …or, on failure after the stream has started:  turn.error  (then the stream ends)
 *
 * Text is emitted per reply segment when the engine has actually produced it — there is no
 * artificial token-by-token typing and no injected delay.
 */
export type ChatStreamStatusPhase = 'thinking' | 'checking' | 'composing';

export type ChatStreamEvent<R = unknown> =
  | {
      type: 'turn.started';
      turnId: string;
      conversationId?: string;
      conversationIdIssued?: boolean;
    }
  | { type: 'status'; phase: ChatStreamStatusPhase; label?: string }
  | { type: 'text.delta'; index: number; text: string }
  | { type: 'text.done'; index: number }
  | { type: 'turn.completed'; response: R }
  | { type: 'turn.error'; code: string; message: string; retryable: boolean };

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** One SSE frame. JSON.stringify never emits a raw newline, so a frame is always one event. */
/**
 * SSE comment frame sent periodically while a turn is running. A line starting with ":" is a
 * comment: every SSE parser ignores it (EventSource never surfaces it), but it keeps proxies,
 * load balancers and mobile networks from closing an idle connection during a slow turn, and
 * lets the client tell "still working" from "connection dead".
 */
export const SSE_HEARTBEAT_FRAME = ': hb\n\n';
export const STREAM_HEARTBEAT_DEFAULT_MS = 15_000;

/** Interval between heartbeats (CHAT_STREAM_HEARTBEAT_MS, 25–60000 ms; default 15 s). */
export function streamHeartbeatMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.CHAT_STREAM_HEARTBEAT_MS);
  return Number.isInteger(n) && n >= 25 && n <= 60_000
    ? n
    : STREAM_HEARTBEAT_DEFAULT_MS;
}

export function sseFrame(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The frames that carry a finished reply: each segment, then the full envelope. */
export function replyEvents<R extends { segments?: string[]; reply?: string }>(
  response: R,
): ChatStreamEvent<R>[] {
  const segments =
    Array.isArray(response.segments) && response.segments.length
      ? response.segments
      : response.reply
        ? [response.reply]
        : [];
  const out: ChatStreamEvent<R>[] = [];
  segments.forEach((text, index) => {
    if (!text) return;
    out.push({ type: 'text.delta', index, text });
    out.push({ type: 'text.done', index });
  });
  out.push({ type: 'turn.completed', response });
  return out;
}

/**
 * Customer-safe error for a turn that failed after the stream started. Never carries the
 * exception message, a stack trace, or any internal detail.
 */
export function streamErrorEvent(lang?: string): ChatStreamEvent {
  return {
    type: 'turn.error',
    code: 'turn_failed',
    message:
      lang === 'es'
        ? 'Algo falló de nuestro lado y no pude terminar esa respuesta. Inténtelo de nuevo en un momento.'
        : 'Something went wrong on our side and I couldn’t finish that reply. Please try again in a moment.',
    retryable: true,
  };
}
