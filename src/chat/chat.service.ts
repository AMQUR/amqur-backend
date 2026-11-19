import { Injectable } from '@nestjs/common';
import { ChatOrchestrator } from './chat.orchestrator';
import type { ChatStatusEvent } from './chat.orchestrator';
import type {
  AppointmentSelectionDto,
  LeadSubmissionDto,
  PageContextDto,
} from './dto/chat.dto';

@Injectable()
export class ChatService {
  constructor(private readonly orchestrator: ChatOrchestrator) {}

  chat(input: {
    message: string;
    action?: string;
    vin?: string;
    language?: string;
    pageContext?: PageContextDto;
    lead?: LeadSubmissionDto;
    appointment?: AppointmentSelectionDto;
    /** Real engine progress, surfaced by the streaming endpoint only. */
    onStatus?: (e: ChatStatusEvent) => void;
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
      lead: input.lead,
      appointment: input.appointment,
      onStatus: input.onStatus,
      tenantId: input.tenantId,
      locationId: input.locationId ?? null,
      userId: input.userId,
      role: input.role,
    });
  }
}
