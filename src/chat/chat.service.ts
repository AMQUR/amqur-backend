import { Injectable } from '@nestjs/common';
import { ChatOrchestrator } from './chat.orchestrator';

@Injectable()
export class ChatService {
  constructor(private readonly orchestrator: ChatOrchestrator) {}

  async chat(input: {
    message: string;
    action?: string;
    vin?: string;
    conversationId?: string;

    tenantId: string;
    locationId?: string | null;
    userId: string;
    role: string;
  }) {
    return this.orchestrator.handleMessage({
      message: input.message,
      action: input.action,
      vin: input.vin,
      conversationId: input.conversationId,

      tenantId: input.tenantId,
      locationId: input.locationId ?? undefined,
      userId: input.userId,
      role: input.role,
    });
  }
}
