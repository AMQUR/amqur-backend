import { Injectable } from '@nestjs/common';
import { ChatOrchestrator } from './chat.orchestrator';
import { GroupRoutingService } from '../group-routing/group-routing.service';
import { TurnLockService } from './turn-lock.service';
import type { ChatStatusEvent } from './chat.orchestrator';
import type {
  AppointmentSelectionDto,
  LeadSubmissionDto,
  PageContextDto,
} from './dto/chat.dto';

@Injectable()
export class ChatService {
  constructor(
    private readonly orchestrator: ChatOrchestrator,
    private readonly groupRouting: GroupRoutingService,
    private readonly turnLock: TurnLockService,
  ) {}

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
    /** Opaque rooftop reference echoed by a group-site widget; ignored everywhere else. */
    rooftopRef?: string;
    tenantId: string;
    locationId?: string | null;
    userId: string;
    role: string;
  }) {
    // One turn at a time per conversation (see TurnLockService). Group-site rooftop routing
    // runs inside the lock: a pass-through for every tenant that is not a designated, enabled
    // group site (docs/CHAT_STREAM_CONTRACT.md §6).
    return this.turnLock.run(`${input.tenantId}:${input.userId}`, () =>
      this.groupRouting.handle(
        { ...input, locationId: input.locationId ?? null },
        (turn) =>
          this.orchestrator.handleMessage({
            message: turn.message,
            action: turn.action,
            vin: turn.vin,
            language: turn.language,
            pageContext: turn.pageContext as PageContextDto | undefined,
            lead: turn.lead as LeadSubmissionDto | undefined,
            appointment: turn.appointment as
              | AppointmentSelectionDto
              | undefined,
            onStatus: turn.onStatus as
              | ((e: ChatStatusEvent) => void)
              | undefined,
            tenantId: turn.tenantId,
            locationId: turn.locationId ?? null,
            userId: turn.userId,
            role: turn.role,
            pinnedVin: turn.pinnedVin,
            resumeSearch: turn.resumeSearch,
          }),
      ),
    );
  }
}
