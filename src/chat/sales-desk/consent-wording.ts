import type { ContactChannel, SalesDeskLang } from './sales-desk.types';

/**
 * Lead-form consent wording — a versioned server-side constant. The exact text shown is
 * stored with every consent record together with this version, and a submission must echo a
 * version listed here or it is refused.
 *
 * The TEXT wording carries the same disclosures as the approved conversational wording
 * (`sms-continuation-v1`: message and data rates, STOP). These lines state what the customer
 * is agreeing to and nothing more: no legal or safe-harbour claim is made. Any change to the
 * wording REQUIRES a new version — never edit a published version in place.
 */
export const LEAD_FORM_CONSENT_VERSION = 'lead-form-consent-v1';

const WORDING: Record<
  string,
  Record<SalesDeskLang, Record<ContactChannel, string>>
> = {
  [LEAD_FORM_CONSENT_VERSION]: {
    en: {
      EMAIL: 'OK for the dealership to email me about this request.',
      CALL: 'OK for the dealership to call me about this request.',
      TEXT: 'OK for the dealership to text me about this request. Msg & data rates may apply; reply STOP anytime.',
    },
    es: {
      EMAIL: 'Está bien que la agencia me envíe correos sobre esta solicitud.',
      CALL: 'Está bien que la agencia me llame sobre esta solicitud.',
      TEXT: 'Está bien que la agencia me envíe mensajes de texto sobre esta solicitud. Pueden aplicar tarifas de mensajes y datos; responda STOP para cancelar.',
    },
  },
};

export function isKnownConsentVersion(version: unknown): version is string {
  return typeof version === 'string' && Object.hasOwn(WORDING, version);
}

/** Exact wording for one channel, or null when the version/channel is not recognised. */
export function consentWording(
  version: string,
  lang: SalesDeskLang,
  channel: ContactChannel,
): string | null {
  return WORDING[version]?.[lang]?.[channel] ?? null;
}

export function consentTextFor(
  channels: ContactChannel[],
  lang: SalesDeskLang,
  version = LEAD_FORM_CONSENT_VERSION,
): Partial<Record<ContactChannel, string>> {
  const out: Partial<Record<ContactChannel, string>> = {};
  for (const c of channels) {
    const w = consentWording(version, lang, c);
    if (w) out[c] = w;
  }
  return out;
}
