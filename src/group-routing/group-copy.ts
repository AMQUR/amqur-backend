import type { GroupMember, Lang, ShownVehicle } from './group-routing.types';

const tr = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

export function sideLabel(side: GroupMember['side'], lang: Lang): string {
  if (!side) return '';
  return side === 'north'
    ? tr(lang, 'North Side', 'Lado Norte')
    : tr(lang, 'South Side', 'Lado Sur');
}

/** Public name plus side — the only way a rooftop is ever named on the group site. */
export function rooftopLabel(m: GroupMember, lang: Lang): string {
  return m.side ? `${m.name} (${sideLabel(m.side, lang)})` : m.name;
}

function list(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join('');
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')} ${tr(lang, 'and', 'y')} ${last}`;
}

export function vehicleName(v: {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
}): string {
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
}

export function eitherLabel(lang: Lang) {
  return tr(lang, 'Either', 'Cualquiera');
}

/** "North Side, South Side, or either?" — asked once, before any vehicle is shown. */
export function searchStoreAsk(
  options: GroupMember[],
  style: 'side' | 'name',
  what: string | null,
  lang: Lang,
): { text: string; quickReplies: string[] } {
  const names = options.map((m) => rooftopLabel(m, lang));
  const thing = what
    ? tr(lang, `${what} in stock`, `${what} en existencia`)
    : tr(lang, 'matches in stock', 'opciones en existencia');
  const choices =
    style === 'side'
      ? tr(
          lang,
          'Which would you like to see — North Side, South Side, or either?',
          '¿Cuál quiere ver — Lado Norte, Lado Sur, o cualquiera?',
        )
      : tr(
          lang,
          'Which store would you like to see, or either?',
          '¿Qué tienda quiere ver, o cualquiera?',
        );
  return {
    text: tr(
      lang,
      `${options.length === 2 ? 'Two' : `${options.length}`} separate stores have ${thing}: ${list(names, lang)}. ${choices}`,
      `${options.length === 2 ? 'Dos' : `${options.length}`} tiendas distintas tienen ${thing}: ${list(names, lang)}. ${choices}`,
    ),
    quickReplies: [
      ...(style === 'side'
        ? options.map((m) => sideLabel(m.side, lang))
        : names),
      eitherLabel(lang),
    ].slice(0, 6),
  };
}

/** "Which store?" before service, parts, a person, or anything that creates a record. */
export function requestStoreAsk(
  members: readonly GroupMember[],
  lang: Lang,
  opts: { contactWithheld?: boolean } = {},
): { text: string; quickReplies: string[] } {
  const names = members.map((m) => rooftopLabel(m, lang));
  const lead = opts.contactWithheld
    ? tr(
        lang,
        'I haven’t saved or passed on those contact details yet — each store is separate, so I need to know which one should have them.',
        'Todavía no guardé ni compartí esos datos de contacto — cada tienda es independiente, así que necesito saber cuál debe tenerlos.',
      )
    : tr(
        lang,
        'Each of our stores has its own team, so I need to know which one you mean.',
        'Cada una de nuestras tiendas tiene su propio equipo, así que necesito saber a cuál se refiere.',
      );
  return {
    text: `${lead} ${tr(lang, 'Which store would you like?', '¿Qué tienda prefiere?')} ${list(names, lang)}.`,
    quickReplies: names.slice(0, 8),
  };
}

export function whichSideAsk(
  options: GroupMember[],
  lang: Lang,
): { text: string; quickReplies: string[] } {
  const names = options.map((m) => rooftopLabel(m, lang));
  return {
    text: tr(
      lang,
      `Those are separate stores: ${list(names, lang)}. Which one do you mean?`,
      `Esas son tiendas distintas: ${list(names, lang)}. ¿A cuál se refiere?`,
    ),
    quickReplies: names.slice(0, 6),
  };
}

export function whichVehicleAsk(
  shown: readonly ShownVehicle[],
  labelOf: (tenantId: string) => string,
  lang: Lang,
): { text: string; quickReplies: string[] } {
  return {
    text: tr(
      lang,
      'Which vehicle do you mean? Tap one, or tell me its number in the list — each one is at the store named on its card.',
      '¿A cuál vehículo se refiere? Toque uno, o dígame su número en la lista — cada uno está en la tienda que indica su tarjeta.',
    ),
    quickReplies: shown
      .slice(0, 6)
      .map(
        (v, n) =>
          `${tr(lang, 'Number', 'Número')} ${n + 1}: ${vehicleName(v)} · ${labelOf(v.tenantId)}`,
      ),
  };
}

export function multiStoreNote(count: number, lang: Lang): string {
  return tr(
    lang,
    `These are at ${count} separate stores — each card names the store that has it.`,
    `Están en ${count} tiendas distintas — cada tarjeta indica la tienda que lo tiene.`,
  );
}

export function nowWithStore(m: GroupMember, lang: Lang): string {
  return tr(
    lang,
    `You’re now with ${rooftopLabel(m, lang)}.`,
    `Ahora está con ${rooftopLabel(m, lang)}.`,
  );
}

export function resendContactNote(m: GroupMember, lang: Lang): string {
  return tr(
    lang,
    `${nowWithStore(m, lang)} Please send your contact details again so they go only to this store.`,
    `${nowWithStore(m, lang)} Envíe de nuevo sus datos de contacto para que lleguen solo a esta tienda.`,
  );
}

/** Told once when the customer moves to a second rooftop after giving details to the first. */
export function switchNotice(
  from: GroupMember,
  to: GroupMember,
  lang: Lang,
): string {
  return tr(
    lang,
    `This one is at ${rooftopLabel(to, lang)}, a separate store. Your contact details stay with ${rooftopLabel(from, lang)} — I have not shared them. If you want ${to.name} to follow up, you’ll need to give them again here.`,
    `Este está en ${rooftopLabel(to, lang)}, una tienda distinta. Sus datos de contacto se quedan con ${rooftopLabel(from, lang)} — no los compartí. Si quiere que ${to.name} le dé seguimiento, tendrá que proporcionarlos de nuevo aquí.`,
  );
}

/** "Book me at the South store for this North VIN" — truthful, nothing moved. */
export function vehicleAtOtherStore(
  v: { year?: number; make?: string; model?: string; trim?: string },
  owner: GroupMember,
  asked: GroupMember,
  lang: Lang,
): { text: string; quickReplies: string[] } {
  const name = vehicleName(v) || tr(lang, 'That vehicle', 'Ese vehículo');
  return {
    text: tr(
      lang,
      `The ${name} is at ${rooftopLabel(owner, lang)}, not at ${rooftopLabel(asked, lang)} — they are separate stores, and I can’t book it at one while it sits at the other or promise it can be moved. Nothing was scheduled. I can set up a visit at ${owner.name} for it, or ask their team whether a transfer is possible.`,
      `El ${name} está en ${rooftopLabel(owner, lang)}, no en ${rooftopLabel(asked, lang)} — son tiendas distintas, y no puedo agendarlo en una mientras está en la otra ni prometer un traslado. No se agendó nada. Puedo programar una visita en ${owner.name} para verlo, o preguntar a su equipo si es posible un traslado.`,
    ),
    quickReplies: [
      tr(lang, `Visit ${owner.name}`, `Visitar ${owner.name}`),
      tr(lang, 'Ask the team', 'Preguntar al equipo'),
    ],
  };
}

export function vinNotInGroup(lang: Lang): string {
  return tr(
    lang,
    'I couldn’t find that vehicle in the current inventory of our stores, so nothing was started. Want me to search for something similar?',
    'No encontré ese vehículo en el inventario actual de nuestras tiendas, así que no se inició nada. ¿Quiere que busque algo parecido?',
  );
}

export function referenceNotVerified(lang: Lang): string {
  return tr(
    lang,
    'I couldn’t verify which store that vehicle belongs to, so nothing was started or saved. Search again and pick it from the fresh list.',
    'No pude verificar a qué tienda pertenece ese vehículo, así que no se inició ni se guardó nada. Busque de nuevo y elíjalo de la lista actualizada.',
  );
}

export function vinAtSeveralStores(options: GroupMember[], lang: Lang) {
  return whichSideAsk(options, lang);
}

/** The group tenant's own conversation never creates a customer record. */
export function needsStoreFirst(lang: Lang): string {
  return tr(
    lang,
    'I can set that up with the store that has the vehicle — pick a vehicle from the list, or tell me which store you’d like.',
    'Puedo gestionarlo con la tienda que tiene el vehículo — elija un vehículo de la lista, o dígame qué tienda prefiere.',
  );
}
