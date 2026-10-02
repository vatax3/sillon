// Social sans serveur (et compatible avec la limite de 5 utilisateurs du mode dev) :
// chacun exporte sa « carte de goûts » (un petit JSON), l'échange, et l'app compare en local.
import { songKey } from './dedupe';
import { normalizeName } from './enrich';
import { FAMILY_BY_ID } from './genres';
import type { HistoryStore } from './history';
import { isStream, rangeOf } from './historyStats';
import type { LibraryIndex } from './indexer';
import type { Library } from './types';

export interface TasteCard {
  app: 'sillon';
  v: 1;
  name: string;
  createdAt: string;
  families: Record<string, number>;
  decades: Record<string, number>;
  genres: string[];
  profile?: { energy: number; valence: number; danceability: number; acousticness: number; instrumentalness: number };
  artists: { name: string; w: number }[];
  tracks: { uri: string; name: string; artist: string; w: number }[];
  stats: { tracks: number; artists: number; listeningHours?: number };
}

const shares = (m: Map<string, number>): Record<string, number> => {
  const total = [...m.values()].reduce((s, x) => s + x, 0) || 1;
  return Object.fromEntries([...m.entries()].map(([k, v]) => [k, v / total]));
};

const normalizeWeights = <T extends { w: number }>(list: T[]): T[] => {
  const max = Math.max(...list.map((x) => x.w), 1e-9);
  return list.map((x) => ({ ...x, w: Math.round((x.w / max) * 1000) / 1000 }));
};

export function buildTasteCard(lib: Library, index: LibraryIndex, history: HistoryStore | null): TasteCard {
  const fam = new Map<string, number>();
  const dec = new Map<string, number>();
  const gen = new Map<string, number>();
  for (const t of index.tracks) {
    if (t.families[0]) fam.set(t.families[0], (fam.get(t.families[0]) ?? 0) + 1);
    if (t.year) {
      const d = String(Math.floor(t.year / 10) * 10);
      dec.set(d, (dec.get(d) ?? 0) + 1);
    }
    for (const g of t.genres.slice(0, 2)) gen.set(g, (gen.get(g) ?? 0) + 1);
  }

  // Artistes : présence en bibliothèque + tops + temps d'écoute sur 12 mois.
  const artistW = new Map<string, { name: string; w: number }>();
  const addArtist = (name: string, w: number) => {
    const k = normalizeName(name);
    const e = artistW.get(k) ?? { name, w: 0 };
    e.w += w;
    artistW.set(k, e);
  };
  for (const [id, n] of index.artistCounts) if (lib.artists[id]) addArtist(lib.artists[id].name, n);
  for (const a of Object.values(lib.artists)) {
    for (const rank of Object.values(a.topRanks)) addArtist(a.name, (51 - rank!) / 5);
  }
  // Titres : affinité bibliothèque + écoutes des 12 derniers mois.
  const trackW = new Map<string, { uri: string; name: string; artist: string; w: number }>();
  for (const t of index.tracks) {
    trackW.set(t.track.id, { uri: t.track.uri, name: t.track.name, artist: t.track.artists[0]?.name ?? '', w: t.affinity });
  }
  let listeningHours: number | undefined;
  if (history && history.ts.length) {
    const [start, end] = rangeOf(history, { from: Date.now() - 365 * 86_400_000, to: Infinity });
    let ms = 0;
    for (let i = start; i < end; i++) {
      ms += history.ms[i];
      if (!isStream(history, i)) continue;
      const ht = history.tracks[history.track[i]];
      addArtist(ht.artist, 0.05);
      if (!ht.key.startsWith('n:')) {
        const e = trackW.get(ht.key) ?? { uri: `spotify:track:${ht.key}`, name: ht.name, artist: ht.artist, w: 0 };
        e.w += 0.3;
        trackW.set(ht.key, e);
      }
    }
    listeningHours = Math.round(ms / 3_600_000);
  }

  const withF = index.tracks.filter((t) => t.features);
  const avg = (k: 'energy' | 'valence' | 'danceability' | 'acousticness' | 'instrumentalness') =>
    Math.round((withF.reduce((s, t) => s + t.features![k], 0) / withF.length) * 1000) / 1000;

  return {
    app: 'sillon',
    v: 1,
    name: lib.user.name,
    createdAt: new Date().toISOString(),
    families: shares(fam),
    decades: shares(dec),
    genres: [...gen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([g]) => g),
    profile: withF.length
      ? { energy: avg('energy'), valence: avg('valence'), danceability: avg('danceability'), acousticness: avg('acousticness'), instrumentalness: avg('instrumentalness') }
      : undefined,
    artists: normalizeWeights([...artistW.values()].sort((a, b) => b.w - a.w).slice(0, 80)),
    tracks: normalizeWeights([...trackW.values()].sort((a, b) => b.w - a.w).slice(0, 200)),
    stats: { tracks: index.tracks.length, artists: index.artistCounts.size, listeningHours },
  };
}

export function parseTasteCard(json: unknown): TasteCard {
  const c = json as Partial<TasteCard>;
  if (c?.app !== 'sillon' || c.v !== 1 || !Array.isArray(c.artists) || !Array.isArray(c.tracks)) {
    throw new Error('Ce fichier n’est pas une carte de goûts Sillon.');
  }
  return c as TasteCard;
}

// ---------- Compatibilité ----------

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Jaccard pondéré (Σmin / Σmax) sur des listes {clé, poids}. */
function weightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  let min = 0;
  let max = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return max ? min / max : 0;
}

export interface Compatibility {
  score: number;
  parts: { label: string; value: number }[];
  sharedArtists: string[];
  /** Ses artistes phares que tu ne connais pas (ou peu). */
  toDiscover: string[];
  /** Tes artistes phares qu'il/elle ne connaît pas. */
  toShare: string[];
  sharedTracks: number;
}

type CardTrack = { uri: string; name: string; artist: string };

/** Ensemble de titres : même URI, ou même morceau sous un autre id (version single chez l'un, album chez l'autre). */
function trackSet(list: CardTrack[]) {
  const keys = new Set<string>();
  const keysOf = (t: CardTrack) => [t.uri, songKey(t.name, t.artist)];
  const set = {
    has: (t: CardTrack) => keysOf(t).some((k) => keys.has(k)),
    add: (t: CardTrack) => keysOf(t).forEach((k) => keys.add(k)),
  };
  list.forEach(set.add);
  return set;
}

export function compatibility(me: TasteCard, them: TasteCard): Compatibility {
  const am = new Map(me.artists.map((a) => [normalizeName(a.name), a.w]));
  const at = new Map(them.artists.map((a) => [normalizeName(a.name), a.w]));
  const tm = trackSet(me.tracks);
  const sharedTracks = them.tracks.filter((t) => tm.has(t)).length;

  const parts: { label: string; value: number; weight: number }[] = [
    { label: 'Genres', value: cosine(me.families, them.families), weight: 0.35 },
    // La racine adoucit un indice naturellement bas (deux bibliothèques partagent rarement >30 % d'artistes).
    { label: 'Artistes', value: Math.sqrt(weightedJaccard(am, at)), weight: 0.25 },
    { label: 'Époques', value: cosine(me.decades, them.decades), weight: 0.15 },
    { label: 'Titres en commun', value: Math.min(1, Math.sqrt(sharedTracks / Math.max(1, Math.min(me.tracks.length, them.tracks.length)) * 4)), weight: 0.1 },
  ];
  if (me.profile && them.profile) {
    const keys = Object.keys(me.profile) as (keyof NonNullable<TasteCard['profile']>)[];
    const diff = keys.reduce((s, k) => s + Math.abs(me.profile![k] - them.profile![k]), 0) / keys.length;
    parts.push({ label: 'Son', value: Math.max(0, 1 - diff * 3), weight: 0.15 });
  }
  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round((parts.reduce((s, p) => s + p.value * p.weight, 0) / totalW) * 100);

  const nameOf = new Map([...me.artists, ...them.artists].map((a) => [normalizeName(a.name), a.name]));
  const shared = [...am.keys()]
    .filter((k) => at.has(k))
    .sort((x, y) => Math.min(at.get(y)!, am.get(y)!) - Math.min(at.get(x)!, am.get(x)!));
  return {
    score,
    parts: parts.map(({ label, value }) => ({ label, value })),
    sharedArtists: shared.slice(0, 15).map((k) => nameOf.get(k)!),
    toDiscover: them.artists.filter((a) => !am.has(normalizeName(a.name))).slice(0, 12).map((a) => a.name),
    toShare: me.artists.filter((a) => !at.has(normalizeName(a.name))).slice(0, 12).map((a) => a.name),
    sharedTracks,
  };
}

// ---------- Blend ----------

export interface BlendTrack {
  uri: string;
  name: string;
  artist: string;
  from: 'both' | 'me' | 'them';
}

/**
 * Un tiers de titres communs, puis alternance de vos favoris respectifs,
 * sans doublon et avec au plus 2 titres par artiste.
 */
export function blend(me: TasteCard, them: TasteCard, size = 50): BlendTrack[] {
  const themSongs = trackSet(them.tracks);
  const shared = me.tracks.filter((t) => themSongs.has(t));
  const out: BlendTrack[] = [];
  const used = trackSet([]);
  const perArtist = new Map<string, number>();
  const take = (t: CardTrack, from: BlendTrack['from']) => {
    const a = normalizeName(t.artist);
    if (used.has(t) || (perArtist.get(a) ?? 0) >= 2) return false;
    used.add(t);
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    out.push({ uri: t.uri, name: t.name, artist: t.artist, from });
    return true;
  };
  for (const t of shared) {
    if (out.length >= Math.ceil(size / 3)) break;
    take(t, 'both');
  }
  const mine = me.tracks.filter((t) => !themSongs.has(t));
  const theirs = them.tracks.filter((t) => !used.has(t));
  let i = 0;
  let j = 0;
  while (out.length < size && (i < mine.length || j < theirs.length)) {
    while (i < mine.length && !take(mine[i++], 'me'));
    if (out.length >= size) break;
    while (j < theirs.length && !take(theirs[j++], 'them'));
  }
  // Mélange léger pour que les titres communs ne soient pas tous au début.
  return out
    .map((t, k) => ({ t, k: k + (t.from === 'both' ? k * 2 : 0) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
}

export const familyLabel = (id: string) => FAMILY_BY_ID[id]?.label ?? id;
