export type TimeRange = 'short_term' | 'medium_term' | 'long_term';
export const TIME_RANGES: TimeRange[] = ['short_term', 'medium_term', 'long_term'];

export interface ArtistRef {
  id: string;
  name: string;
}

export interface Track {
  id: string;
  uri: string;
  name: string;
  artists: ArtistRef[];
  album: { id: string; name: string; releaseDate: string; image?: string };
  durationMs: number;
  explicit: boolean;
  isrc?: string;
  /** Date d'ajout aux Titres likés. */
  likedAt?: string;
  /** Playlists (possédées par l'utilisateur) qui contiennent ce titre. */
  playlists: string[];
  /** Rang (1 = premier) dans les top titres, par période. */
  topRanks: Partial<Record<TimeRange, number>>;
  lastPlayedAt?: string;
}

export interface Artist {
  id: string;
  name: string;
  /** Genres renvoyés par Spotify quand il en fournit encore (souvent null depuis 2026). */
  spotifyGenres?: string[];
  topRanks: Partial<Record<TimeRange, number>>;
  followed: boolean;
}

export interface PlaylistMeta {
  id: string;
  name: string;
  owned: boolean;
  collaborative: boolean;
  trackCount: number;
  image?: string;
  /** false si la playlist a été ignorée (pas à toi, ou créée par Sillon). */
  synced: boolean;
}

export interface User {
  id: string;
  name: string;
  image?: string;
}

export interface Library {
  user: User;
  tracks: Record<string, Track>;
  artists: Record<string, Artist>;
  playlists: PlaylistMeta[];
  syncedAt: string;
}

export interface AudioFeatures {
  acousticness: number;
  danceability: number;
  energy: number;
  instrumentalness: number;
  liveness: number;
  loudness: number;
  speechiness: number;
  tempo: number;
  valence: number;
  key: number;
  mode: number;
}

export type TagSource = 'spotify' | 'lastfm' | 'musicbrainz' | 'none';

export interface ArtistTags {
  tags: string[];
  source: TagSource;
  fetchedAt: string;
}

/** Features par id de titre ; null = inconnu de ReccoBeats (ne pas redemander). */
export type FeatureStore = Record<string, AudioFeatures | null>;
export type TagStore = Record<string, ArtistTags>;

export type Source = 'liked' | 'playlists' | 'top' | 'recent';

export type Mood =
  | 'chill'
  | 'energy'
  | 'party'
  | 'feelgood'
  | 'melancholy'
  | 'focus'
  | 'intense'
  | 'acoustic';

export type SortMode =
  | 'shuffle'
  | 'affinity'
  | 'added_desc'
  | 'release_asc'
  | 'release_desc'
  | 'energy_asc'
  | 'energy_arc'
  | 'tempo_asc'
  | 'harmonic';

export type Range = [number, number];

export interface Rule {
  families: string[];
  genres: string[];
  moods: Mood[];
  artistsInclude: string[];
  artistsExclude: string[];
  /** Vide = toutes les sources. */
  sources: Source[];
  yearMin?: number;
  yearMax?: number;
  /** Ajouté aux likés il y a moins de N jours. */
  addedWithinDays?: number;
  /** Ajouté aux likés il y a plus de N jours. */
  addedBeforeDays?: number;
  energy?: Range;
  valence?: Range;
  danceability?: Range;
  acousticness?: Range;
  tempo?: Range;
  maxDurationMin?: number;
  explicit: 'any' | 'exclude' | 'only';
  /** Exclut les titres présents dans le top / écoutés récemment (pour les redécouvertes). */
  excludeHeavyRotation?: boolean;
  maxTracks: number;
  maxPerArtist: number;
  sort: SortMode;
  seed: number;
}

export interface SavedPlaylist {
  spotifyId: string;
  name: string;
  description: string;
  rule: Rule;
  /** Sous-ensemble de titres figé (ambiances détectées par clustering). */
  pool?: string[];
  createdAt: string;
  updatedAt: string;
  trackCount: number;
  isPublic: boolean;
}

export interface Settings {
  lastfmKey: string;
  playlistPrefix: string;
  publicByDefault: boolean;
}
