/**
 * Licensed trade valuation contracts — no invented dollar amounts.
 */
export type TradeValuationBlockedReason = 'not_connected' | 'not_configured';

export type TradeValuationBlocked = {
  status: 'blocked';
  reason: TradeValuationBlockedReason;
  verified: false;
};

export function tradeValuationBlocked(
  reason: TradeValuationBlockedReason,
): TradeValuationBlocked {
  return { status: 'blocked', reason, verified: false };
}

export type GetValuationParams = {
  tenantId: string;
  locationId?: string | null;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  mileage?: number | null;
  zip?: string | null;
  condition?: string | null;
};

export type GetValuationResult =
  | TradeValuationBlocked
  | {
      status: 'ok';
      verified: true;
      providerRef: string;
      amount?: number;
      amountLow?: number;
      amountHigh?: number;
    };

export interface TradeValuationProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  getValuation(params: GetValuationParams): Promise<GetValuationResult>;
}

/** Stub until a licensed valuation vendor adapter is verified in staging. */
export class DisabledTradeValuationProvider implements TradeValuationProvider {
  readonly providerId = 'disabled';

  isLiveConfigured(): boolean {
    return false;
  }

  async getValuation(_params: GetValuationParams): Promise<GetValuationResult> {
    return tradeValuationBlocked('not_configured');
  }
}
