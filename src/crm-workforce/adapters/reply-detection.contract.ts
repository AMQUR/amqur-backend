import {
  readInboundSignals,
  escalationFor,
  type InboundSignal,
} from '../policy/inbound-signals';

/**
 * Contract for detecting customer replies that arrive in the CRM (SMS, email, chat) after the
 * workforce last read a lead, so that automation reacts instead of talking over the customer.
 *
 * Today there is no authorized read of Tekion conversations, so production uses
 * `UnavailableReplySource` (BLOCKED). In Assist mode the employee records the customer's reply
 * by hand ("The customer replied"), which runs the same `planReply` rules below. A future APC
 * webhook or poll plugs in here.
 *
 * Rules (part of the contract):
 *  1. A reply is identified by the source's own message id; the same reply seen twice (webhook
 *     plus poll, retries) is handled once.
 *  2. The cursor only moves forward, and only after the page is handled; a crash re-reads.
 *  3. Any customer reply makes unsent outbound for that lead stale: drafts and queued messages
 *     are cancelled, never sent after the customer has spoken.
 *  4. An opt-out reply suppresses the channel and stops all outreach. A reply that needs a
 *     person opens an escalation. Otherwise the lead becomes P0 (customer waiting).
 *  5. Reply text is untrusted input and is sealed on arrival like any other message.
 */
export type ReplyChannel = 'SMS' | 'EMAIL' | 'CHAT';

export type InboundReply = {
  /** The source's own id of this message. */
  sourceMessageId: string;
  crmLeadRef: string;
  channel: ReplyChannel;
  occurredAt: string;
  body: string;
};

export type ReplyPage =
  | { status: 'OK'; replies: InboundReply[]; nextCursor: string | null }
  | {
      status: 'BLOCKED' | 'THROTTLED' | 'AUTH_REQUIRED';
      replies: [];
      nextCursor: null;
      reason: string;
    };

export interface ReplySource {
  readonly key: string;
  poll(
    scope: { tenantId: string; locationId: string },
    cursor: string | null,
  ): Promise<ReplyPage>;
}

export class UnavailableReplySource implements ReplySource {
  readonly key = 'none';
  poll(): Promise<ReplyPage> {
    return Promise.resolve({
      status: 'BLOCKED',
      replies: [],
      nextCursor: null,
      reason: 'no_authorized_conversation_read',
    });
  }
}

export type LeadReplyState = {
  /** Source message ids already handled for this lead. */
  seenMessageIds: ReadonlySet<string>;
  /** Unsent outbound actions (draft, pending approval, approved, queued) for this lead. */
  openOutboundActionIds: string[];
  agentPaused: boolean;
};

export type ReplyPlan =
  | { kind: 'duplicate' }
  | {
      kind: 'opt_out' | 'escalate' | 'customer_waiting';
      cancelActionIds: string[];
      signals: InboundSignal[];
      suppressChannel?: ReplyChannel;
      escalation?: {
        reason: InboundSignal;
        urgency: 'NORMAL' | 'HIGH' | 'CRITICAL';
      };
      priority: number | null;
      /** True when a person already owns the conversation: record it, do not queue the agent. */
      humanOwned: boolean;
    };

const OPT_OUT: InboundSignal[] = [
  'STOP',
  'UNSUBSCRIBE',
  'WRONG_NUMBER',
  'DO_NOT_CONTACT',
];

/** Rules 1, 3 and 4 for one reply. Pure: the caller applies the plan in one transaction. */
export function planReply(r: InboundReply, s: LeadReplyState): ReplyPlan {
  if (s.seenMessageIds.has(r.sourceMessageId)) return { kind: 'duplicate' };
  const signals = readInboundSignals(r.body);
  const cancelActionIds = [...s.openOutboundActionIds];
  if (signals.some((x) => OPT_OUT.includes(x)))
    return {
      kind: 'opt_out',
      cancelActionIds,
      signals,
      suppressChannel: r.channel,
      priority: null,
      humanOwned: s.agentPaused,
    };
  const esc = escalationFor(signals);
  if (esc)
    return {
      kind: 'escalate',
      cancelActionIds,
      signals,
      escalation: esc,
      priority: null,
      humanOwned: s.agentPaused,
    };
  return {
    kind: 'customer_waiting',
    cancelActionIds,
    signals,
    priority: s.agentPaused ? null : 0,
    humanOwned: s.agentPaused,
  };
}

/**
 * Rule 1 and 2 for a page: order by time, drop ids seen earlier in the page, and return the
 * cursor to store only after every reply in the page has been handled.
 */
export function orderPage(page: ReplyPage): {
  replies: InboundReply[];
  commitCursor: string | null;
} {
  if (page.status !== 'OK') return { replies: [], commitCursor: null };
  const seen = new Set<string>();
  const replies = [...page.replies]
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        a.sourceMessageId.localeCompare(b.sourceMessageId),
    )
    .filter(
      (r) => !seen.has(r.sourceMessageId) && !!seen.add(r.sourceMessageId),
    );
  return { replies, commitCursor: page.nextCursor };
}
