// Radar de sorties : nouveaux albums et singles de tes artistes (suivis + tops + les plus présents).
// Spotify a retiré « new releases » aux apps en mode dev ; on interroge chaque artiste (2 requêtes).
import { SongSet } from './dedupe';
import { isAbort, throttledEach } from './http';
import type { LibraryIndex } from './indexer';
import * as sp from './spotify';
import type { Library } from './types';

export interface Release {
  album: sp.SimpleAlbum;
  /** Artistes de ta bibliothèque concernés par la sortie. */
  forArtists: string[];
}

export async function releaseRadar(
  artists: { id: string; name: string }[],
  sinceDays: number,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Release[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const byAlbum = new Map<string, Release>();
  let done = 0;
  await throttledEach(
    artists,
    async (a) => {
      try {
        for (const group of ['album', 'single'] as const) {
          for (const album of await sp.getArtistReleases(a.id, group, signal)) {
            // Précision « année » ou « mois » : on complète pour comparer à une date complète.
            const d = album.release_date;
            const date = d.length === 4 ? `${d}-12-31` : d.length === 7 ? `${d}-28` : d;
            if (date < since) continue;
            const r = byAlbum.get(album.id) ?? { album, forArtists: [] };
            if (!r.forArtists.includes(a.name)) r.forArtists.push(a.name);
            byAlbum.set(album.id, r);
          }
        }
      } catch (e) {
        if (isAbort(e)) throw e;
      } finally {
        onProgress(++done, artists.length);
      }
    },
    { concurrency: 2, minIntervalMs: 120, signal },
  );
  return [...byAlbum.values()].sort((a, b) => b.album.release_date.localeCompare(a.album.release_date));
}

/**
 * Titres des sorties, dans l'ordre des sorties et sans doublons : un single repris sur l'album
 * n'apparaît qu'une fois, dans sa version album. `first3` ne garde que 3 titres par album.
 */
export async function radarTracks(releases: Release[], albumTracks: 'all' | 'first3', signal?: AbortSignal): Promise<string[]> {
  const lists = new Map<string, Awaited<ReturnType<typeof sp.getAlbumTracks>>>();
  for (const r of releases) {
    const tracks = await sp.getAlbumTracks(r.album.id, signal);
    lists.set(r.album.id, albumTracks === 'first3' && r.album.album_type === 'album' ? tracks.slice(0, 3) : tracks);
  }
  const isSingle = (r: Release) => (r.album.album_type === 'single' ? 1 : 0);
  const seen = new SongSet();
  const keep = new Set<string>();
  for (const r of [...releases].sort((a, b) => isSingle(a) - isSingle(b))) {
    for (const t of lists.get(r.album.id) ?? []) {
      const ref = { name: t.name, artist: t.artists?.[0]?.name ?? r.album.artists[0]?.name ?? '' };
      if (seen.has(ref)) continue;
      seen.add(ref);
      keep.add(t.uri);
    }
  }
  return releases.flatMap((r) => (lists.get(r.album.id) ?? []).filter((t) => keep.delete(t.uri)).map((t) => t.uri));
}

/** Artistes surveillés : suivis, présents dans un top, et les 40 plus présents en bibliothèque (150 max). */
export function radarArtists(lib: Library, index: LibraryIndex, max = 150): { id: string; name: string }[] {
  const score = new Map<string, number>();
  for (const a of Object.values(lib.artists)) {
    let s = a.followed ? 5 : 0;
    for (const r of Object.values(a.topRanks)) s = Math.max(s, 10 - r! / 10);
    if (s > 0) score.set(a.id, s);
  }
  [...index.artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .forEach(([id, n]) => score.set(id, (score.get(id) ?? 0) + Math.min(n, 20) / 4));
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .filter(([id]) => lib.artists[id])
    .map(([id]) => ({ id, name: lib.artists[id].name }));
}
