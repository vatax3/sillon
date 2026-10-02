import { dedupeSongs } from './dedupe';
import { FLAG_NO_DURATION, FLAG_SKIPPED, type HistoryStore } from './history';
import type { FeatureStore } from './types';

const DAY = 86_400_000;

export interface Period {
  id: string;
  label: string;
  from: number;
  to: number;
}

/** Une écoute « compte » au-delà de 30 s (même règle que Spotify pour les royalties). */
export const isStream = (h: HistoryStore, i: number) => h.ms[i] >= 30_000 || (h.flags[i] & FLAG_NO_DURATION) !== 0;

export function availablePeriods(h: HistoryStore, now = Date.now()): Period[] {
  if (!h.ts.length) return [];
  const first = new Date(h.ts[0]).getFullYear();
  const last = new Date(h.ts[h.ts.length - 1]).getFullYear();
  const out: Period[] = [
    { id: 'all', label: 'Depuis le début', from: 0, to: Infinity },
    { id: '12m', label: '12 derniers mois', from: now - 365 * DAY, to: Infinity },
    { id: '30d', label: '30 derniers jours', from: now - 30 * DAY, to: Infinity },
  ];
  for (let y = last; y >= first; y--) {
    out.push({ id: `y${y}`, label: String(y), from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() });
  }
  return out;
}

/** Bornes d'index [start, end) des écoutes dans la période (ts est trié). */
export function rangeOf(h: HistoryStore, p: { from: number; to: number }): [number, number] {
  const lower = (x: number) => {
    let lo = 0;
    let hi = h.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (h.ts[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [lower(p.from), p.to === Infinity ? h.ts.length : lower(p.to)];
}

export interface Ranked<K> {
  key: K;
  ms: number;
  streams: number;
}

/** URIs Spotify d'un classement de titres, sans les titres inconnus de Spotify ni les doublons de versions. */
export function rankedUris(h: HistoryStore, rows: Ranked<number>[]): string[] {
  const tracks = rows.map((r) => h.tracks[r.key]).filter((t) => t && !t.key.startsWith('n:'));
  const uris = new Set<string>();
  return dedupeSongs(tracks, (t) => ({ name: t.name, artist: t.artist }))
    .kept.map((t) => `spotify:track:${t.key}`)
    .filter((u) => !uris.has(u) && uris.add(u));
}

export interface SkipRow {
  key: number | string;
  plays: number;
  skips: number;
  rate: number;
}

export interface Era {
  from: string; // YYYY-MM
  to: string;
  artist: string;
  ms: number;
}

export interface Obsession {
  track: number;
  count: number;
  start: number;
}

export interface HistoryStats {
  totalMs: number;
  streams: number;
  uniqueTracks: number;
  uniqueArtists: number;
  activeDays: number;
  longestStreak: { days: number; end?: number };
  heatmap: number[][]; // [jour lundi=0][heure] → minutes
  perMonth: { key: string; value: number }[];
  topArtists: Ranked<string>[];
  topTracks: Ranked<number>[];
  topAlbums: Ranked<string>[];
  skippedTracks: SkipRow[];
  skippedArtists: SkipRow[];
  eras: Era[];
  obsessions: Obsession[];
  newArtistsPerMonth: { key: string; value: number }[];
  discoveries: Ranked<string>[];
  shuffleShare: number;
}

const monthKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const dayIndex = (ts: number) => {
  const d = new Date(ts);
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
};

function rank<K>(m: Map<K, { ms: number; streams: number }>, n: number, by: 'ms' | 'streams' = 'ms'): Ranked<K>[] {
  return [...m.entries()]
    .sort((a, b) => b[1][by] - a[1][by])
    .slice(0, n)
    .map(([key, v]) => ({ key, ...v }));
}

function bump<K>(m: Map<K, { ms: number; streams: number }>, k: K, ms: number, stream: boolean) {
  const v = m.get(k);
  if (v) {
    v.ms += ms;
    if (stream) v.streams++;
  } else m.set(k, { ms, streams: stream ? 1 : 0 });
}

/** Premier jour d'écoute de chaque artiste, sur tout l'historique. */
export function artistFirstPlays(h: HistoryStore): Map<string, number> {
  const first = new Map<string, number>();
  for (let i = 0; i < h.ts.length; i++) {
    if (!isStream(h, i)) continue;
    const a = h.tracks[h.track[i]].artist;
    if (!first.has(a)) first.set(a, h.ts[i]);
  }
  return first;
}

export function computeHistoryStats(h: HistoryStore, p: { from: number; to: number }): HistoryStats {
  const [start, end] = rangeOf(h, p);
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const perMonth = new Map<string, number>();
  const artists = new Map<string, { ms: number; streams: number }>();
  const tracks = new Map<number, { ms: number; streams: number }>();
  const albums = new Map<string, { ms: number; streams: number }>();
  const trackSkips = new Map<number, { plays: number; skips: number }>();
  const artistSkips = new Map<string, { plays: number; skips: number }>();
  const monthArtist = new Map<string, Map<string, number>>();
  const days = new Set<number>();
  let totalMs = 0;
  let streams = 0;
  let shuffled = 0;

  for (let i = start; i < end; i++) {
    const ts = h.ts[i];
    const ms = h.ms[i];
    const t = h.tracks[h.track[i]];
    const stream = isStream(h, i);
    const d = new Date(ts);
    totalMs += ms;
    if (stream) {
      streams++;
      days.add(dayIndex(ts));
    }
    if (h.flags[i] & 2) shuffled++;
    heatmap[(d.getDay() + 6) % 7][d.getHours()] += ms / 60_000;
    const mk = monthKey(ts);
    perMonth.set(mk, (perMonth.get(mk) ?? 0) + ms / 60_000);
    bump(artists, t.artist, ms, stream);
    bump(tracks, h.track[i], ms, stream);
    if (t.album) bump(albums, `${t.album}\u0000${t.artist}`, ms, stream);
    // Le taux de skip ne se calcule que là où l'info existe (pas sur les écoutes API).
    if (!(h.flags[i] & FLAG_NO_DURATION)) {
      const skipped = (h.flags[i] & FLAG_SKIPPED) !== 0;
      const ts_ = trackSkips.get(h.track[i]) ?? { plays: 0, skips: 0 };
      ts_.plays++;
      if (skipped) ts_.skips++;
      trackSkips.set(h.track[i], ts_);
      const as = artistSkips.get(t.artist) ?? { plays: 0, skips: 0 };
      as.plays++;
      if (skipped) as.skips++;
      artistSkips.set(t.artist, as);
    }
    const ma = monthArtist.get(mk) ?? new Map<string, number>();
    ma.set(t.artist, (ma.get(t.artist) ?? 0) + ms);
    monthArtist.set(mk, ma);
  }

  // Plus longue série de jours consécutifs avec au moins une écoute.
  const sortedDays = [...days].sort((a, b) => a - b);
  let best = { days: 0, end: undefined as number | undefined };
  let run = 0;
  sortedDays.forEach((d, i) => {
    run = i > 0 && d === sortedDays[i - 1] + 1 ? run + 1 : 1;
    if (run > best.days) best = { days: run, end: d * DAY };
  });

  // Époques : artiste dominant de chaque mois, mois consécutifs fusionnés.
  const eras: Era[] = [];
  for (const [mk, m] of [...monthArtist.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [artist, ms] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const last = eras[eras.length - 1];
    if (last && last.artist === artist) {
      last.to = mk;
      last.ms += ms;
    } else eras.push({ from: mk, to: mk, artist, ms });
  }

  // Obsessions : le plus d'écoutes d'un même titre sur 14 jours glissants.
  const perTrackTimes = new Map<number, number[]>();
  for (let i = start; i < end; i++) {
    if (!isStream(h, i)) continue;
    const arr = perTrackTimes.get(h.track[i]) ?? [];
    arr.push(h.ts[i]);
    perTrackTimes.set(h.track[i], arr);
  }
  const obsessions: Obsession[] = [];
  for (const [track, times] of perTrackTimes) {
    if (times.length < 12) continue;
    let bestCount = 0;
    let bestStart = times[0];
    let lo = 0;
    for (let hi = 0; hi < times.length; hi++) {
      while (times[hi] - times[lo] > 14 * DAY) lo++;
      if (hi - lo + 1 > bestCount) {
        bestCount = hi - lo + 1;
        bestStart = times[lo];
      }
    }
    if (bestCount >= 12) obsessions.push({ track, count: bestCount, start: bestStart });
  }
  obsessions.sort((a, b) => b.count - a.count);

  // Découvertes : artistes dont la toute première écoute tombe dans la période.
  const firsts = artistFirstPlays(h);
  const newPerMonth = new Map<string, number>();
  const discovered = new Map<string, { ms: number; streams: number }>();
  for (const [artist, ts] of firsts) {
    if (ts < (h.ts[start] ?? Infinity) || ts > (h.ts[end - 1] ?? -Infinity)) continue;
    const mk = monthKey(ts);
    newPerMonth.set(mk, (newPerMonth.get(mk) ?? 0) + 1);
    const a = artists.get(artist);
    if (a) discovered.set(artist, a);
  }

  const skipRows = <K>(m: Map<K, { plays: number; skips: number }>, minPlays: number): SkipRow[] =>
    [...m.entries()]
      .filter(([, v]) => v.plays >= minPlays)
      .map(([key, v]) => ({ key: key as number | string, ...v, rate: v.skips / v.plays }))
      .filter((r) => r.rate >= 0.5)
      .sort((a, b) => b.rate - a.rate || b.plays - a.plays)
      .slice(0, 40);

  const sortByKey = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => ({ key, value: Math.round(value) }));

  return {
    totalMs,
    streams,
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    activeDays: days.size,
    longestStreak: best,
    heatmap,
    perMonth: sortByKey(perMonth),
    topArtists: rank(artists, 50),
    topTracks: rank(tracks, 50, 'streams'),
    topAlbums: rank(albums, 20),
    skippedTracks: skipRows(trackSkips, 5),
    skippedArtists: skipRows(artistSkips, 15),
    eras,
    obsessions: obsessions.slice(0, 15),
    newArtistsPerMonth: sortByKey(newPerMonth),
    discoveries: rank(discovered, 20, 'streams').filter((d) => d.streams >= 5),
    shuffleShare: end > start ? shuffled / (end - start) : 0,
  };
}

// ---------- Vues transverses (sur tout l'historique) ----------

export interface YearSummary {
  year: number;
  minutes: number;
  streams: number;
  artists: number;
  newArtists: number;
  topArtist?: string;
  topTrack?: number;
}

export function yearsSummary(h: HistoryStore): YearSummary[] {
  const firsts = artistFirstPlays(h);
  const byYear = new Map<number, { ms: number; streams: number; artists: Map<string, number>; tracks: Map<number, number> }>();
  for (let i = 0; i < h.ts.length; i++) {
    const y = new Date(h.ts[i]).getFullYear();
    const e = byYear.get(y) ?? { ms: 0, streams: 0, artists: new Map(), tracks: new Map() };
    e.ms += h.ms[i];
    if (isStream(h, i)) {
      e.streams++;
      e.tracks.set(h.track[i], (e.tracks.get(h.track[i]) ?? 0) + 1);
    }
    const a = h.tracks[h.track[i]].artist;
    e.artists.set(a, (e.artists.get(a) ?? 0) + h.ms[i]);
    byYear.set(y, e);
  }
  const newByYear = new Map<number, number>();
  for (const ts of firsts.values()) {
    const y = new Date(ts).getFullYear();
    newByYear.set(y, (newByYear.get(y) ?? 0) + 1);
  }
  const top = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, e]) => ({
      year,
      minutes: Math.round(e.ms / 60_000),
      streams: e.streams,
      artists: e.artists.size,
      newArtists: newByYear.get(year) ?? 0,
      topArtist: top(e.artists),
      topTrack: top(e.tracks),
    }));
}

/** Artistes fidèles : écoutés sur le plus grand nombre d'années différentes. */
export function loyalArtists(h: HistoryStore, minYears = 3): { artist: string; years: number; ms: number }[] {
  const m = new Map<string, { years: Set<number>; ms: number }>();
  for (let i = 0; i < h.ts.length; i++) {
    if (!isStream(h, i)) continue;
    const a = h.tracks[h.track[i]].artist;
    const e = m.get(a) ?? { years: new Set<number>(), ms: 0 };
    e.years.add(new Date(h.ts[i]).getFullYear());
    e.ms += h.ms[i];
    m.set(a, e);
  }
  return [...m.entries()]
    .filter(([, e]) => e.years.size >= minYears)
    .map(([artist, e]) => ({ artist, years: e.years.size, ms: e.ms }))
    .sort((a, b) => b.years - a.years || b.ms - a.ms)
    .slice(0, 25);
}

/** Top titres d'une fenêtre temporelle (utilisé par la machine à remonter le temps et les playlists de contexte). */
export function topTracksWhere(
  h: HistoryStore,
  p: { from: number; to: number },
  keep: (d: Date) => boolean = () => true,
  n = 30,
): Ranked<number>[] {
  const [start, end] = rangeOf(h, p);
  const m = new Map<number, { ms: number; streams: number }>();
  for (let i = start; i < end; i++) {
    if (!isStream(h, i) || !keep(new Date(h.ts[i]))) continue;
    bump(m, h.track[i], h.ms[i], true);
  }
  return rank(m, n, 'streams');
}

export interface TimeMachineYear {
  year: number;
  tracks: Ranked<number>[];
}

/** « Ce que tu écoutais à la même époque » : même mois calendaire, les années précédentes. */
export function timeMachine(h: HistoryStore, now = new Date()): TimeMachineYear[] {
  if (!h.ts.length) return [];
  const firstYear = new Date(h.ts[0]).getFullYear();
  const out: TimeMachineYear[] = [];
  for (let y = now.getFullYear() - 1; y >= firstYear; y--) {
    const from = new Date(y, now.getMonth(), 1).getTime();
    const to = new Date(y, now.getMonth() + 1, 1).getTime();
    const tracks = topTracksWhere(h, { from, to }, undefined, 25);
    if (tracks.length >= 5) out.push({ year: y, tracks });
  }
  return out;
}

export const CONTEXTS: { id: string; label: string; test: (d: Date) => boolean }[] = [
  { id: 'morning', label: '☕ Tes matins de semaine', test: (d) => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 6 && d.getHours() < 11 },
  { id: 'work', label: '💼 Tes après-midis de semaine', test: (d) => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 13 && d.getHours() < 18 },
  { id: 'evening', label: '🌆 Tes soirées', test: (d) => d.getHours() >= 19 && d.getHours() < 24 },
  { id: 'night', label: '🌌 Tes nuits', test: (d) => d.getHours() >= 0 && d.getHours() < 5 },
  { id: 'weekend', label: '🛋️ Tes week-ends', test: (d) => d.getDay() === 0 || d.getDay() === 6 },
];

export interface MoodMoment {
  byHour: { energy: number; valence: number; weight: number }[];
  byMonth: { energy: number; valence: number; weight: number }[];
  coverage: number;
}

/** Énergie et positivité moyennes (pondérées par le temps d'écoute) selon l'heure et le mois. */
export function moodByMoment(h: HistoryStore, features: FeatureStore, p: { from: number; to: number }): MoodMoment {
  const [start, end] = rangeOf(h, p);
  const acc = (n: number) => Array.from({ length: n }, () => ({ energy: 0, valence: 0, weight: 0 }));
  const byHour = acc(24);
  const byMonth = acc(12);
  let covered = 0;
  let total = 0;
  for (let i = start; i < end; i++) {
    if (!isStream(h, i)) continue;
    const w = h.ms[i];
    total += w;
    const f = features[h.tracks[h.track[i]].key];
    if (!f) continue;
    covered += w;
    const d = new Date(h.ts[i]);
    for (const bucket of [byHour[d.getHours()], byMonth[d.getMonth()]]) {
      bucket.energy += f.energy * w;
      bucket.valence += f.valence * w;
      bucket.weight += w;
    }
  }
  const norm = (b: { energy: number; valence: number; weight: number }) =>
    b.weight ? { energy: b.energy / b.weight, valence: b.valence / b.weight, weight: b.weight } : b;
  return { byHour: byHour.map(norm), byMonth: byMonth.map(norm), coverage: total ? covered / total : 0 };
}

/** Ids Spotify les plus écoutés (pour enrichir leurs audio-features en priorité). */
export function mostPlayedIds(h: HistoryStore, n: number): string[] {
  const ms = new Map<number, number>();
  for (let i = 0; i < h.ts.length; i++) ms.set(h.track[i], (ms.get(h.track[i]) ?? 0) + h.ms[i]);
  return [...ms.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => h.tracks[t].key)
    .filter((k) => !k.startsWith('n:'))
    .slice(0, n);
}
