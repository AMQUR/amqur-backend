import { randomBytes } from 'crypto';
import {
  consentTextFor,
  consentWording,
  isKnownConsentVersion,
  LEAD_FORM_CONSENT_VERSION,
} from './consent-wording';
import type {
  ContactChannel,
  LeadFormCard,
  LeadFormPurpose,
  OfferedLeadForm,
  SalesDeskLang,
} from './sales-desk.types';

/** Neutral transcript markers — a structured submission never stores its raw payload as text. */
export const LEAD_SUBMITTED_MARKER = '[contact details submitted]';
export const APPOINTMENT_SELECTED_MARKER = '[appointment time selected]';

export function newCardId(prefix: 'lf' | 'pk' | 'sl'): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** EMAIL and CALL are how staff already follow up; TEXT only when SMS is really enabled. */
export function leadFormChannels(smsAllowed: boolean): ContactChannel[] {
  return smsAllowed ? ['EMAIL', 'CALL', 'TEXT'] : ['EMAIL', 'CALL'];
}

/** How long an offered lead form (and the consent wording on it) stays submittable. */
export const LEAD_FORM_TTL_MS = 60 * 60_000;

export function leadFormExpired(
  offered: Pick<OfferedLeadForm, 'issuedAt'>,
  now: Date,
): boolean {
  const issued = Date.parse(offered.issuedAt);
  return Number.isNaN(issued) || now.getTime() - issued > LEAD_FORM_TTL_MS;
}

export function buildLeadForm(p: {
  purpose: LeadFormPurpose;
  rooftopName: string;
  vehicleLabel?: string | null;
  vin?: string | null;
  channels: ContactChannel[];
  lang: SalesDeskLang;
  now: Date;
  /** An unanswered form already offered to this conversation: keep its id. */
  reuse?: OfferedLeadForm;
}): { card: LeadFormCard; offered: OfferedLeadForm } {
  // The id is kept only while the SAME form is still on offer: same language (so one id always
  // means one wording) and not expired. Otherwise the customer gets a fresh form.
  const reuse =
    p.reuse &&
    (p.reuse.language ?? p.lang) === p.lang &&
    !leadFormExpired(p.reuse, p.now)
      ? p.reuse
      : undefined;
  const id = reuse?.id ?? newCardId('lf');
  const es = p.lang === 'es';
  const reason =
    p.purpose === 'callback'
      ? es
        ? 'Para que el equipo pueda darle seguimiento.'
        : 'So the team can follow up with you.'
      : p.purpose === 'parts'
        ? es
          ? 'Para que el equipo de refacciones pueda responderle.'
          : 'So the parts team can get back to you.'
        : es
          ? 'Para que el equipo pueda confirmar su visita con usted.'
          : 'So the team can confirm your visit with you.';
  return {
    card: {
      kind: 'lead_form',
      id,
      purpose: p.purpose,
      rooftopName: p.rooftopName,
      vehicleLabel: p.vehicleLabel ?? null,
      vin: p.vin ?? null,
      channels: p.channels,
      consent: {
        version: LEAD_FORM_CONSENT_VERSION,
        text: consentTextFor(p.channels, p.lang),
      },
      reason,
    },
    offered: {
      id,
      purpose: p.purpose,
      channels: p.channels,
      consentVersion: LEAD_FORM_CONSENT_VERSION,
      // Re-showing the form restarts its validity window.
      issuedAt: p.now.toISOString(),
      language: p.lang,
    },
  };
}

export type LeadSubmissionInput = {
  formId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  preferredChannel: ContactChannel;
  consents: Array<{
    channel: ContactChannel;
    granted: boolean;
    version: string;
  }>;
};

export type LeadRefusal =
  | 'unknown_form'
  | 'form_expired'
  | 'name_required'
  | 'invalid_email'
  | 'invalid_phone'
  | 'channel_not_offered'
  | 'preferred_detail_missing'
  | 'consent_required';

export type ValidatedLead =
  | {
      ok: true;
      contact: {
        firstName: string;
        lastName: string;
        /** Present only when a granted channel covers it. */
        email?: string;
        /** 10 digits, as the conversational path stores it. */
        phone?: string;
        preferredContact: 'email' | 'phone' | 'sms';
        consentToText: boolean;
      };
      /** Language the form was issued in — the language of every stored wording below. */
      language: SalesDeskLang;
      /** One entry per channel the customer actually ticked (and that is usable). */
      grants: Array<{
        channel: ContactChannel;
        ledgerChannel: 'EMAIL' | 'CALL' | 'SMS';
        endpoint: string;
        wording: string;
        version: string;
      }>;
    }
  | { ok: false; reason: LeadRefusal };

const NAME = /^[\p{L}][\p{L}\p{M}'’. -]{0,59}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function usPhone(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!/^[\d\s().+-]+$/.test(raw)) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return null;
}

/**
 * Server-side validation of a lead-form submission. The client is never trusted: the form
 * must be the one this conversation was offered, the preferred channel must be one the
 * rooftop offered, carry its contact detail, and be explicitly granted against a consent
 * version the server recognises. A contact detail is kept only when a granted channel covers
 * it — nothing is stored "just in case".
 */
export function validateLeadSubmission(
  lead: LeadSubmissionInput,
  offered: OfferedLeadForm | undefined,
  /** Fallback only, for a form offered before `language` was stored on it. */
  lang: SalesDeskLang,
  /** When given, the form's validity window (LEAD_FORM_TTL_MS) is enforced. */
  now?: Date,
): ValidatedLead {
  if (!offered || offered.id !== lead.formId)
    return { ok: false, reason: 'unknown_form' };
  if (now && leadFormExpired(offered, now))
    return { ok: false, reason: 'form_expired' };
  // The wording the customer agreed to is the wording that was SHOWN: the form's own language.
  const language = offered.language ?? lang;
  const firstName = lead.firstName?.trim() ?? '';
  const lastName = lead.lastName?.trim() ?? '';
  if (!NAME.test(firstName) || !NAME.test(lastName))
    return { ok: false, reason: 'name_required' };

  const emailRaw = lead.email?.trim().toLowerCase();
  const email = emailRaw ? (EMAIL.test(emailRaw) ? emailRaw : null) : undefined;
  if (email === null) return { ok: false, reason: 'invalid_email' };
  const phoneRaw = lead.phone?.trim();
  const phone = phoneRaw ? usPhone(phoneRaw) : undefined;
  if (phone === null) return { ok: false, reason: 'invalid_phone' };

  const detailFor = (c: ContactChannel) => (c === 'EMAIL' ? email : phone);
  const granted = (c: ContactChannel) =>
    lead.consents.some(
      (x) =>
        x.channel === c &&
        x.granted === true &&
        isKnownConsentVersion(x.version) &&
        x.version === offered.consentVersion,
    );

  const pref = lead.preferredChannel;
  if (!offered.channels.includes(pref))
    return { ok: false, reason: 'channel_not_offered' };
  if (!detailFor(pref))
    return { ok: false, reason: 'preferred_detail_missing' };
  if (!granted(pref)) return { ok: false, reason: 'consent_required' };

  const grants: Extract<ValidatedLead, { ok: true }>['grants'] = [];
  for (const channel of offered.channels) {
    const endpoint = detailFor(channel);
    const wording = consentWording(offered.consentVersion, language, channel);
    if (!endpoint || !wording || !granted(channel)) continue;
    grants.push({
      channel,
      ledgerChannel: channel === 'TEXT' ? 'SMS' : channel,
      endpoint,
      wording,
      version: offered.consentVersion,
    });
  }
  const has = (c: ContactChannel) => grants.some((g) => g.channel === c);
  return {
    ok: true,
    contact: {
      firstName,
      lastName,
      ...(has('EMAIL') && email ? { email } : {}),
      ...((has('CALL') || has('TEXT')) && phone ? { phone } : {}),
      preferredContact:
        pref === 'EMAIL' ? 'email' : pref === 'TEXT' ? 'sms' : 'phone',
      consentToText: has('TEXT'),
    },
    language,
    grants,
  };
}

/** Short, customer-safe explanation for a refused submission (never echoes what was typed). */
export function leadRefusalText(reason: LeadRefusal, lang: SalesDeskLang) {
  const es = lang === 'es';
  switch (reason) {
    case 'consent_required':
      return es
        ? 'Necesito su autorización para ese medio de contacto antes de pasar sus datos, así que no guardé nada.'
        : 'I need your OK for that contact method before I pass your details along, so I haven’t saved anything.';
    case 'preferred_detail_missing':
      return es
        ? 'Falta el dato para el medio de contacto que eligió, así que no guardé nada.'
        : 'The contact method you picked is missing its detail, so I haven’t saved anything.';
    case 'invalid_email':
      return es
        ? 'Ese correo no parece válido, así que no guardé nada.'
        : 'That email doesn’t look right, so I haven’t saved anything.';
    case 'invalid_phone':
      return es
        ? 'Necesito un teléfono de EE. UU. de 10 dígitos, así que no guardé nada.'
        : 'I need a 10-digit US phone number, so I haven’t saved anything.';
    case 'name_required':
      return es
        ? 'Necesito su nombre y apellido, así que no guardé nada.'
        : 'I need your first and last name, so I haven’t saved anything.';
    case 'form_expired':
      return es
        ? 'Ese formulario ya venció, así que no guardé nada.'
        : 'That form has expired, so I haven’t saved anything.';
    case 'channel_not_offered':
      return es
        ? 'Ese medio de contacto no está disponible aquí, así que no guardé nada.'
        : 'That contact method isn’t available here, so I haven’t saved anything.';
    default:
      return es
        ? 'Ese formulario ya no está activo, así que no guardé nada.'
        : 'That form is no longer active, so I haven’t saved anything.';
  }
}
