/**
 * Verified public destinations for a dealer group's rooftops: each store's own website pages
 * for inventory search, service, finance, trade-in, contact and directions.
 *
 * Transcribed from the group-site truth source
 *   dial-auto-group-platform/src/stores/config.ts  (handoff URLs, status CONFIRMED, 2026-11-12;
 *   evidence in that repo's docs/evidence-register.md)
 * and the owner-approved phone directory of the same date. Nothing here is derived, guessed or
 * templated beyond what that file lists: there are no model- or price-filtered search URLs,
 * because none has been verified.
 *
 * These are HANDOFFS, not inventory. A link opens the store's current search page; it says
 * nothing about any individual vehicle, price or availability.
 *
 * Rules:
 *  - `cdjr-south` (Dial Chrysler Dodge Jeep Ram of Chicago, 7340 S Western) and `cdjr-north`
 *    (Jeep of Chicago, 5950 N Western) are different dealerships. Never merge them.
 *  - Three stores' Tekion scheduling links carry an access token and are deliberately absent.
 *    Their "schedule service" destination is the group site's service page for that store,
 *    which holds the official link.
 *  - Store hours are not on file: the directions link goes to the store's own page.
 */
export const DEALER_DIRECTORY_SOURCE =
  'dial-auto-group-platform/src/stores/config.ts' as const;
export const DEALER_DIRECTORY_AS_OF = '2026-11-12' as const;

export type DealerLinkKey =
  | 'home'
  | 'newInventory'
  | 'usedInventory'
  | 'certifiedInventory'
  | 'specials'
  | 'serviceDepartment'
  | 'scheduleService'
  | 'parts'
  | 'finance'
  | 'tradeValue'
  | 'contact'
  | 'directions';

export type DealerStore = {
  /** Rooftop id in the truth source; every fact's sourceRecordId. */
  sourceRecordId: string;
  tenantSlug: string;
  name: string;
  sideOfTown: string;
  brands: string[];
  address: string;
  phones: { sales: string; service: string; parts: string };
  websitePlatform: string;
  links: Partial<Record<DealerLinkKey, string>>;
  source: typeof DEALER_DIRECTORY_SOURCE;
  asOf: typeof DEALER_DIRECTORY_AS_OF;
  verified: true;
};

const GROUP_SITE = 'https://www.dialdifference.com';

const apollo = (
  origin: string,
  scheduleService: string,
): Partial<Record<DealerLinkKey, string>> => ({
  home: `${origin}/`,
  newInventory: `${origin}/inventory/new`,
  usedInventory: `${origin}/inventory/used`,
  certifiedInventory: `${origin}/inventory/cpo`,
  specials: `${origin}/specials/vehicle-specials`,
  serviceDepartment: `${origin}/service-department`,
  scheduleService,
  parts: `${origin}/parts-department`,
  finance: `${origin}/getfinancing`,
  tradeValue: `${origin}/shopperwizard/mytradevalue`,
  contact: `${origin}/contactus`,
  directions: `${origin}/get-directions`,
});

const store = (
  s: Omit<DealerStore, 'source' | 'asOf' | 'verified'>,
): DealerStore => ({
  ...s,
  source: DEALER_DIRECTORY_SOURCE,
  asOf: DEALER_DIRECTORY_AS_OF,
  verified: true,
});

const DIAL_STORES: DealerStore[] = [
  store({
    sourceRecordId: 'chevy',
    tenantSlug: 'dial-chevy-of-chicago',
    name: 'Dial Chevy of Chicago',
    sideOfTown: 'South Side',
    brands: ['Chevrolet'],
    address: '6603 S Western Ave, Chicago, IL 60636',
    phones: {
      sales: '773-423-3000',
      service: '773-423-3002',
      parts: '773-423-3003',
    },
    websitePlatform: 'DealerOn',
    links: {
      home: 'https://www.dialchevy.com/',
      newInventory: 'https://www.dialchevy.com/searchnew.aspx',
      usedInventory: 'https://www.dialchevy.com/searchused.aspx',
      specials: 'https://www.dialchevy.com/new-specials.html',
      serviceDepartment: 'https://www.dialchevy.com/service',
      scheduleService: 'https://www.dialchevy.com/serviceappmt.aspx',
      parts: 'https://www.dialchevy.com/orderparts.aspx',
      finance: 'https://www.dialchevy.com/preapproved.aspx',
      tradeValue: 'https://www.dialchevy.com/trade.aspx',
      contact: 'https://www.dialchevy.com/contact-us.html',
      directions: 'https://www.dialchevy.com/hours.aspx',
    },
  }),
  store({
    sourceRecordId: 'nissan',
    tenantSlug: 'dial-nissan-of-chicago',
    name: 'Dial Nissan of Chicago',
    sideOfTown: 'South Side',
    brands: ['Nissan'],
    address: '7410 S Western Ave, Chicago, IL 60636',
    phones: {
      sales: '773-776-8200',
      service: '773-776-9045',
      parts: '773-776-9056',
    },
    websitePlatform: 'Team Velocity Apollo',
    links: apollo(
      'https://www.dialnissan.com',
      `${GROUP_SITE}/service/dial-nissan`,
    ),
  }),
  store({
    sourceRecordId: 'infiniti',
    tenantSlug: 'infiniti-of-chicago',
    name: 'INFINITI of Chicago',
    sideOfTown: 'Near South Side',
    brands: ['INFINITI'],
    address: '2711 S State St, Chicago, IL 60616',
    phones: {
      sales: '312-476-8000',
      service: '312-476-8020',
      parts: '312-476-8025',
    },
    websitePlatform: 'Team Velocity Apollo',
    links: apollo(
      'https://www.infinitichicago.com',
      `${GROUP_SITE}/service/infiniti-chicago`,
    ),
  }),
  store({
    sourceRecordId: 'cdjr-south',
    tenantSlug: 'dial-cdjr-of-chicago',
    name: 'Dial Chrysler Dodge Jeep Ram of Chicago',
    sideOfTown: 'South Side',
    brands: ['Ram', 'Dodge', 'Chrysler', 'Jeep'],
    address: '7340 S Western Ave, Chicago, IL 60636',
    phones: {
      sales: '773-476-7800',
      service: '773-476-7802',
      parts: '773-476-7729',
    },
    websitePlatform: 'Team Velocity Apollo',
    links: apollo(
      'https://www.dialjeep.com',
      `${GROUP_SITE}/service/dial-cdjr-south`,
    ),
  }),
  store({
    sourceRecordId: 'cdjr-north',
    tenantSlug: 'jeep-of-chicago',
    name: 'Jeep of Chicago',
    sideOfTown: 'North Side',
    brands: ['Jeep', 'Ram', 'Dodge', 'Chrysler'],
    address: '5950 N Western Ave, Chicago, IL 60659',
    phones: {
      sales: '773-334-3400',
      service: '773-828-1050',
      parts: '773-828-9952',
    },
    websitePlatform: 'Team Velocity Apollo',
    links: apollo(
      'https://www.jeepofchicago.com',
      'https://www.jeepofchicago.com/scheduleservice',
    ),
  }),
];

const GROUPS: Array<{ groupSiteSlug: string; stores: DealerStore[] }> = [
  { groupSiteSlug: 'dial-auto-group', stores: DIAL_STORES },
];

/** Hosts a directory link may point at. A card never carries a URL outside this set. */
export const DEALER_DIRECTORY_HOSTS: ReadonlySet<string> = new Set(
  GROUPS.flatMap((g) => g.stores)
    .flatMap((s) => Object.values(s.links))
    .map((u) => new URL(u).hostname),
);

/** Every store phone in the directory, digits only (10 digits). */
export const DEALER_DIRECTORY_PHONE_DIGITS: ReadonlySet<string> = new Set(
  GROUPS.flatMap((g) => g.stores)
    .flatMap((s) => Object.values(s.phones))
    .map((p) => p.replace(/\D/g, ''))
    .filter((p) => p.length === 10),
);

export type DealerDirectoryView = {
  /** The store this conversation belongs to; null on the group site. */
  self: DealerStore | null;
  /** Every store of the same group, in directory order. */
  group: DealerStore[];
};

/** The directory as seen from one tenant: its own store, and its group's stores. */
export function dealerDirectoryFor(
  tenantSlug: string,
): DealerDirectoryView | null {
  for (const g of GROUPS) {
    if (g.groupSiteSlug === tenantSlug) return { self: null, group: g.stores };
    const self = g.stores.find((s) => s.tenantSlug === tenantSlug);
    if (self) return { self, group: g.stores };
  }
  return null;
}

const STORE_WORDS: Array<{ ids: string[]; re: RegExp }> = [
  { ids: ['chevy'], re: /\bchev(?:y|rolet)\b/i },
  { ids: ['nissan'], re: /\bnissan\b/i },
  { ids: ['infiniti'], re: /\binfiniti\b/i },
  {
    ids: ['cdjr-north'],
    re: /\bjeep of chicago\b|\bnorth(?:\s+side)?\b[^.?!\n]{0,24}\b(?:jeep|cdjr|store|dealer)|\b(?:jeep|cdjr|store)\b[^.?!\n]{0,24}\bnorth\b|\b5950\b/i,
  },
  {
    ids: ['cdjr-south'],
    re: /\bdial (?:cdjr|jeep|chrysler)\b|\bsouth(?:\s+side)?\b[^.?!\n]{0,24}\b(?:jeep|cdjr|store|dealer)|\b(?:jeep|cdjr|store)\b[^.?!\n]{0,24}\bsouth\b|\b7340\b/i,
  },
  // A brand sold at both Chrysler Dodge Jeep Ram stores names both; never one of them.
  {
    ids: ['cdjr-north', 'cdjr-south'],
    re: /\b(?:jeep|ram|dodge|chrysler|cdjr)\b/i,
  },
];

/**
 * The stores a message names, in directory order. A specific store ("Jeep of Chicago", "the
 * South Side CDJR") wins over a shared brand word; "Jeep" alone returns both Jeep stores.
 * Empty when the message names none.
 */
export function storesNamedIn(
  message: string,
  stores: readonly DealerStore[],
): DealerStore[] {
  const hit = new Set<string>();
  let specificCdjr = false;
  for (const w of STORE_WORDS) {
    if (!w.re.test(message)) continue;
    if (w.ids.length === 1) {
      hit.add(w.ids[0]);
      if (w.ids[0].startsWith('cdjr-')) specificCdjr = true;
    } else if (!specificCdjr) {
      for (const id of w.ids) hit.add(id);
    }
  }
  return stores.filter((d) => hit.has(d.sourceRecordId));
}

export type DealerFocus =
  | 'new'
  | 'used'
  | 'certified'
  | 'service'
  | 'parts'
  | 'finance'
  | 'trade'
  | 'visit';

export const DEALER_FOCUSES: readonly DealerFocus[] = [
  'new',
  'used',
  'certified',
  'service',
  'parts',
  'finance',
  'trade',
  'visit',
];

export type DealershipCardLink = {
  key: DealerLinkKey | 'callSales' | 'callService' | 'callParts';
  label: string;
  url: string;
  primary?: boolean;
};

export type DealershipCard = {
  kind: 'dealership';
  storeId: string;
  name: string;
  sideOfTown: string;
  brands: string[];
  address: string;
  focus: DealerFocus;
  /** Says what the links are: the store's own pages, not individual vehicles. */
  note: string;
  links: DealershipCardLink[];
  sourceRecordId: string;
  asOf: string;
  verified: true;
};

const LABELS: Record<DealershipCardLink['key'], { en: string; es: string }> = {
  home: { en: 'Visit website', es: 'Visitar sitio web' },
  newInventory: { en: 'View new inventory', es: 'Ver inventario nuevo' },
  usedInventory: { en: 'View used inventory', es: 'Ver inventario usado' },
  certifiedInventory: {
    en: 'View certified pre-owned',
    es: 'Ver seminuevos certificados',
  },
  specials: { en: 'Current specials', es: 'Ofertas actuales' },
  serviceDepartment: {
    en: 'Service department',
    es: 'Departamento de servicio',
  },
  scheduleService: { en: 'Schedule service', es: 'Programar servicio' },
  parts: { en: 'Parts department', es: 'Departamento de refacciones' },
  finance: { en: 'Finance application', es: 'Solicitud de financiamiento' },
  tradeValue: { en: 'Value your trade', es: 'Valorar su vehículo' },
  contact: { en: 'Contact the store', es: 'Contactar a la agencia' },
  directions: { en: 'Get directions', es: 'Cómo llegar' },
  callSales: { en: 'Call sales', es: 'Llamar a ventas' },
  callService: { en: 'Call service', es: 'Llamar a servicio' },
  callParts: { en: 'Call parts', es: 'Llamar a refacciones' },
};

const NOTES: Record<DealerFocus, { en: string; es: string }> = {
  new: {
    en: "Opens this store's current inventory on its own website. Confirm availability and price with the store.",
    es: 'Abre el inventario actual de esta agencia en su propio sitio. Confirme disponibilidad y precio con la agencia.',
  },
  used: {
    en: "Opens this store's current inventory on its own website. Confirm availability and price with the store.",
    es: 'Abre el inventario actual de esta agencia en su propio sitio. Confirme disponibilidad y precio con la agencia.',
  },
  certified: {
    en: "Opens this store's current inventory on its own website. Confirm availability and price with the store.",
    es: 'Abre el inventario actual de esta agencia en su propio sitio. Confirme disponibilidad y precio con la agencia.',
  },
  service: {
    en: "Booking happens on the store's own scheduling page. Nothing is booked from this chat.",
    es: 'La cita se agenda en la página de la agencia. Nada se agenda desde este chat.',
  },
  parts: {
    en: 'Parts availability and pricing are confirmed by the store.',
    es: 'La agencia confirma disponibilidad y precio de refacciones.',
  },
  finance: {
    en: "The application is on the store's own secure page. Do not share financial details in chat.",
    es: 'La solicitud está en la página segura de la agencia. No comparta datos financieros en el chat.',
  },
  trade: {
    en: "The estimate tool is on the store's own website. A final value comes from the store.",
    es: 'La herramienta está en el sitio de la agencia. El valor final lo da la agencia.',
  },
  visit: {
    en: "Links open the store's own website.",
    es: 'Los enlaces abren el sitio de la agencia.',
  },
};

const ORDER: Record<DealerFocus, DealershipCardLink['key'][]> = {
  new: ['newInventory', 'usedInventory', 'callSales', 'directions', 'home'],
  used: [
    'usedInventory',
    'certifiedInventory',
    'newInventory',
    'callSales',
    'directions',
  ],
  certified: [
    'certifiedInventory',
    'usedInventory',
    'callSales',
    'directions',
    'home',
  ],
  service: [
    'scheduleService',
    'serviceDepartment',
    'callService',
    'directions',
  ],
  parts: ['parts', 'callParts', 'callService', 'directions'],
  finance: ['finance', 'callSales', 'contact', 'home'],
  trade: ['tradeValue', 'callSales', 'contact', 'directions'],
  visit: ['directions', 'callSales', 'contact', 'home', 'newInventory'],
};

const tel = (n: string) => `tel:+1${n.replace(/\D/g, '')}`;

export function buildDealershipCard(
  s: DealerStore,
  focus: DealerFocus,
  lang: 'en' | 'es',
): DealershipCard {
  const urlFor = (k: DealershipCardLink['key']): string | null => {
    if (k === 'callSales') return s.phones.sales ? tel(s.phones.sales) : null;
    if (k === 'callService')
      return s.phones.service ? tel(s.phones.service) : null;
    if (k === 'callParts') return s.phones.parts ? tel(s.phones.parts) : null;
    return s.links[k] ?? null;
  };
  const links: DealershipCardLink[] = [];
  for (const key of ORDER[focus]) {
    const url = urlFor(key);
    if (!url) continue;
    const phone =
      key === 'callSales'
        ? s.phones.sales
        : key === 'callService'
          ? s.phones.service
          : key === 'callParts'
            ? s.phones.parts
            : '';
    links.push({
      key,
      label: phone ? `${LABELS[key][lang]} ${phone}` : LABELS[key][lang],
      url,
      ...(links.length === 0 ? { primary: true } : {}),
    });
  }
  return {
    kind: 'dealership',
    storeId: s.sourceRecordId,
    name: s.name,
    sideOfTown: s.sideOfTown,
    brands: s.brands,
    address: s.address,
    focus,
    note: NOTES[focus][lang],
    links,
    sourceRecordId: s.sourceRecordId,
    asOf: s.asOf,
    verified: true,
  };
}
