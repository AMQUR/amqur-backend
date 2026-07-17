import { Injectable } from '@nestjs/common';
import { ConversationInventoryState } from '../memory/conversation.store';

@Injectable()
export class FollowupEngine {
  // when to trigger a follow-up
  shouldFollowUp(state: ConversationInventoryState): boolean {
    // must have a vehicle selected
    if (!state.selectedVin) return false;

    // cold leads should not be pushed
    if (state.leadStage === 'cold') return false;

    // must have activity timestamp
    if (!state.lastActivityAt) return false;

    const idleMs = Date.now() - state.lastActivityAt;

    // 15 seconds idle inside chat
    return idleMs > 15_000;
  }

  // what message to show
  buildMessage(state: ConversationInventoryState): string {
    // hot leads = strong CTA
    if (state.leadStage === 'hot') {
      return 'Would you like me to schedule a test drive or place this vehicle on hold for you?';
    }

    // warm leads = soft assist
    return 'Would you like me to send you the details we discussed or show similar vehicles?';
  }
}
