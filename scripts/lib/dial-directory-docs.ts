/**
 * Customer-visible "store directory" knowledge text built from the identity constant.
 *
 * Chunking is fixed and deterministic (one chunk per rooftop document; the group document is
 * one overview chunk plus one chunk per store) so the bootstrap can upsert chunks by index
 * and never has to delete one. Every chunk is self-contained: it names its own store, so a
 * retrieved chunk can never be read as belonging to another rooftop.
 *
 * The scheduler URL is never written here — three of them carry an access token.
 */
import {
  DIAL_GROUP,
  DIAL_ROOFTOPS,
  formatDialAddress,
  type DialRooftopIdentity,
} from './dial-store-identity';

export const HOURS_NOT_ON_FILE =
  'Store hours are not on file here; please confirm with the store.';
export const SCHEDULING_LINE =
  'Service scheduling link: available through the Schedule Service button/handoff.';

export type DirectoryDoc = {
  title: string;
  /** No tokenized URL — safe as KnowledgeDocument.canonicalUrl. */
  canonicalUrl: string | null;
  chunks: string[];
  /** KnowledgeDocument.content: the chunks joined by a blank line. */
  content: string;
};

const CDJR_IDS = ['cdjr-south', 'cdjr-north'];

function otherCdjrNote(r: DialRooftopIdentity): string | null {
  if (!CDJR_IDS.includes(r.sourceRecordId)) return null;
  const other = DIAL_ROOFTOPS.find(
    (x) =>
      CDJR_IDS.includes(x.sourceRecordId) &&
      x.sourceRecordId !== r.sourceRecordId,
  );
  if (!other) return null;
  return (
    `Not the same store as ${other.publicName.value} ` +
    `(${other.sideOfTown.value}, ${other.address.value.street}), ` +
    'which has its own address and phone numbers.'
  );
}

function storeLines(r: DialRooftopIdentity): string[] {
  return [
    `Store name: ${r.publicName.value} (a ${DIAL_GROUP.name.value} store)`,
    `Where we are located: ${r.sideOfTown.value} of Chicago`,
    `Street address: ${formatDialAddress(r.address.value)}`,
    `Sales phone number: ${r.phones.sales.value}`,
    `Service phone number: ${r.phones.service.value}`,
    `Parts phone number: ${r.phones.parts.value}`,
    `Brands sold and serviced: ${r.brands.value.join(', ')}`,
    `Website: ${r.websiteUrl.value}`,
  ];
}

export function buildRooftopDirectoryDoc(r: DialRooftopIdentity): DirectoryDoc {
  const title = `${r.publicName.value} — store directory`;
  const note = otherCdjrNote(r);
  const chunk = [
    title,
    ...storeLines(r),
    SCHEDULING_LINE,
    HOURS_NOT_ON_FILE,
    ...(note ? [note] : []),
  ].join('\n');
  return {
    title,
    canonicalUrl: r.websiteUrl.value,
    chunks: [chunk],
    content: chunk,
  };
}

export function buildGroupDirectoryDoc(): DirectoryDoc {
  const title = `${DIAL_GROUP.name.value} — store directory`;
  const north = DIAL_ROOFTOPS.find((r) => r.sourceRecordId === 'cdjr-north')!;
  const south = DIAL_ROOFTOPS.find((r) => r.sourceRecordId === 'cdjr-south')!;
  const overview = [
    title,
    `${DIAL_GROUP.name.value} has ${DIAL_ROOFTOPS.length} stores in the group, all in Chicago, IL:`,
    ...DIAL_ROOFTOPS.map(
      (r, i) =>
        `${i + 1}. ${r.publicName.value} (${r.brands.value.join(', ')}) — ${r.sideOfTown.value}, ${r.address.value.street}`,
    ),
    `North/South note: ${north.publicName.value} (${north.sideOfTown.value}) and ` +
      `${south.publicName.value} (${south.sideOfTown.value}) are two different stores. ` +
      'Never mix them.',
    HOURS_NOT_ON_FILE,
  ].join('\n');
  const perStore = DIAL_ROOFTOPS.map((r) => {
    const note = otherCdjrNote(r);
    return [
      `${DIAL_GROUP.name.value} store: ${r.publicName.value}`,
      ...storeLines(r),
      SCHEDULING_LINE,
      HOURS_NOT_ON_FILE,
      ...(note ? [note] : []),
    ].join('\n');
  });
  const chunks = [overview, ...perStore];
  return { title, canonicalUrl: null, chunks, content: chunks.join('\n\n') };
}
