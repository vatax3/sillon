import * as sp from './spotify';
import type { Artist, Library, PlaylistMeta, Track, TimeRange } from './types';
import { TIME_RANGES } from './types';

export interface Progress {
  label: string;
  done: number;
  total?: number;
}

function toTrack(raw: sp.RawTrack): Track | null {
  if (!raw.id || raw.is_local || (raw.type && raw.type !== 'track')) return null;
  const images = raw.album.images ?? [];
  // La plus petite pochette >= 64px suffit pour l'affichage en liste.
  const image = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((i) => (i.width ?? 300) >= 64)?.url;
  return {
    id: raw.id,
    uri: raw.uri,
    name: raw.name,
    artists: raw.artists.filter((a) => a.id).map((a) => ({ id: a.id!, name: a.name })),
    album: { id: raw.album.id, name: raw.album.name, releaseDate: raw.album.release_date ?? '', image },
    durationMs: raw.duration_ms,
    explicit: raw.explicit,
    isrc: raw.external_ids?.isrc,
    playlists: [],
    topRanks: {},
  };
}

/**
 * Synchronise tout ce qui est lisible en mode dev : likés, playlists possédées/collaboratives,
 * tops (3 périodes), écoutes récentes et artistes suivis.
 */
export async function syncLibrary(
  opts: { excludePlaylistIds: Set<string> },
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<Library> {
  const tracks: Record<string, Track> = {};
  const artists: Record<string, Artist> = {};

  const upsert = (raw: sp.RawTrack): Track | null => {
    const t = toTrack(raw);
    if (!t) return null;
    const existing = tracks[t.id];
    if (existing) return existing;
    tracks[t.id] = t;
    for (const a of t.artists) {
      artists[a.id] ??= { id: a.id, name: a.name, topRanks: {}, followed: false };
    }
    return t;
  };
  const upsertArtist = (raw: sp.RawArtist): Artist => {
    const a = (artists[raw.id] ??= { id: raw.id, name: raw.name, topRanks: {}, followed: false });
    if (raw.genres?.length) a.spotifyGenres = raw.genres;
    return a;
  };

  onProgress({ label: 'Profil', done: 0 });
  const me = await sp.getMe();

  onProgress({ label: 'Titres likés', done: 0 });
  const saved = await sp.getSavedTracks((done, total) => onProgress({ label: 'Titres likés', done, total }), signal);
  for (const row of saved) {
    const t = upsert(row.track);
    if (t) t.likedAt = row.added_at;
  }

  onProgress({ label: 'Playlists', done: 0 });
  const rawPlaylists = (await sp.getMyPlaylists(signal)).filter((p): p is sp.RawPlaylist => !!p);
  const playlists: PlaylistMeta[] = rawPlaylists.map((p) => {
    const owned = p.owner.id === me.id;
    return {
      id: p.id,
      name: p.name,
      owned,
      collaborative: p.collaborative,
      trackCount: p.items?.total ?? p.tracks?.total ?? 0,
      image: p.images?.[0]?.url,
      // Spotify ne renvoie le contenu que des playlists possédées ou collaboratives.
      synced: (owned || p.collaborative) && !opts.excludePlaylistIds.has(p.id),
    };
  });
  const toSync = playlists.filter((p) => p.synced);
  for (const [i, pl] of toSync.entries()) {
    onProgress({ label: `Playlist « ${pl.name} »`, done: i, total: toSync.length });
    try {
      for (const raw of await sp.getPlaylistTracks(pl.id, signal)) {
        const t = upsert(raw);
        if (t && !t.playlists.includes(pl.id)) t.playlists.push(pl.id);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      pl.synced = false; // playlist illisible : on continue sans elle
    }
  }

  for (const [i, range] of TIME_RANGES.entries()) {
    onProgress({ label: 'Tops personnels', done: i, total: TIME_RANGES.length });
    const [topTracks, topArtists] = await Promise.all([
      sp.getTop('tracks', range, signal),
      sp.getTop('artists', range, signal),
    ]);
    topTracks.forEach((raw, rank) => {
      const t = upsert(raw);
      if (t) t.topRanks[range as TimeRange] = rank + 1;
    });
    topArtists.forEach((raw, rank) => {
      upsertArtist(raw).topRanks[range] = rank + 1;
    });
  }

  onProgress({ label: 'Écoutes récentes', done: 0 });
  for (const row of await sp.getRecentlyPlayed(signal)) {
    const t = upsert(row.track);
    if (t && (!t.lastPlayedAt || t.lastPlayedAt < row.played_at)) t.lastPlayedAt = row.played_at;
  }

  onProgress({ label: 'Artistes suivis', done: 0 });
  for (const raw of await sp.getFollowedArtists(signal)) upsertArtist(raw).followed = true;

  return {
    user: { id: me.id, name: me.display_name || me.id, image: me.images?.[0]?.url },
    tracks,
    artists,
    playlists,
    syncedAt: new Date().toISOString(),
  };
}
