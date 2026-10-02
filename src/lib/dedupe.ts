// Dédoublonnage « au morceau » : un même titre existe souvent sous plusieurs ids Spotify
// (version single et version album, remaster, réédition deluxe…). On le reconnaît à son ISRC
// ou à son titre débarrassé des mentions d'édition, avec le même artiste principal.
import { normalizeName } from './enrich';

export interface SongRef {
  name: string;
  /** Artiste principal. */
  artist: string;
  isrc?: string;
}

// Mentions qui désignent une autre interprétation : la version reste un morceau distinct.
const DISTINCT = /\b(live|remix|rmx|mix|acoustic|acoustique|unplugged|instrumental|demo|karaoke|a cappella|acapella|cover|reprise|rework|re ?recorded|orchestral|symphonic|session|sped up|slowed|nightcore|piano|extended|dub|vip|bootleg|taylor s version)\b/;
// Mentions d'édition, sans effet sur le morceau.
const NOISE = /\b(remaster(ed)?|deluxe|expanded|anniversary|edition|version|mono|stereo|single|album|radio|edit|original|bonus|explicit|clean|feat|ft|featuring|with|from|bande originale|soundtrack|ost|\d{4})\b/;

/** Garde une mention entre parenthèses ou après un tiret si elle change le morceau. */
function keepSegment(seg: string): boolean {
  const s = normalizeName(seg);
  if (!s) return false;
  if (/^original mix$/.test(s)) return false;
  if (DISTINCT.test(s)) return true;
  return !NOISE.test(s);
}

/** « Karma Police - Remastered 2017 » → « karma police » ; « Song (Live) » reste distinct. */
export function songTitle(name: string): string {
  const kept: string[] = [];
  let base = name.replace(/\s*[([]([^)\]]*)[)\]]/g, (_, seg: string) => {
    if (keepSegment(seg)) kept.push(seg);
    return ' ';
  });
  base = base.replace(/\s+[-–—]\s+(.*)$/, (_, seg: string) => {
    if (keepSegment(seg)) kept.push(seg);
    return '';
  });
  return normalizeName([base, ...kept].join(' ')) || normalizeName(name);
}

// Le calcul (expressions régulières) revient à chaque génération sur toute la bibliothèque : on le garde en cache.
const keyCache = new Map<string, string>();

export function songKey(name: string, artist: string): string {
  const id = `${artist}\u0000${name}`;
  let k = keyCache.get(id);
  if (k === undefined) {
    k = `${normalizeName(artist)}|${songTitle(name)}`;
    if (keyCache.size > 200_000) keyCache.clear();
    keyCache.set(id, k);
  }
  return k;
}

function keysOf(r: SongRef): string[] {
  const keys = [`s:${songKey(r.name, r.artist)}`];
  if (r.isrc) keys.push(`i:${r.isrc.toUpperCase()}`);
  return keys;
}

/**
 * Garde la première occurrence de chaque morceau, dans l'ordre donné (mettre la version préférée en premier).
 * `seen` permet d'écarter aussi ce qui est déjà présent ailleurs (ex. titres épinglés, playlist cible).
 */
export function dedupeSongs<T>(items: T[], ref: (t: T) => SongRef | undefined, seen = new SongSet()): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const it of items) {
    const r = ref(it);
    if (r && seen.has(r)) removed.push(it);
    else {
      if (r) seen.add(r);
      kept.push(it);
    }
  }
  return { kept, removed };
}

/** Ensemble de morceaux (par titre normalisé ou ISRC). */
export class SongSet {
  private keys = new Set<string>();
  has(r: SongRef): boolean {
    return keysOf(r).some((k) => this.keys.has(k));
  }
  add(r: SongRef): this {
    for (const k of keysOf(r)) this.keys.add(k);
    return this;
  }
}

/** Référence d'un titre de la bibliothèque. */
export const trackRef = (t: { name: string; artists: { name: string }[]; isrc?: string }): SongRef => ({
  name: t.name,
  artist: t.artists[0]?.name ?? '',
  isrc: t.isrc,
});

/** Retire les doublons d'une liste d'URIs : même URI, ou même morceau quand `lookup` le connaît. */
export function dedupeUris(uris: string[], lookup: (uri: string) => SongRef | undefined): string[] {
  const seenUris = new Set<string>();
  return dedupeSongs(
    uris.filter((u) => !seenUris.has(u) && seenUris.add(u)),
    lookup,
  ).kept;
}
