import type { GroupMember, RooftopSide } from './group-routing.types';

export type StoreChoice =
  /** "either", "both", "any store" — show every rooftop, labelled. */
  | { kind: 'either' }
  /** Exactly one rooftop was named. */
  | { kind: 'store'; tenantId: string; by: 'side' | 'name' }
  /** A store was named, but the words fit more than one rooftop — never guessed. */
  | { kind: 'ambiguous'; tenantIds: string[] };

const NAME_NOISE = new Set(['of', 'the', 'and', 'chicago', 'store', 'side']);

export function norm(s: string): string {
  return ` ${s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

const EITHER_RE =
  / (either|both|any store|all stores|all of them|any of them|every store|no preference|doesn t matter|does not matter|cualquiera|cualquier tienda|cualquier agencia|ambos|ambas|las dos|los dos|da igual|no importa|todas las tiendas|todas las agencias) /;

export function sideIn(message: string): RooftopSide | 'both' | null {
  const m = norm(message);
  const north = / (north|northside|norte) /.test(m);
  const south = / (south|southside|sur) /.test(m);
  if (north && south) return 'both';
  return north ? 'north' : south ? 'south' : null;
}

function nameTokens(name: string): string[] {
  return norm(name)
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
}

/** Words that say the customer is talking about a store, not a vehicle. */
const STORE_WORD_RE =
  / (store|stores|dealership|dealer|location|lot|showroom|tienda|agencia|sucursal|concesionario|side|lado) /;

/**
 * What store, if any, the customer named. Deliberately conservative:
 *  - a side ("North Side", "norte") picks the rooftop on that side only if exactly one has it;
 *  - a full public name or a configured alias picks that rooftop;
 *  - brand words alone ("the Jeep store") pick a rooftop only when one rooftop fits; when the
 *    fitting rooftop has a side and neither the side nor its full name was said, the answer is
 *    `ambiguous` across every sided rooftop — the two Jeep stores are never merged or guessed.
 *
 * `expectingStore` is true when the assistant just asked "which store?" — then a bare brand
 * word ("Nissan") counts. Otherwise store wording is required, so "show me a Nissan Rogue" is
 * never read as a store choice.
 */
export function parseStoreChoice(
  message: string,
  members: readonly GroupMember[],
  opts: { expectingStore: boolean },
): StoreChoice | null {
  const m = norm(message);
  if (m.trim().length === 0 || m.length > 400) return null;

  // 1. Full public name or alias — unambiguous by construction (longest match wins).
  const named = members
    .flatMap((mb) => [mb.name, ...mb.aliases].map((n) => ({ mb, n: norm(n) })))
    .filter((x) => x.n.trim().length >= 3 && m.includes(x.n))
    .sort((a, b) => b.n.length - a.n.length);
  if (named.length) {
    const best = named.filter((x) => x.n.length === named[0].n.length);
    const ids = [...new Set(best.map((x) => x.mb.tenantId))];
    if (ids.length === 1) {
      // A full name that is also part of a longer sided name still needs no side.
      return { kind: 'store', tenantId: ids[0], by: 'name' };
    }
  }

  // 2. A stated side.
  const side = sideIn(message);
  if (side === 'both') return { kind: 'either' };
  if (side) {
    const onSide = members.filter((mb) => mb.side === side);
    if (onSide.length === 1)
      return { kind: 'store', tenantId: onSide[0].tenantId, by: 'side' };
    if (onSide.length > 1)
      return { kind: 'ambiguous', tenantIds: onSide.map((x) => x.tenantId) };
    return null;
  }

  if (EITHER_RE.test(m)) return { kind: 'either' };

  // 3. Brand / name words.
  if (!opts.expectingStore && !STORE_WORD_RE.test(m)) return null;
  const words = new Set(m.trim().split(' '));
  const all = new Set(members.flatMap((mb) => nameTokens(mb.name)));
  const said = [...words].filter((w) => all.has(w));
  if (!said.length) return null;
  const fits = members.filter((mb) => {
    const t = new Set(nameTokens(mb.name));
    return said.every((w) => t.has(w));
  });
  if (!fits.length) return null;
  const sided = members.filter((mb) => mb.side);
  if (fits.some((f) => f.side) && sided.length > 1)
    return { kind: 'ambiguous', tenantIds: sided.map((x) => x.tenantId) };
  if (fits.length === 1)
    return { kind: 'store', tenantId: fits[0].tenantId, by: 'name' };
  return { kind: 'ambiguous', tenantIds: fits.map((x) => x.tenantId) };
}

/**
 * The search preference a choice implies: the rooftops to leave out. Choosing a side leaves
 * out the other sided rooftops only (the Chevrolet store is unaffected); choosing one of the
 * stores that were offered leaves out the other offered ones.
 */
export function preferenceFor(
  choice: StoreChoice,
  members: readonly GroupMember[],
  offered: readonly string[] | null,
): { exclude: string[]; either?: boolean } | null {
  if (choice.kind === 'either') return { exclude: [], either: true };
  if (choice.kind !== 'store') return null;
  // Outside an offered set, only the sided rooftops exclude one another. Naming an un-sided
  // store ("the Chevy store") must not hide every other brand for the rest of the chat.
  const chosen = members.find((m) => m.tenantId === choice.tenantId);
  const pool =
    offered && offered.includes(choice.tenantId)
      ? offered
      : chosen?.side
        ? members.filter((m) => m.side).map((m) => m.tenantId)
        : [choice.tenantId];
  return { exclude: pool.filter((id) => id !== choice.tenantId) };
}
