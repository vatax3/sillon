import { defaultRule, generate } from './generator';
import { FAMILY_BY_ID } from './genres';
import type { EnrichedTrack, LibraryIndex } from './indexer';
import { MOOD_BY_ID, MOODS } from './moods';
import { mulberry32 } from './ordering';
import type { Mood, Rule } from './types';

export type SuggestionKind = 'ambiance' | 'mood' | 'genre' | 'era' | 'rediscover' | 'artist';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  subtitle: string;
  rule: Rule;
  /** Pour les ambiances issues du clustering : sélection explicite de titres. */
  trackIds?: string[];
  size: number;
}

export const KIND_LABELS: Record<SuggestionKind, string> = {
  ambiance: 'Ambiances détectées',
  mood: 'Moods',
  genre: 'Genres',
  era: 'Époques',
  rediscover: 'Redécouvertes',
  artist: 'Artistes',
};

const MIN_SIZE = 15;

const rule = (patch: Partial<Rule>, seed: number): Rule => ({ ...defaultRule(), seed, ...patch });

function count<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

// ---------- K-means sur (features audio + famille) ----------

function vectorize(t: EnrichedTrack, families: string[]): number[] {
  const f = t.features!;
  const v = [
    f.energy,
    f.valence,
    f.danceability,
    f.acousticness,
    f.instrumentalness,
    Math.min(1, Math.max(0, (f.tempo - 60) / 120)),
    Math.min(1, f.speechiness * 2),
  ];
  // La famille pèse moins que le son, mais évite de mélanger rap et jazz à énergie égale.
  for (const fam of families) v.push(t.families[0] === fam ? 0.45 : 0);
  return v;
}

const dist2 = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);

export function kmeans(points: number[][], k: number, seed: number, iterations = 40): number[] {
  const rand = mulberry32(seed);
  // k-means++ pour une initialisation stable.
  const centroids: number[][] = [[...points[Math.floor(rand() * points.length)]]];
  while (centroids.length < k) {
    const d = points.map((p) => Math.min(...centroids.map((c) => dist2(p, c))));
    const total = d.reduce((s, x) => s + x, 0);
    let r = rand() * total;
    let idx = 0;
    while (idx < d.length - 1 && (r -= d[idx]) > 0) idx++;
    centroids.push([...points[idx]]);
  }
  const assign = new Array(points.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    points.forEach((p, i) => {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, j) => {
        const d = dist2(p, c);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    });
    centroids.forEach((c, j) => {
      const members = points.filter((_, i) => assign[i] === j);
      if (!members.length) return;
      for (let d = 0; d < c.length; d++) c[d] = members.reduce((s, p) => s + p[d], 0) / members.length;
    });
    if (!changed) break;
  }
  return assign;
}

function describeCluster(members: EnrichedTrack[]): { title: string; subtitle: string } {
  const avg = (k: 'energy' | 'valence' | 'danceability' | 'acousticness' | 'tempo') =>
    members.reduce((s, t) => s + t.features![k], 0) / members.length;
  const fam = [...count(members.map((t) => t.families[0]).filter(Boolean)).entries()].sort((a, b) => b[1] - a[1])[0];
  const mood = [...count(members.flatMap((t) => t.moods.slice(0, 1))).entries()].sort((a, b) => b[1] - a[1])[0];
  const famLabel = fam && fam[1] / members.length >= 0.35 ? FAMILY_BY_ID[fam[0]]?.label : 'Éclectique';
  const moodLabel = mood ? `${MOOD_BY_ID[mood[0] as Mood].emoji} ${MOOD_BY_ID[mood[0] as Mood].label}` : '';
  const years = members.map((t) => t.year).filter((y): y is number => !!y).sort((a, b) => a - b);
  const medianYear = years[Math.floor(years.length / 2)];
  const bits = [
    `énergie ${Math.round(avg('energy') * 100)}%`,
    `positivité ${Math.round(avg('valence') * 100)}%`,
    `${Math.round(avg('tempo'))} BPM`,
    medianYear ? `autour de ${medianYear}` : '',
  ].filter(Boolean);
  return { title: [famLabel, moodLabel].filter(Boolean).join(' · '), subtitle: bits.join(' · ') };
}

function ambianceSuggestions(index: LibraryIndex, seed: number): Suggestion[] {
  const pool = index.tracks.filter((t) => t.features);
  if (pool.length < 60) return [];
  const families = [...count(pool.map((t) => t.families[0]).filter(Boolean)).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([f]) => f);
  // ~6 ambiances pour 400 titres, 12 au-delà de ~1500 : assez fin pour être parlant.
  const k = Math.max(4, Math.min(12, Math.round(Math.sqrt(pool.length / 10))));
  const assign = kmeans(pool.map((t) => vectorize(t, families)), k, seed);
  const groups = Array.from({ length: k }, (_, j) => pool.filter((_, i) => assign[i] === j)).filter(
    (g) => g.length >= MIN_SIZE,
  );
  const seen = new Map<string, number>();
  return groups
    .sort((a, b) => b.length - a.length)
    .map((members, j) => {
      const { title, subtitle } = describeCluster(members);
      const n = (seen.get(title) ?? 0) + 1;
      seen.set(title, n);
      return {
        id: `ambiance-${j}`,
        kind: 'ambiance' as const,
        title: n > 1 ? `${title} (${n})` : title,
        subtitle: `${members.length} titres · ${subtitle}`,
        rule: rule({ sort: 'harmonic', maxTracks: 60, maxPerArtist: 4 }, seed + j),
        trackIds: members.map((t) => t.track.id),
        size: members.length,
      };
    });
}

/** Génère les suggestions de playlists à partir de la bibliothèque indexée. */
export function buildSuggestions(index: LibraryIndex, artistName: (id: string) => string, seed = 42): Suggestion[] {
  const out: Suggestion[] = [];
  const push = (s: Omit<Suggestion, 'size'>) => {
    const size = s.trackIds?.length ?? generate(index, { ...s.rule, maxTracks: 10_000, maxPerArtist: 0 }).matchedCount;
    if (size >= MIN_SIZE) out.push({ ...s, size });
  };

  out.push(...ambianceSuggestions(index, seed));

  for (const m of MOODS) {
    push({
      id: `mood-${m.id}`,
      kind: 'mood',
      title: `${m.emoji} ${m.label}`,
      subtitle: m.hint,
      rule: rule({ moods: [m.id], sort: m.id === 'party' || m.id === 'energy' ? 'harmonic' : 'shuffle' }, seed),
    });
  }

  const famCounts = [...count(index.tracks.flatMap((t) => t.families.slice(0, 1))).entries()].sort((a, b) => b[1] - a[1]);
  for (const [fam] of famCounts.slice(0, 10)) {
    push({
      id: `genre-${fam}`,
      kind: 'genre',
      title: FAMILY_BY_ID[fam]?.label ?? fam,
      subtitle: 'le meilleur de ta bibliothèque dans ce style',
      rule: rule({ families: [fam], sort: 'affinity' }, seed),
    });
  }

  const decades = [...count(index.tracks.map((t) => (t.year ? Math.floor(t.year / 10) * 10 : 0)).filter(Boolean)).entries()]
    .sort((a, b) => a[0] - b[0]);
  for (const [d] of decades) {
    push({
      id: `era-${d}`,
      kind: 'era',
      title: `Années ${d < 2000 ? String(d).slice(2) : d}`,
      subtitle: `tes titres sortis entre ${d} et ${d + 9}`,
      rule: rule({ yearMin: d, yearMax: d + 9, sort: 'shuffle' }, seed),
    });
  }

  push({
    id: 'rediscover-forgotten',
    kind: 'rediscover',
    title: '💎 Pépites oubliées',
    subtitle: 'likés il y a plus d’un an, absents de tes tops et écoutes récentes',
    rule: rule({ sources: ['liked'], addedBeforeDays: 365, excludeHeavyRotation: true, sort: 'shuffle' }, seed),
  });
  push({
    id: 'rediscover-new',
    kind: 'rediscover',
    title: '🆕 Mes nouveautés',
    subtitle: 'tout ce que tu as liké ces 60 derniers jours',
    rule: rule({ sources: ['liked'], addedWithinDays: 60, sort: 'added_desc', maxTracks: 100, maxPerArtist: 0 }, seed),
  });
  push({
    id: 'rediscover-core',
    kind: 'rediscover',
    title: '❤️ Mes incontournables',
    subtitle: 'tes titres les plus écoutés, toutes périodes confondues',
    rule: rule({ sources: ['top'], sort: 'affinity', maxTracks: 60, maxPerArtist: 3 }, seed),
  });

  if (index.hasHistory) {
    push({
      id: 'rediscover-lost',
      kind: 'rediscover',
      title: '🕰️ Favoris perdus de vue',
      subtitle: 'écoutés au moins 10 fois, mais plus depuis 6 mois',
      rule: rule({ minPlays: 10, notPlayedForDays: 180, sort: 'affinity' }, seed),
    });
    push({
      id: 'rediscover-year',
      kind: 'rediscover',
      title: '🌱 Découvertes de l’année',
      subtitle: 'découverts ces 12 derniers mois et écoutés au moins 5 fois',
      rule: rule({ discoveredWithinDays: 365, minPlays: 5, sort: 'affinity', maxTracks: 60 }, seed),
    });
  }

  // Un « essentiel » pour les artistes les plus présents dans la bibliothèque.
  const topArtists = [...index.artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [id] of topArtists) {
    push({
      id: `artist-${id}`,
      kind: 'artist',
      title: `Essentiel : ${artistName(id)}`,
      subtitle: 'tous ses titres présents chez toi, favoris d’abord',
      rule: rule({ artistsInclude: [id], sort: 'affinity', maxTracks: 100, maxPerArtist: 0 }, seed),
    });
  }

  return out;
}
