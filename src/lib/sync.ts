import { isAbort, throttledEach } from './http';
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
    album: { id: raw.album.id, name: raw.album.name, releaseDate: raw.album.release_date ?? '', image, totalTracks: raw.album.total_tracks },
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
  const me = await sp.getMe(signal);

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
  const playlistItems: Record<string, string[]> = {};
  // Plusieurs playlists à la fois (débit borné) : la plupart tiennent en une ou deux pages.
  let loaded = 0;
  onProgress({ label: 'Contenu des playlists', done: 0, total: toSync.length });
  await throttledEach(
    toSync,
    async (pl) => {
      try {
        const raws = await sp.getPlaylistTracks(pl.id, signal);
        const ids: string[] = [];
        for (const raw of raws) {
          const t = upsert(raw);
          if (!t) continue;
          ids.push(t.id);
          if (!t.playlists.includes(pl.id)) t.playlists.push(pl.id);
        }
        playlistItems[pl.id] = ids;
      } catch (e) {
        if (signal?.aborted || isAbort(e)) throw e;
        pl.synced = false; // playlist illisible : on continue sans elle
      }
      onProgress({ label: `Playlist « ${pl.name} »`, done: ++loaded, total: toSync.length });
    },
    { concurrency: 3, minIntervalMs: 80, signal },
  );
  // Ordre stable des playlists de chaque titre, quel que soit l'ordre d'arrivée.
  const order = new Map(toSync.map((p, i) => [p.id, i]));
  for (const t of Object.values(tracks)) if (t.playlists.length > 1) t.playlists.sort((a, b) => order.get(a)! - order.get(b)!);

  onProgress({ label: 'Tops personnels', done: 0 });
  const tops = await Promise.all(
    TIME_RANGES.map((range) => Promise.all([sp.getTop('tracks', range, signal), sp.getTop('artists', range, signal)])),
  );
  TIME_RANGES.forEach((range, i) => {
    const [topTracks, topArtists] = tops[i];
    topTracks.forEach((raw, rank) => {
      const t = upsert(raw);
      if (t) t.topRanks[range as TimeRange] = rank + 1;
    });
    topArtists.forEach((raw, rank) => {
      upsertArtist(raw).topRanks[range] = rank + 1;
    });
  });

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
    playlistItems,
    syncedAt: new Date().toISOString(),
  };
}
