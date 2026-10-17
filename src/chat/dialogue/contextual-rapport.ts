/**
 * Controlled optional rapport (weather / daypart / sports).
 *
 * Rules (fail-closed):
 * - Never invent weather, scores, or local events.
 * - Never inject rapport onto inventory/price/appointment task turns.
 * - At most one opener early in a conversation; tenant kill switch + rate limit.
 * - Sports/weather facts require verified LIVE payload from LiveInfoService.
 */

export type RapportTopic = 'daypart' | 'weather' | 'sports' | 'weekend' | 'none';

export type RapportConfig = {
  /** Master kill switch — default off until a manager enables it. */
  enabled: boolean;
  allowWeather: boolean;
  allowSports: boolean;
  allowDaypart: boolean;
  /** Max rapport injections per conversation (default 1). */
  maxPerConversation: number;
};

export const DEFAULT_RAPPORT_CONFIG: RapportConfig = {
  enabled: false,
  allowWeather: false,
  allowSports: false,
  allowDaypart: true,
  maxPerConversation: 1,
};

export type RapportDecision = {
  inject: boolean;
  topic: RapportTopic;
  /** Short opener fragment, or undefined when inject=false */
  opener?: string;
  reason: string;
};

const TASK_OVERRIDE =
  /\b(price|cost|msrp|apr|payment|inventory|in stock|vin|stock|#|appointment|test drive|trade|service|parts|hours|open|financ)\b/i;

/**
 * Decide whether an optional rapport opener is allowed this turn.
 * Does not fetch weather/sports — caller supplies verified live text if any.
 */
export function decideRapport(params: {
  config: RapportConfig;
  customerMessage: string;
  /** True when this turn is primarily a dealership task (inventory, price, etc.) */
  isTaskTurn: boolean;
  /** How many times rapport was already used in this conversation */
  priorRapportCount: number;
  /** Verified live weather text from LiveInfoService, or undefined */
  verifiedWeather?: string;
  /** Verified live sports text, or undefined */
  verifiedSports?: string;
  /** IANA timezone for store; used only for daypart greeting */
  storeTimezone?: string;
  now?: Date;
  lang?: 'en' | 'es';
}): RapportDecision {
  const cfg = params.config;
  if (!cfg.enabled)
    return { inject: false, topic: 'none', reason: 'rapport_disabled' };
  if (params.priorRapportCount >= (cfg.maxPerConversation ?? 1))
    return { inject: false, topic: 'none', reason: 'rate_limited' };
  if (params.isTaskTurn || TASK_OVERRIDE.test(params.customerMessage))
    return { inject: false, topic: 'none', reason: 'task_turn' };

  // Customer asked about weather with verified data → allow a short natural reply path
  // (handled by live-info handlers). Do not invent when unavailable.
  if (
    cfg.allowWeather &&
    /\b(weather|rainy|raining|rain|snow(?:ing|y)?|forecast|temperature)\b/i.test(
      params.customerMessage,
    )
  ) {
    if (!params.verifiedWeather || /unavailable/i.test(params.verifiedWeather))
      return { inject: false, topic: 'weather', reason: 'weather_unavailable' };
    return {
      inject: false, // live-info handler owns the answer; no extra opener
      topic: 'weather',
      reason: 'weather_handled_by_live_info',
    };
  }

  if (
    cfg.allowSports &&
    /\b(score|game|won|win|bears|bulls|cubs|sox|hawks)\b/i.test(
      params.customerMessage,
    )
  ) {
    if (!params.verifiedSports || /unavailable/i.test(params.verifiedSports))
      return { inject: false, topic: 'sports', reason: 'sports_unavailable' };
    return {
      inject: false,
      topic: 'sports',
      reason: 'sports_handled_by_live_info',
    };
  }

  // Optional daypart greeting only on pure greetings
  if (
    cfg.allowDaypart &&
    /^\s*(hi|hello|hey|good (?:morning|afternoon|evening)|hola|buenas)/i.test(
      params.customerMessage,
    ) &&
    params.customerMessage.trim().split(/\s+/).length <= 4
  ) {
    const opener = daypartOpener(
      params.storeTimezone,
      params.now ?? new Date(),
      params.lang ?? 'en',
    );
    return {
      inject: true,
      topic: 'daypart',
      opener,
      reason: 'daypart_greeting',
    };
  }

  return { inject: false, topic: 'none', reason: 'no_fit' };
}

function daypartOpener(
  tz: string | undefined,
  now: Date,
  lang: 'en' | 'es',
): string {
  let hour = now.getHours();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: tz,
      }).formatToParts(now);
      const h = parts.find((p) => p.type === 'hour')?.value;
      if (h != null) hour = parseInt(h, 10);
    } catch {
      /* keep local hour */
    }
  }
  if (lang === 'es') {
    if (hour < 12) return '¡Buenos días!';
    if (hour < 17) return '¡Buenas tardes!';
    return '¡Buenas noches!';
  }
  if (hour < 12) return 'Good morning!';
  if (hour < 17) return 'Good afternoon!';
  return 'Good evening!';
}

/** Parse tenant JSON config safely; always fail closed. */
export function parseRapportConfig(raw: unknown): RapportConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RAPPORT_CONFIG };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    allowWeather: o.allowWeather === true,
    allowSports: o.allowSports === true,
    allowDaypart: o.allowDaypart !== false,
    maxPerConversation:
      typeof o.maxPerConversation === 'number' && o.maxPerConversation >= 0
        ? Math.min(3, Math.floor(o.maxPerConversation))
        : 1,
  };
}
