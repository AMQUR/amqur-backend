import { createHash } from 'crypto';

/**
 * Credit-application destination model.
 *
 * A dealership may hand AMQUR a provider link such as a Tekion consumer-credit URL that
 * carries an opaque `token` query parameter. Whether that token is (a) a public reusable
 * application link, (b) a dealership-specific reusable link, or (c) a per-customer session
 * link is a VENDOR fact. AMQUR never guesses it:
 *
 *  - UNVERIFIED       — supplied by an owner/admin, link type not yet confirmed by the vendor.
 *                       Never redirects customer traffic. (Optional non-production demo preview
 *                       shows the card and an interstitial — no navigation, no token use.)
 *  - PUBLIC_REUSABLE  — vendor/dealer confirmed it is meant for public distribution.
 *  - DEALER_REUSABLE  — vendor/dealer confirmed it is reusable for THIS rooftop.
 *  - PER_CUSTOMER     — vendor issues a fresh link per shopper; a static token must never be
 *                       distributed. Requires an official provider API (CreditLinkProvider).
 *
 * Live redirects additionally require a recorded dealership authorization for the specific
 * location. URLs whose query string looks like a credential must be stored in the encrypted
 * IntegrationSecret vault, never in plaintext JSON, logs, analytics or API responses.
 */
export type CreditLinkType =
  | 'UNVERIFIED'
  | 'PUBLIC_REUSABLE'
  | 'DEALER_REUSABLE'
  | 'PER_CUSTOMER';

export const CREDIT_LINK_TYPES: CreditLinkType[] = [
  'UNVERIFIED',
  'PUBLIC_REUSABLE',
  'DEALER_REUSABLE',
  'PER_CUSTOMER',
];

/** Provider hosts AMQUR knows how to label. Allowlisting is still explicit per location. */
export const KNOWN_CREDIT_PROVIDERS: Record<string, string> = {
  'consumer-credit.tekioncloud.com': 'Tekion',
};

export const CREDIT_CONNECTION_CAPABILITY = 'credit_application';
export const CREDIT_SECRET_KEY = 'destinationUrl';

export type CreditAuthorization = {
  approvedBy: string;
  approvedAt: string;
  /** Pointer to the written approval (ticket, email id, contract clause) — never the document. */
  evidenceRef: string;
};

/** Non-secret connection config persisted in IntegrationConnection.config. */
export type CreditConnectionConfig = {
  host: string;
  providerName: string | null;
  linkType: CreditLinkType;
  fingerprint: string;
  configuredAt: string;
  configuredBy: string;
  authorization: CreditAuthorization | null;
  /** Non-production only: show a labeled preview instead of failing closed. */
  demoPreview: boolean;
  label?: string | null;
};

const SENSITIVE_PARAM =
  /^(token|access_?token|auth|key|api_?key|secret|sig|signature|session|sid|code|t)$/i;

/** True when the URL carries something that looks like a credential in its query/fragment. */
export function urlLooksSensitive(raw: string): boolean {
  try {
    const u = new URL(raw);
    for (const k of u.searchParams.keys())
      if (SENSITIVE_PARAM.test(k)) return true;
    return u.hash.length > 1 && /token|key|secret/i.test(u.hash);
  } catch {
    return true;
  }
}

/** Stable, non-reversible identifier so staff can tell destinations apart after rotation. */
export function destinationFingerprint(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

export type DestinationCheck =
  | { ok: true; url: URL; host: string }
  | {
      ok: false;
      reason: 'invalid_url' | 'not_https' | 'host_not_allowlisted';
    };

export function checkDestination(
  raw: string,
  allowedHosts: string[],
): DestinationCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port)
    return { ok: false, reason: 'not_https' };
  const host = u.hostname.toLowerCase();
  if (!allowedHosts.map((h) => h.trim().toLowerCase()).includes(host))
    return { ok: false, reason: 'host_not_allowlisted' };
  return { ok: true, url: u, host };
}

/** A public, masked view — safe for staff UIs and API responses (no path/query/token). */
export function maskedDestination(c: CreditConnectionConfig | null) {
  if (!c) return null;
  return {
    host: c.host,
    providerName: c.providerName,
    linkType: c.linkType,
    fingerprint: c.fingerprint,
    configuredAt: c.configuredAt,
    authorized: !!c.authorization,
    authorization: c.authorization
      ? {
          approvedAt: c.authorization.approvedAt,
          evidenceRef: c.authorization.evidenceRef,
        }
      : null,
    demoPreview: c.demoPreview,
    tokenStoredEncrypted: true,
  };
}

/**
 * Official per-customer link issuance (PER_CUSTOMER link type). No implementation exists
 * until the vendor's official API contract and credentials are supplied; until then the
 * registry returns null and the feature fails closed with a finance-team handoff.
 */
export interface CreditLinkProvider {
  readonly providerName: string;
  isConfigured(): boolean;
  issueLink(input: {
    tenantId: string;
    locationId: string;
    financeRequestId: string;
  }): Promise<{ url: string; expiresAt: string | null }>;
}
