import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatDto } from './dto/chat.dto';

@Controller('chat')
export class ChatController {
    constructor(private readonly chatService: ChatService) { }

    @Post()
    async chat(@Req() req: any, @Body() body: ChatDto) {
        const role = req.user?.role;

        /**
         * Conversation identity rules:
         *
         * - Widget users do NOT have a user account
         * - Their memory must be keyed by conversationId
         * - Staff users use JWT sub (userId)
         */
        const userId =
            role === 'widget'
                ? body.conversationId
                : req.user?.sub;

        if (!userId) {
            throw new UnauthorizedException(
                'Conversation identity missing. conversationId is required for widget traffic.',
            );
        }

        return this.chatService.chat({
            message: body.message,
            action: body.action,
            vin: body.vin,
            conversationId: body.conversationId,

            tenantId: req.user.tenantId,
            locationId: req.user.locationId,
            userId,
            role,
        });
    }
}
