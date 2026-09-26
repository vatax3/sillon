// Construit une vue « enrichie » de chaque titre, sur laquelle travaillent
// l'analyse, le générateur et les suggestions.
import { profileFromTags, type ArtistProfile } from './genres';
import { FLAG_NO_DURATION, FLAG_SKIPPED, nameKey, type HistoryStore } from './history';
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
  /** Statistiques d'écoute tirées de l'historique importé. */
  listen?: TrackListening;
}

export interface TrackListening {
  /** Écoutes de plus de 30 s. */
  plays: number;
  /** Taux de skip, quand au moins 3 écoutes portent l'information. */
  skipRate?: number;
  first: number;
  last: number;
}

/** Agrège l'historique par titre de la bibliothèque (rattachement par id, sinon par artiste + titre). */
export function listeningByTrack(lib: Library, h: HistoryStore): Map<string, TrackListening> {
  const byName = new Map<string, string>();
  for (const t of Object.values(lib.tracks)) byName.set(nameKey(t.artists[0]?.name ?? '', t.name), t.id);
  const idOf = h.tracks.map((t) => (!t.key.startsWith('n:') && lib.tracks[t.key] ? t.key : byName.get(nameKey(t.artist, t.name))));
  const acc = new Map<string, { plays: number; withInfo: number; skips: number; first: number; last: number }>();
  for (let i = 0; i < h.ts.length; i++) {
    const id = idOf[h.track[i]];
    if (!id) continue;
    const e = acc.get(id) ?? { plays: 0, withInfo: 0, skips: 0, first: h.ts[i], last: h.ts[i] };
    const noInfo = (h.flags[i] & FLAG_NO_DURATION) !== 0;
    if (noInfo || h.ms[i] >= 30_000) e.plays++;
    if (!noInfo) {
      e.withInfo++;
      if (h.flags[i] & FLAG_SKIPPED) e.skips++;
    }
    e.last = h.ts[i];
    acc.set(id, e);
  }
  return new Map(
    [...acc.entries()].map(([id, e]) => [id, { plays: e.plays, first: e.first, last: e.last, skipRate: e.withInfo >= 3 ? e.skips / e.withInfo : undefined }]),
  );
}

export interface LibraryIndex {
  tracks: EnrichedTrack[];
  byId: Map<string, EnrichedTrack>;
  artistProfiles: Map<string, ArtistProfile>;
  /** Nombre de titres par artiste. */
  artistCounts: Map<string, number>;
  coverage: { features: number; tags: number; artistsTagged: number; artistsTotal: number };
  /** Un historique d'écoute a été rattaché aux titres. */
  hasHistory: boolean;
}

const RANK_WEIGHT = { short_term: 1, medium_term: 1.5, long_term: 2 } as const;

export function buildIndex(lib: Library, tags: TagStore, features: FeatureStore, history?: HistoryStore | null): LibraryIndex {
  const listening = history?.ts.length ? listeningByTrack(lib, history) : null;
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
    const listen = listening?.get(track.id);
    // L'historique complet est le meilleur signal d'attachement quand il existe.
    if (listen) affinity += Math.log1p(listen.plays) * 0.8;

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
      listen,
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
    hasHistory: !!listening,
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
