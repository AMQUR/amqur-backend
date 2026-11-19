/**
 * Handset opt-out lock (security review M2).
 *
 * The web lead form does not verify that the visitor owns the phone number they type. A consent
 * grant from the form (`WIDGET`), from staff or from an import therefore must not undo an
 * opt-out that came from the handset itself (a STOP keyword) or from the messaging provider:
 * otherwise anyone could re-open texting to a number that asked for it to stop.
 *
 * Rule, per (channel, endpoint): while the LATEST handset/provider-sourced record is an opt-out,
 * the channel is opted out — whatever other sources recorded afterwards. Only a later
 * handset/provider-sourced grant (the customer texting START) lifts it.
 */
export const HANDSET_CONSENT_SOURCES = ['SMS_KEYWORD', 'PROVIDER'] as const;

/** Evidence marker on a grant that was recorded but has no effect because the lock stands. */
export const GRANT_NOT_EFFECTIVE_HANDSET_OPT_OUT = 'handset_opt_out_stands';

export function isHandsetConsentSource(source: unknown): boolean {
  return (
    typeof source === 'string' &&
    (HANDSET_CONSENT_SOURCES as readonly string[]).includes(source)
  );
}

type Row = { source?: string | null; granted: boolean; createdAt: Date };

/**
 * `rows` are the ledger records of ONE (channel, endpoint), in any order. True when the latest
 * handset/provider-sourced record is an opt-out (on an exact timestamp tie the opt-out wins).
 */
export function handsetOptOutStands(rows: ReadonlyArray<Row>): boolean {
  let latest: Row | null = null;
  for (const r of rows) {
    if (!isHandsetConsentSource(r.source)) continue;
    if (
      !latest ||
      r.createdAt.getTime() > latest.createdAt.getTime() ||
      (r.createdAt.getTime() === latest.createdAt.getTime() && !r.granted)
    )
      latest = r;
  }
  return latest !== null && !latest.granted;
}

/**
 * Customer-facing wording when a text opt-in from the form/chat cannot take effect. Deliberately
 * neutral: it states what will happen and how to turn texts on from the phone itself, and says
 * nothing about the number's history (the visitor may not be its owner).
 */
export function textStaysOffText(lang: 'en' | 'es'): string {
  return lang === 'es'
    ? 'Los mensajes de texto no se pueden activar para ese número desde aquí, así que seguirán desactivados. El equipo usará sus otros datos de contacto. Para recibir mensajes, envíe START desde ese teléfono al número de mensajes del concesionario.'
    : 'Text messages can’t be turned on for that number from here, so texting stays off. The team will use your other contact details. To get texts, send START from that phone to the dealership’s text number.';
}
