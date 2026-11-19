import {
  Body,
  Controller,
  HttpCode,
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
  sseFrame,
  streamErrorEvent,
} from './stream/chat-stream';

type ChatRequest = {
  user?: {
    role?: string;
    sub?: string;
    tenantId?: string;
    locationId?: string | null;
  };
};

const CHAT_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 10_000 : 40,
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
   * is still connected.
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

    try {
      const response = await turn.run((status) =>
        send({ type: 'status', ...status }),
      );
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
      if (!res.writableEnded) res.end();
    }
  }
}
