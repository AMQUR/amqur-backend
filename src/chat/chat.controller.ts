import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { ChatDto } from './dto/chat.dto';
import { ConversationIdService } from './conversation-id.service';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { MetricsService } from '../observability/metrics.service';
import { captureError } from '../observability/instrument';
import {
  ChatStreamEvent,
  replyEvents,
  SSE_HEADERS,
  SSE_HEARTBEAT_FRAME,
  sseFrame,
  streamErrorEvent,
  streamHeartbeatMs,
} from './stream/chat-stream';
import {
  chatStreamLimiter,
  STREAM_BUSY_RETRY_AFTER_SECONDS,
  streamCaps,
  tokenKey,
} from './stream/stream-concurrency';
import { rateLimit } from '../common/rate-limits';
import { clientIp } from '../common/guards/throttle-tracker';

type ChatRequest = {
  ip?: string;
  ips?: string[];
  headers?: { authorization?: string };
  user?: {
    role?: string;
    sub?: string;
    tenantId?: string;
    locationId?: string | null;
  };
};

const CHAT_THROTTLE = {
  default: {
    limit: rateLimit(40, 10_000),
    ttl: 60_000,
  },
};

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly conversationIds: ConversationIdService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Identity rules (shared by POST /chat and POST /chat/stream):
   * - widget traffic: server-issued, tenant-bound conversation id. Missing/forged ids get a
   *   NEW conversation (never someone else's). The id is returned for the widget to persist.
   * - staff traffic: keyed by staff user id.
   */
  private resolveTurn(req: ChatRequest, body: ChatDto) {
    const user = req.user;
    if (!user?.tenantId || !user.role) throw new UnauthorizedException();
    let conversationKey: string;
    let issued: string | undefined;
    if (user.role === 'widget') {
      if (this.conversationIds.verify(user.tenantId, body.conversationId)) {
        conversationKey = body.conversationId!;
      } else {
        issued = this.conversationIds.issue(user.tenantId);
        conversationKey = issued;
      }
    } else {
      if (!user.sub) throw new UnauthorizedException();
      conversationKey = `staff:${user.sub}`;
    }
    const isWidget = user.role === 'widget';
    const run = async (
      onStatus?: Parameters<ChatService['chat']>[0]['onStatus'],
    ) => {
      const res = await this.chatService.chat({
        message: body.message ?? '',
        action: body.action,
        vin: body.vin,
        language: body.language,
        pageContext: body.pageContext,
        lead: body.lead,
        appointment: body.appointment,
        rooftopRef: body.rooftopRef,
        onStatus,
        tenantId: user.tenantId!,
        locationId: user.locationId,
        userId: conversationKey,
        role: user.role!,
      });
      return {
        ...res,
        conversationId: isWidget ? conversationKey : undefined,
        conversationIdIssued: !!issued,
      };
    };
    return {
      run,
      conversationId: isWidget ? conversationKey : undefined,
      conversationIdIssued: !!issued,
    };
  }

  @Throttle(CHAT_THROTTLE)
  @Post()
  async chat(@Req() req: ChatRequest, @Body() body: ChatDto) {
    return this.resolveTurn(req, body).run();
  }

  /**
   * Same turn as POST /chat (same guards, throttle, validation and engine call), delivered as
   * server-sent events. Auth/validation failures happen before this handler and stay plain
   * HTTP JSON errors. Once the stream has started, a failure is reported as `turn.error`.
   * The turn always runs to completion and is persisted identically whether or not the client
   * is still connected. That is a deliberate choice: a turn may carry an already-accepted lead
   * or appointment submission, and aborting it on disconnect could lose it or leave it half
   * written. The cost of "open, then drop" is bounded instead: every stream counts against the
   * per-minute throttle, and it holds a concurrency slot (per IP and per bearer token) until the
   * TURN finishes, so dropping the socket frees nothing. Over the cap the caller gets a plain
   * JSON 429 with Retry-After before any stream starts.
   */
  @Throttle(CHAT_THROTTLE)
  @Post('stream')
  @HttpCode(200)
  @RawResponse()
  async stream(
    @Req() req: ChatRequest,
    @Body() body: ChatDto,
    @Res() res: Response,
  ): Promise<void> {
    const turn = this.resolveTurn(req, body);

    const caps = streamCaps();
    const token = tokenKey(req.headers?.authorization);
    const release = chatStreamLimiter.acquire([
      { key: `ip:${clientIp(req)}`, max: caps.perIp },
      ...(token ? [{ key: `tok:${token}`, max: caps.perToken }] : []),
    ]);
    if (!release) {
      this.metrics.increment('chat.stream.rejected_concurrency');
      res.setHeader('Retry-After', String(STREAM_BUSY_RETRY_AFTER_SECONDS));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Too many chat streams are open. Try again shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let open = true;
    res.on('close', () => {
      open = false;
    });
    // A dropped socket must never surface as an unhandled 'error' event.
    res.on('error', () => {
      open = false;
    });
    const send = (event: ChatStreamEvent) => {
      if (!open || res.writableEnded || res.destroyed) return;
      try {
        res.write(sseFrame(event));
      } catch {
        open = false;
      }
    };

    res.status(200);
    for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v);
    res.flushHeaders();
    this.metrics.increment('chat.stream.started');
    send({
      type: 'turn.started',
      turnId: randomUUID(),
      conversationId: turn.conversationId,
      conversationIdIssued: turn.conversationIdIssued,
    });

    // Comment-frame heartbeat for as long as the turn is running (ignored by SSE parsers).
    const heartbeat = setInterval(() => {
      if (!open || res.writableEnded || res.destroyed) return;
      try {
        res.write(SSE_HEARTBEAT_FRAME);
      } catch {
        open = false;
      }
    }, streamHeartbeatMs());
    heartbeat.unref?.();

    try {
      const response = await turn.run((status) =>
        send({ type: 'status', ...status }),
      );
      clearInterval(heartbeat);
      for (const event of replyEvents(response)) send(event);
      this.metrics.increment(
        open ? 'chat.stream.completed' : 'chat.stream.client_gone',
      );
    } catch (e: unknown) {
      // Internal detail goes to error monitoring (as for any unhandled 5xx); the log line
      // carries the error class only, never a message that could quote request data.
      captureError(e, { source: 'chat-stream' });
      this.logger.error(
        `chat stream turn failed: ${e instanceof Error ? e.name : 'error'}`,
      );
      this.metrics.increment('chat.stream.failed');
      send(streamErrorEvent(body.language));
    } finally {
      clearInterval(heartbeat);
      release();
      if (!res.writableEnded) res.end();
    }
  }
}
