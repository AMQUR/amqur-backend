import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChatService } from './chat.service';
import { ChatDto } from './dto/chat.dto';
import { ConversationIdService } from './conversation-id.service';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly conversationIds: ConversationIdService,
  ) {}

  @Throttle({
    default: {
      limit: process.env.NODE_ENV === 'test' ? 10_000 : 40,
      ttl: 60_000,
    },
  })
  @Post()
  async chat(
    @Req()
    req: {
      user?: {
        role?: string;
        sub?: string;
        tenantId?: string;
        locationId?: string | null;
      };
    },
    @Body() body: ChatDto,
  ) {
    const user = req.user;
    if (!user?.tenantId || !user.role) throw new UnauthorizedException();
    /**
     * Identity rules:
     * - widget traffic: server-issued, tenant-bound conversation id. Missing/forged ids get a
     *   NEW conversation (never someone else's). The id is returned for the widget to persist.
     * - staff traffic: keyed by staff user id.
     */
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
    const res = await this.chatService.chat({
      message: body.message ?? '',
      action: body.action,
      vin: body.vin,
      language: body.language,
      pageContext: body.pageContext,
      tenantId: user.tenantId,
      locationId: user.locationId,
      userId: conversationKey,
      role: user.role,
    });
    return {
      ...res,
      conversationId: user.role === 'widget' ? conversationKey : undefined,
      conversationIdIssued: !!issued,
    };
  }
}
