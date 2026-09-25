// Construit une vue « enrichie » de chaque titre, sur laquelle travaillent
// l'analyse, le générateur et les suggestions.
import { profileFromTags, type ArtistProfile } from './genres';
import { moodsFromFeatures, moodScores } from './moods';
import type { AudioFeatures, FeatureStore, Library, Mood, Source, TagStore, Track } from './types';

export interface EnrichedTrack {
  track: Track;
  year?: number;
  families: string[];
  genres: string[];
  moods: Mood[];
  moodScores?: Record<Mood, number>;
  moodSource: 'audio' | 'tags' | 'none';
  features?: AudioFeatures;
  sources: Source[];
  /** Score d'attachement : tops, écoutes récentes, présence dans plusieurs playlists. */
  affinity: number;
  /** Titre présent dans un top ou écouté récemment. */
  heavyRotation: boolean;
}

export interface LibraryIndex {
  tracks: EnrichedTrack[];
  byId: Map<string, EnrichedTrack>;
  artistProfiles: Map<string, ArtistProfile>;
  /** Nombre de titres par artiste. */
  artistCounts: Map<string, number>;
  coverage: { features: number; tags: number; artistsTagged: number; artistsTotal: number };
}

const RANK_WEIGHT = { short_term: 1, medium_term: 1.5, long_term: 2 } as const;

export function buildIndex(lib: Library, tags: TagStore, features: FeatureStore): LibraryIndex {
  const artistProfiles = new Map<string, ArtistProfile>();
  let artistsTagged = 0;
  for (const a of Object.values(lib.artists)) {
    const raw = tags[a.id]?.tags ?? a.spotifyGenres ?? [];
    const profile = profileFromTags(raw);
    if (profile.genres.length) artistsTagged++;
    artistProfiles.set(a.id, profile);
  }

  const artistCounts = new Map<string, number>();
  const out: EnrichedTrack[] = [];
  let withFeatures = 0;
  let withTags = 0;

  for (const track of Object.values(lib.tracks)) {
    for (const a of track.artists) artistCounts.set(a.id, (artistCounts.get(a.id) ?? 0) + 1);

    // L'artiste principal pèse le plus ; les featurings complètent.
    const families: string[] = [];
    const genres: string[] = [];
    const moodHints = new Set<Mood>();
    track.artists.forEach((a, i) => {
      const p = artistProfiles.get(a.id);
      if (!p) return;
      for (const f of i === 0 ? p.families : p.families.slice(0, 1)) if (!families.includes(f)) families.push(f);
      for (const g of i === 0 ? p.genres : p.genres.slice(0, 2)) if (!genres.includes(g)) genres.push(g);
      if (i === 0) p.moodHints.forEach((m) => moodHints.add(m));
    });
    if (genres.length) withTags++;

    const f = features[track.id] ?? undefined;
    let moods: Mood[] = [];
    let moodSource: EnrichedTrack['moodSource'] = 'none';
    if (f) {
      withFeatures++;
      moods = moodsFromFeatures(f);
      moodSource = 'audio';
    } else if (moodHints.size) {
      moods = [...moodHints];
      moodSource = 'tags';
    }

    const sources: Source[] = [];
    if (track.likedAt) sources.push('liked');
    if (track.playlists.length) sources.push('playlists');
    if (Object.keys(track.topRanks).length) sources.push('top');
    if (track.lastPlayedAt) sources.push('recent');

    let affinity = track.likedAt ? 1 : 0;
    affinity += Math.min(track.playlists.length, 5) * 0.5;
    for (const [range, rank] of Object.entries(track.topRanks)) {
      affinity += RANK_WEIGHT[range as keyof typeof RANK_WEIGHT] * (1 + (50 - rank!) / 25);
    }
    if (track.lastPlayedAt) affinity += 1;

    const year = parseInt(track.album.releaseDate.slice(0, 4), 10);
    out.push({
      track,
      year: Number.isFinite(year) && year > 1900 ? year : undefined,
      families,
      genres,
      moods,
      moodScores: f ? moodScores(f) : undefined,
      moodSource,
      features: f,
      sources,
      affinity,
      heavyRotation: Object.keys(track.topRanks).length > 0 || !!track.lastPlayedAt,
    });
  }

  return {
    tracks: out,
    byId: new Map(out.map((t) => [t.track.id, t])),
    artistProfiles,
    artistCounts,
    coverage: {
      features: out.length ? withFeatures / out.length : 0,
      tags: out.length ? withTags / out.length : 0,
      artistsTagged,
      artistsTotal: Object.keys(lib.artists).length,
    },
  };
}

/** Artistes triés par nombre de titres (ordre d'enrichissement : les plus utiles d'abord). */
export function artistsByImportance(lib: Library): string[] {
  const counts = new Map<string, number>();
  for (const t of Object.values(lib.tracks)) {
    t.artists.forEach((a, i) => counts.set(a.id, (counts.get(a.id) ?? 0) + (i === 0 ? 1 : 0.3)));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
