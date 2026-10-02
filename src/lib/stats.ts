import { songKey } from './dedupe';
import { FAMILY_BY_ID } from './genres';
import type { EnrichedTrack, LibraryIndex } from './indexer';
import { MOOD_BY_ID } from './moods';
import type { Library, Mood } from './types';

export interface Bar {
  key: string;
  label: string;
  value: number;
}

export interface DuplicateGroup {
  key: string;
  tracks: EnrichedTrack[];
}

export interface LibraryStats {
  totalTracks: number;
  likedTracks: number;
  totalArtists: number;
  totalHours: number;
  explicitShare: number;
  families: Bar[];
  genres: Bar[];
  moods: Bar[];
  decades: Bar[];
  likedPerYear: Bar[];
  newArtistsPerYear: Bar[];
  topArtists: Bar[];
  profile: Bar[];
  duplicates: DuplicateGroup[];
  medianYear?: number;
}

const topN = (m: Map<string, number>, n: number, label: (k: string) => string): Bar[] =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, value]) => ({ key, label: label(key), value }));

const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function computeStats(lib: Library, index: LibraryIndex): LibraryStats {
  const tracks = index.tracks;
  const families = new Map<string, number>();
  const genres = new Map<string, number>();
  const moods = new Map<string, number>();
  const decades = new Map<string, number>();
  const likedPerYear = new Map<string, number>();
  const artistFirstLiked = new Map<string, string>();

  for (const t of tracks) {
    if (t.families[0]) inc(families, t.families[0]);
    for (const g of t.genres.slice(0, 3)) inc(genres, g);
    for (const m of t.moods.slice(0, 1)) inc(moods, m);
    if (t.year) inc(decades, String(Math.floor(t.year / 10) * 10));
    const liked = t.track.likedAt;
    if (liked) {
      inc(likedPerYear, liked.slice(0, 4));
      for (const a of t.track.artists) {
        const prev = artistFirstLiked.get(a.id);
        if (!prev || liked < prev) artistFirstLiked.set(a.id, liked);
      }
    }
  }
  const newArtistsPerYear = new Map<string, number>();
  for (const d of artistFirstLiked.values()) inc(newArtistsPerYear, d.slice(0, 4));

  const withF = tracks.filter((t) => t.features);
  const avg = (k: 'energy' | 'valence' | 'danceability' | 'acousticness' | 'instrumentalness') =>
    withF.length ? withF.reduce((s, t) => s + t.features![k], 0) / withF.length : 0;

  // Doublons probables parmi les likés : même morceau (titre sans mentions d'édition) + même artiste principal
  // (attrape les versions remaster / single / album ; un live ou un remix reste distinct).
  const groups = new Map<string, EnrichedTrack[]>();
  for (const t of tracks.filter((t) => t.track.likedAt)) {
    const key = songKey(t.track.name, t.track.artists[0]?.name ?? '');
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const duplicates = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, tracks: list }))
    .sort((a, b) => b.tracks.length - a.tracks.length);

  const years = tracks.map((t) => t.year).filter((y): y is number => !!y).sort((a, b) => a - b);
  const byKey = (a: Bar, b: Bar) => a.key.localeCompare(b.key);

  return {
    totalTracks: tracks.length,
    likedTracks: tracks.filter((t) => t.track.likedAt).length,
    totalArtists: index.artistCounts.size,
    totalHours: tracks.reduce((s, t) => s + t.track.durationMs, 0) / 3_600_000,
    explicitShare: tracks.length ? tracks.filter((t) => t.track.explicit).length / tracks.length : 0,
    families: topN(families, 12, (k) => FAMILY_BY_ID[k]?.label ?? k),
    genres: topN(genres, 20, (k) => k),
    moods: topN(moods, 8, (k) => `${MOOD_BY_ID[k as Mood].emoji} ${MOOD_BY_ID[k as Mood].label}`),
    decades: topN(decades, 20, (k) => `${k}s`).sort(byKey),
    likedPerYear: topN(likedPerYear, 30, (k) => k).sort(byKey),
    newArtistsPerYear: topN(newArtistsPerYear, 30, (k) => k).sort(byKey),
    topArtists: topN(index.artistCounts, 15, (k) => lib.artists[k]?.name ?? k),
    profile: withF.length
      ? [
          { key: 'energy', label: 'Énergie', value: avg('energy') },
          { key: 'valence', label: 'Positivité', value: avg('valence') },
          { key: 'danceability', label: 'Dansabilité', value: avg('danceability') },
          { key: 'acousticness', label: 'Acoustique', value: avg('acousticness') },
          { key: 'instrumentalness', label: 'Instrumental', value: avg('instrumentalness') },
        ]
      : [],
    duplicates,
    medianYear: years[Math.floor(years.length / 2)],
  };
}
