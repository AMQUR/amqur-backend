import { Injectable } from '@nestjs/common';
import { ChatOrchestrator } from './chat.orchestrator';
import type { PageContextDto } from './dto/chat.dto';

@Injectable()
export class ChatService {
  constructor(private readonly orchestrator: ChatOrchestrator) {}

  chat(input: {
    message: string;
    action?: string;
    vin?: string;
    language?: string;
    pageContext?: PageContextDto;
    tenantId: string;
    locationId?: string | null;
    userId: string;
    role: string;
  }) {
    return this.orchestrator.handleMessage({
      message: input.message,
      action: input.action,
      vin: input.vin,
      language: input.language,
      pageContext: input.pageContext,
      tenantId: input.tenantId,
      locationId: input.locationId ?? null,
      userId: input.userId,
      role: input.role,
    });
  }
}
