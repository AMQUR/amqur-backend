/**
 * Public-safe tenant/location branding returned by widget-config.
 * Never include API keys, CRM secrets, internal notes, or private routing.
 */
export type PublicBrandingConfig = {
  assistantDisplayName: string;
  welcomeMessage: string;
  primaryColor: string;
  accentColor: string;
  logoUrl: string | null;
  /** Accessible alt text for logoUrl; never required for render. */
  logoAlt: string | null;
  launcherIconUrl: string | null;
  phone: string | null;
  websiteUrl: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  escalationMessage: string;
  disclaimerText: string;
  supportedLocales: string[];
  salesEnabled: boolean;
  serviceEnabled: boolean;
  partsEnabled: boolean;
};

export const DEFAULT_PUBLIC_BRANDING: PublicBrandingConfig = {
  assistantDisplayName: 'Dealership Assistant',
  welcomeMessage: 'How can I help you today?',
  primaryColor: '#111111',
  accentColor: '#f5f5f5',
  logoUrl: null,
  logoAlt: null,
  launcherIconUrl: null,
  phone: null,
  websiteUrl: null,
  privacyUrl: null,
  termsUrl: null,
  // Durable-local-only handoff default: never claims staff were notified —
  // only that the request is saved for review. Tenants with verified CRM
  // delivery may override per-tenant.
  escalationMessage: 'I can save your request for dealership staff to review.',
  disclaimerText:
    'Vehicle availability, pricing, incentives, and dealership information are provided only when verified.',
  supportedLocales: ['en'],
  salesEnabled: true,
  serviceEnabled: false,
  partsEnabled: false,
};

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function asNullableString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asLocales(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const locales = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
  return locales.length ? locales : fallback;
}

/** Deep-merge tenant + location JSON into a safe public branding object. */
export function mergePublicBranding(
  tenantConfig: unknown,
  locationConfig: unknown,
  locationPhone?: string | null,
): PublicBrandingConfig {
  const t =
    tenantConfig && typeof tenantConfig === 'object'
      ? (tenantConfig as Record<string, unknown>)
      : {};
  const l =
    locationConfig && typeof locationConfig === 'object'
      ? (locationConfig as Record<string, unknown>)
      : {};
  const m = { ...t, ...l };

  return {
    assistantDisplayName: asString(
      m.assistantDisplayName,
      DEFAULT_PUBLIC_BRANDING.assistantDisplayName,
    ),
    welcomeMessage: asString(
      m.welcomeMessage,
      DEFAULT_PUBLIC_BRANDING.welcomeMessage,
    ),
    primaryColor: asString(
      m.primaryColor,
      DEFAULT_PUBLIC_BRANDING.primaryColor,
    ),
    accentColor: asString(m.accentColor, DEFAULT_PUBLIC_BRANDING.accentColor),
    logoUrl: asNullableString(m.logoUrl),
    logoAlt: asNullableString(m.logoAlt),
    launcherIconUrl: asNullableString(m.launcherIconUrl),
    phone: asNullableString(m.phone) ?? asNullableString(locationPhone),
    websiteUrl: asNullableString(m.websiteUrl),
    privacyUrl: asNullableString(m.privacyUrl),
    termsUrl: asNullableString(m.termsUrl),
    escalationMessage: asString(
      m.escalationMessage,
      DEFAULT_PUBLIC_BRANDING.escalationMessage,
    ),
    disclaimerText: asString(
      m.disclaimerText,
      DEFAULT_PUBLIC_BRANDING.disclaimerText,
    ),
    supportedLocales: asLocales(
      m.supportedLocales,
      DEFAULT_PUBLIC_BRANDING.supportedLocales,
    ),
    salesEnabled: asBool(m.salesEnabled, DEFAULT_PUBLIC_BRANDING.salesEnabled),
    serviceEnabled: asBool(
      m.serviceEnabled,
      DEFAULT_PUBLIC_BRANDING.serviceEnabled,
    ),
    partsEnabled: asBool(m.partsEnabled, DEFAULT_PUBLIC_BRANDING.partsEnabled),
  };
}
