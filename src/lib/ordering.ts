import type { EnrichedTrack } from './indexer';
import type { AudioFeatures, SortMode } from './types';

// ---------- Aléatoire reproductible ----------

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Roue de Camelot (mix harmonique) ----------

export interface Camelot {
  n: number; // 1..12
  letter: 'A' | 'B'; // A = mineur, B = majeur
}

export function toCamelot(key: number, mode: number): Camelot | null {
  if (key < 0 || key > 11 || (mode !== 0 && mode !== 1)) return null;
  // Un mineur partage le numéro de son relatif majeur (3 demi-tons au-dessus).
  const pitch = mode === 1 ? key : (key + 3) % 12;
  return { n: ((pitch * 7 + 7) % 12) + 1, letter: mode === 1 ? 'B' : 'A' };
}

export const camelotLabel = (c: Camelot | null) => (c ? `${c.n}${c.letter}` : '—');

/** 1 = enchaînement parfait, 0 = dissonant. */
export function keyCompatibility(a: Camelot | null, b: Camelot | null): number {
  if (!a || !b) return 0.4;
  const d = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  if (d === 0) return a.letter === b.letter ? 1 : 0.85;
  if (d === 1 && a.letter === b.letter) return 0.9;
  if (d === 2 && a.letter === b.letter) return 0.5; // « energy boost »
  return 0;
}

/** Écart de tempo en tenant compte du half/double time (85 BPM ≈ 170 BPM). */
export function tempoDistance(a: number, b: number): number {
  if (!a || !b) return 0.5;
  const r = Math.max(a, b) / Math.min(a, b);
  const ratio = Math.min(r, Math.abs(r - 2) + 1);
  return Math.min(1, (ratio - 1) / 0.12);
}

export function transitionCost(a: AudioFeatures, b: AudioFeatures): number {
  return (
    (1 - keyCompatibility(toCamelot(a.key, a.mode), toCamelot(b.key, b.mode))) * 1.0 +
    tempoDistance(a.tempo, b.tempo) * 0.8 +
    Math.abs(a.energy - b.energy) * 0.6
  );
}

/**
 * Ordonne pour un enchaînement fluide : plus proche voisin glouton sur (tonalité, tempo, énergie),
 * départ sur le titre le plus calme. Les titres sans features sont ajoutés à la fin.
 */
export function harmonicOrder(tracks: EnrichedTrack[]): EnrichedTrack[] {
  const withF = tracks.filter((t) => t.features);
  const without = tracks.filter((t) => !t.features);
  if (withF.length < 3) return tracks;
  const remaining = [...withF].sort((a, b) => a.features!.energy - b.features!.energy);
  const out = [remaining.shift()!];
  while (remaining.length) {
    const last = out[out.length - 1].features!;
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      // Légère pression vers le haut en énergie pour que le set « monte ».
      const c = transitionCost(last, remaining[i].features!) - (remaining[i].features!.energy - last.energy) * 0.15;
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    }
    out.push(remaining.splice(best, 1)[0]);
  }
  return [...out, ...without];
}

/** Montée progressive jusqu'à un pic aux ~2/3, puis redescente. */
export function energyArc(tracks: EnrichedTrack[]): EnrichedTrack[] {
  const withF = tracks.filter((t) => t.features).sort((a, b) => a.features!.energy - b.features!.energy);
  const without = tracks.filter((t) => !t.features);
  const up: EnrichedTrack[] = [];
  const down: EnrichedTrack[] = [];
  withF.forEach((t, i) => (i % 3 === 2 ? down : up).push(t));
  return [...up, ...down.reverse(), ...without];
}

/**
 * Ordre de priorité pour choisir les titres à garder quand le filtre dépasse la limite :
 * aléatoire, ou par affinité avec un peu d'aléa. Pas d'espacement des artistes ici (coûteux sur
 * toute la bibliothèque, et c'est l'ordre final qui compte pour l'écoute).
 */
export function priorityOrder(tracks: EnrichedTrack[], byAffinity: boolean, seed: number): EnrichedTrack[] {
  const rand = mulberry32(seed);
  if (!byAffinity) return shuffle(tracks, rand);
  return tracks.map((t) => ({ t, k: t.affinity + rand() * 0.5 })).sort((a, b) => b.k - a.k).map((x) => x.t);
}

/** Évite deux titres consécutifs du même artiste quand c'est possible. */
export function spreadArtists(tracks: EnrichedTrack[]): EnrichedTrack[] {
  const pool = [...tracks];
  const out: EnrichedTrack[] = [];
  while (pool.length) {
    const prev = out[out.length - 1]?.track.artists[0]?.id;
    const idx = pool.findIndex((t) => t.track.artists[0]?.id !== prev);
    out.push(pool.splice(idx === -1 ? 0 : idx, 1)[0]);
  }
  return out;
}

const byDate = (s?: string) => (s ? Date.parse(s) : 0);

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const mainArtist = (t: EnrichedTrack) => t.track.artists[0]?.name ?? '';

/** Discographie : albums du plus ancien au plus récent, titres regroupés par album. */
const byDiscography = (a: EnrichedTrack, b: EnrichedTrack) =>
  (a.track.album.releaseDate || '9999').localeCompare(b.track.album.releaseDate || '9999') ||
  collator.compare(a.track.album.name, b.track.album.name) ||
  collator.compare(a.track.name, b.track.name);

/** Blocs par artiste (artistes dans un ordre aléatoire), discographie dans chaque bloc. */
export function artistBlocks(tracks: EnrichedTrack[], rand: () => number): EnrichedTrack[] {
  const groups = new Map<string, EnrichedTrack[]>();
  for (const t of tracks) {
    const k = t.track.artists[0]?.id ?? '';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return shuffle([...groups.values()], rand).flatMap((g) => g.sort(byDiscography));
}

export function sortTracks(tracks: EnrichedTrack[], mode: SortMode, seed: number): EnrichedTrack[] {
  const rand = mulberry32(seed);
  const features = (t: EnrichedTrack) => t.features;
  switch (mode) {
    case 'shuffle':
      return spreadArtists(shuffle(tracks, rand));
    case 'affinity':
      // Un peu d'aléa pour que deux générations ne soient pas identiques à égalité.
      return spreadArtists(priorityOrder(tracks, true, seed));
    case 'added_desc':
      return [...tracks].sort((a, b) => byDate(b.track.likedAt) - byDate(a.track.likedAt));
    case 'release_asc':
      return [...tracks].sort((a, b) => (a.track.album.releaseDate || '9999').localeCompare(b.track.album.releaseDate || '9999'));
    case 'release_desc':
      return [...tracks].sort((a, b) => (b.track.album.releaseDate || '').localeCompare(a.track.album.releaseDate || ''));
    case 'energy_asc':
      return [...tracks].sort((a, b) => (features(a)?.energy ?? 2) - (features(b)?.energy ?? 2));
    case 'tempo_asc':
      return [...tracks].sort((a, b) => (features(a)?.tempo ?? 999) - (features(b)?.tempo ?? 999));
    case 'energy_arc':
      return energyArc(tracks);
    case 'harmonic':
      return harmonicOrder(tracks);
    case 'artist':
      return [...tracks].sort((a, b) => collator.compare(mainArtist(a), mainArtist(b)) || byDiscography(a, b));
    case 'artist_blocks':
      return artistBlocks(tracks, rand);
    case 'album':
      return [...tracks].sort(
        (a, b) => collator.compare(a.track.album.name, b.track.album.name) || collator.compare(mainArtist(a), mainArtist(b)) || collator.compare(a.track.name, b.track.name),
      );
    case 'title':
      return [...tracks].sort((a, b) => collator.compare(a.track.name, b.track.name) || collator.compare(mainArtist(a), mainArtist(b)));
    case 'plays_desc':
      return [...tracks].sort((a, b) => (b.listen?.plays ?? 0) - (a.listen?.plays ?? 0) || b.affinity - a.affinity);
    case 'energy_desc':
      return [...tracks].sort((a, b) => (features(b)?.energy ?? -1) - (features(a)?.energy ?? -1));
    case 'tempo_desc':
      return [...tracks].sort((a, b) => (features(b)?.tempo ?? -1) - (features(a)?.tempo ?? -1));
  }
}

/** Tris qui choisissent eux-mêmes les titres à garder quand le filtre dépasse la limite. */
export const SELECTING_SORTS: SortMode[] = ['added_desc', 'release_asc', 'release_desc', 'plays_desc'];

export const SORT_LABELS: Record<SortMode, string> = {
  shuffle: 'Aléatoire (artistes espacés)',
  affinity: 'Mes favoris d’abord',
  added_desc: 'Ajouts les plus récents',
  release_asc: 'Chronologique (ancien → récent)',
  release_desc: 'Chronologique (récent → ancien)',
  energy_asc: 'Énergie croissante',
  energy_arc: 'Arc d’énergie (montée, pic, descente)',
  tempo_asc: 'Tempo croissant',
  harmonic: 'Mix DJ (tonalité + tempo)',
  artist: 'Par artiste (A → Z)',
  artist_blocks: 'Par artiste (blocs dans le désordre)',
  album: 'Par album (A → Z)',
  title: 'Par titre (A → Z)',
  plays_desc: 'Les plus écoutés d’abord',
  energy_desc: 'Énergie décroissante',
  tempo_desc: 'Tempo décroissant',
};

export const SORT_GROUPS: { label: string; modes: SortMode[] }[] = [
  { label: 'Général', modes: ['shuffle', 'affinity', 'plays_desc'] },
  { label: 'Alphabétique', modes: ['artist', 'artist_blocks', 'album', 'title'] },
  { label: 'Chronologique', modes: ['added_desc', 'release_asc', 'release_desc'] },
  { label: 'Son', modes: ['energy_asc', 'energy_desc', 'energy_arc', 'tempo_asc', 'tempo_desc', 'harmonic'] },
];
