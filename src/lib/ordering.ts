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

export function sortTracks(tracks: EnrichedTrack[], mode: SortMode, seed: number): EnrichedTrack[] {
  const rand = mulberry32(seed);
  const features = (t: EnrichedTrack) => t.features;
  switch (mode) {
    case 'shuffle':
      return spreadArtists(shuffle(tracks, rand));
    case 'affinity':
      // Un peu d'aléa pour que deux générations ne soient pas identiques à égalité.
      return spreadArtists(
        tracks.map((t) => ({ t, k: t.affinity + rand() * 0.5 })).sort((a, b) => b.k - a.k).map((x) => x.t),
      );
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
  }
}

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
};
