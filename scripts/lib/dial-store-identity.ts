/**
 * REAL identity facts for the five Dial Auto Group rooftops and the group itself.
 *
 * Transcribed from the group-site truth source
 *   dial-auto-group-platform/src/stores/config.ts   (as of 2026-11-12)
 * Identity only: names, side of town, street address, the three department MAIN phone
 * lines, brands, website home URL and the service-scheduling handoff URL.
 *
 * Rules (do not "fix" anything here to match another source):
 *  - Phones are the owner-approved `departments[].phone` values. The `forwardingCandidate`
 *    numbers and the numbers shown on the public rooftop sites are deliberately NOT here.
 *  - `cdjr-south` (Dial Chrysler Dodge Jeep Ram of Chicago, 7340 S Western Ave, South Side)
 *    and `cdjr-north` (Jeep of Chicago, 5950 N Western Ave, North Side) are two different
 *    dealerships. Never merge or swap their facts.
 *  - Store hours are NOT on file. There is no hours fact here on purpose.
 *  - Three scheduler URLs carry an access-token query parameter. They may be stored and
 *    handed off, but must NEVER be logged, printed, or put into knowledge text. Use
 *    `describeSchedulerLink()` whenever something has to be shown.
 */

export const DIAL_IDENTITY_SOURCE =
  'dial-auto-group-platform/src/stores/config.ts' as const;
export const DIAL_IDENTITY_AS_OF = '2026-11-12' as const;

export type DialFactStatus = 'OWNER_APPROVED' | 'PUBLIC_CORROBORATED';

export type DialFact<T> = {
  value: T;
  source: typeof DIAL_IDENTITY_SOURCE;
  asOf: typeof DIAL_IDENTITY_AS_OF;
  status: DialFactStatus;
  /** The `id` of the rooftop (or group) record in config.ts this fact was read from. */
  sourceRecordId: string;
};

export type DialAddress = {
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

export type DialDepartmentId = 'sales' | 'service' | 'parts';
export type DialSchedulerKind = 'tekion-consumer-link' | 'rooftop-site-page';
export type DialRooftopId =
  | 'chevy'
  | 'nissan'
  | 'infiniti'
  | 'cdjr-south'
  | 'cdjr-north';

export type DialRooftopIdentity = {
  /** config.ts rooftop id — also every fact's `sourceRecordId`. */
  sourceRecordId: DialRooftopId;
  /** Backend tenant slug (same slugs as the synthetic staging seed). */
  tenantSlug: string;
  /** Only the two CDJR stores carry a routing side; it is what tells them apart. */
  groupSide: 'north' | 'south' | null;
  /** Lower-case routing aliases, identical to the staging seed's. */
  groupAliases: string[];
  publicName: DialFact<string>;
  sideOfTown: DialFact<string>;
  address: DialFact<DialAddress>;
  phones: Record<DialDepartmentId, DialFact<string>>;
  brands: DialFact<string[]>;
  websiteUrl: DialFact<string>;
  /** MAY CONTAIN AN ACCESS TOKEN in the query string — never log `.value`. */
  scheduleServiceUrl: DialFact<string>;
  schedulerKind: DialSchedulerKind;
};

const fact = <T>(
  sourceRecordId: string,
  status: DialFactStatus,
  value: T,
): DialFact<T> => ({
  value,
  source: DIAL_IDENTITY_SOURCE,
  asOf: DIAL_IDENTITY_AS_OF,
  status,
  sourceRecordId,
});

const chicago = (street: string, postalCode: string): DialAddress => ({
  street,
  city: 'Chicago',
  region: 'IL',
  postalCode,
  country: 'US',
});

function rooftop(r: {
  id: DialRooftopId;
  tenantSlug: string;
  groupSide?: 'north' | 'south';
  groupAliases?: string[];
  publicName: string;
  sideOfTown: string;
  address: DialAddress;
  sales: string;
  service: string;
  parts: string;
  brands: string[];
  websiteUrl: string;
  scheduleServiceUrl: string;
  schedulerKind: DialSchedulerKind;
}): DialRooftopIdentity {
  const owner = <T>(v: T) => fact(r.id, 'OWNER_APPROVED', v);
  const pub = <T>(v: T) => fact(r.id, 'PUBLIC_CORROBORATED', v);
  return {
    sourceRecordId: r.id,
    tenantSlug: r.tenantSlug,
    groupSide: r.groupSide ?? null,
    groupAliases: r.groupAliases ?? [],
    publicName: owner(r.publicName),
    sideOfTown: pub(r.sideOfTown),
    address: pub(r.address),
    phones: {
      sales: owner(r.sales),
      service: owner(r.service),
      parts: owner(r.parts),
    },
    brands: pub(r.brands),
    websiteUrl: pub(r.websiteUrl),
    // Owner-supplied (config.ts marks these OWNER_SUPPLIED_UNTESTED: loaded read-only,
    // no booking was ever made through them).
    scheduleServiceUrl: owner(r.scheduleServiceUrl),
    schedulerKind: r.schedulerKind,
  };
}

const TEKION_CONSUMER =
  'https://conscheduling.tekioncloud.com/consumer-scheduling/sign-in/phone?accessToken=';

export const DIAL_GROUP = {
  sourceRecordId: 'dial-auto-group',
  /** DealerGroup slug and group-site tenant slug. */
  slug: 'dial-auto-group',
  name: fact('dial-auto-group', 'OWNER_APPROVED', 'Dial Auto Group'),
  city: 'Chicago',
  region: 'IL',
  timezone: 'America/Chicago',
  /** config.ts `group.currentWebsite`. Not written to the database (see bootstrap notes). */
  currentWebsite: fact(
    'dial-auto-group',
    'PUBLIC_CORROBORATED',
    'https://www.dialautogroup.com/',
  ),
  /** config.ts `group.groupPhone` is null: the group has no phone line of its own. */
  groupPhone: null,
} as const;

export const DIAL_ROOFTOPS: readonly DialRooftopIdentity[] = [
  rooftop({
    id: 'chevy',
    tenantSlug: 'dial-chevy-of-chicago',
    groupAliases: ['dial chevy', 'dial chevrolet'],
    publicName: 'Dial Chevy of Chicago',
    sideOfTown: 'South Side',
    address: chicago('6603 S Western Ave', '60636'),
    sales: '773-423-3000',
    service: '773-423-3002',
    parts: '773-423-3003',
    brands: ['Chevrolet'],
    websiteUrl: 'https://www.dialchevy.com/',
    scheduleServiceUrl: 'https://www.dialchevy.com/serviceappmt.aspx',
    schedulerKind: 'rooftop-site-page',
  }),
  rooftop({
    id: 'nissan',
    tenantSlug: 'dial-nissan-of-chicago',
    groupAliases: ['dial nissan'],
    publicName: 'Dial Nissan of Chicago',
    sideOfTown: 'South Side',
    address: chicago('7410 S Western Ave', '60636'),
    sales: '773-776-8200',
    service: '773-776-9045',
    parts: '773-776-9056',
    brands: ['Nissan'],
    websiteUrl: 'https://www.dialnissan.com/',
    scheduleServiceUrl: `${TEKION_CONSUMER}jdcauto_249_7275`,
    schedulerKind: 'tekion-consumer-link',
  }),
  rooftop({
    id: 'infiniti',
    tenantSlug: 'infiniti-of-chicago',
    publicName: 'INFINITI of Chicago',
    sideOfTown: 'Near South Side',
    address: chicago('2711 S State St', '60616'),
    sales: '312-476-8000',
    service: '312-476-8020',
    parts: '312-476-8025',
    brands: ['INFINITI'],
    websiteUrl: 'https://www.infinitichicago.com/',
    scheduleServiceUrl: `${TEKION_CONSUMER}jdcauto_249_7723`,
    schedulerKind: 'tekion-consumer-link',
  }),
  // SOUTH Side CDJR store. Not the same dealership as `cdjr-north` below.
  rooftop({
    id: 'cdjr-south',
    tenantSlug: 'dial-cdjr-of-chicago',
    groupSide: 'south',
    groupAliases: ['dial jeep', 'dial cdjr', 'dial chrysler dodge jeep ram'],
    publicName: 'Dial Chrysler Dodge Jeep Ram of Chicago',
    sideOfTown: 'South Side',
    address: chicago('7340 S Western Ave', '60636'),
    sales: '773-476-7800',
    service: '773-476-7802',
    parts: '773-476-7729',
    brands: ['Ram', 'Dodge', 'Chrysler', 'Jeep'],
    websiteUrl: 'https://www.dialjeep.com/',
    scheduleServiceUrl: `${TEKION_CONSUMER}jdcauto_249_7276`,
    schedulerKind: 'tekion-consumer-link',
  }),
  // NORTH Side Jeep store. Not the same dealership as `cdjr-south` above.
  rooftop({
    id: 'cdjr-north',
    tenantSlug: 'jeep-of-chicago',
    groupSide: 'north',
    publicName: 'Jeep of Chicago',
    sideOfTown: 'North Side',
    address: chicago('5950 N Western Ave', '60659'),
    sales: '773-334-3400',
    service: '773-828-1050',
    parts: '773-828-9952',
    brands: ['Jeep', 'Ram', 'Dodge', 'Chrysler'],
    websiteUrl: 'https://www.jeepofchicago.com/',
    scheduleServiceUrl: 'https://www.jeepofchicago.com/scheduleservice',
    schedulerKind: 'rooftop-site-page',
  }),
];

export function formatDialAddress(a: DialAddress): string {
  return `${a.street}, ${a.city}, ${a.region} ${a.postalCode}`;
}

/** Log-safe description of a rooftop's scheduler handoff: host and kind only, never the URL. */
export function describeSchedulerLink(r: DialRooftopIdentity): string {
  const host = new URL(r.scheduleServiceUrl.value).host;
  return `${r.schedulerKind} @ ${host} (query string withheld)`;
}
