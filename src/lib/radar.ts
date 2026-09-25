// Radar de sorties : nouveaux albums et singles de tes artistes (suivis + tops + les plus présents).
// Spotify a retiré « new releases » aux apps en mode dev ; on interroge chaque artiste (2 requêtes).
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
