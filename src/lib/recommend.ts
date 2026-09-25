// Recommandations « maison » : Spotify a retiré les siennes aux apps en mode dev.
// 1. artistes similaires aux artistes de départ (Deezer), pondérés par leur rang et le poids de la graine ;
// 2. leurs titres phares (Deezer), en écartant tout ce que tu connais déjà (bibliothèque + historique) ;
// 3. résolution vers Spotify par recherche, pour pouvoir liker / lire / créer une playlist.
import * as dz from './deezer';
import { normalizeName } from './enrich';
import { nameKey } from './history';
import { isAbort, throttledEach } from './http';
import * as sp from './spotify';
import type { AudioFeatures } from './types';

export interface Seed {
  name: string;
  weight: number;
}

export interface Recommendation {
  title: string;
  artist: string;
  album: string;
  preview?: string;
  cover?: string;
  because: string[];
  score: number;
  spotify: { id: string; uri: string; durationMs: number; image?: string };
  features?: AudioFeatures;
}

export interface RecoOptions {
  seeds: Seed[];
  /** Noms d'artistes normalisés déjà connus. */
  knownArtists: Set<string>;
  /** Clés nameKey(artiste, titre) des titres déjà connus. */
  knownTracks: Set<string>;
  /** Titres Spotify déjà connus (ids). */
  knownIds: Set<string>;
  unknownArtistsOnly: boolean;
  size: number;
  perArtist: number;
  onProgress?: (label: string, done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Retrouve un titre sur Spotify ; le premier résultat dont l'artiste correspond. */
export async function resolveOnSpotify(title: string, artist: string, signal?: AbortSignal): Promise<sp.RawTrack | null> {
  const clean = title.replace(/\s*[([].*?[)\]]/g, '').replace(/"/g, '');
  const results = await sp.searchTracks(`track:"${clean}" artist:"${artist.replace(/"/g, '')}"`, 3, signal);
  const target = normalizeName(artist);
  return results.find((t) => t.id && t.artists.some((a) => normalizeName(a.name) === target)) ?? null;
}

export async function recommend(opts: RecoOptions): Promise<Recommendation[]> {
  const { signal } = opts;
  const seedNames = new Set(opts.seeds.map((s) => normalizeName(s.name)));
  const candidates = new Map<string, { artist: dz.DzArtist; score: number; because: string[] }>();

  let done = 0;
  await throttledEach(
    opts.seeds,
    async (seed) => {
      try {
        const artist = await dz.findArtist(seed.name, signal);
        if (!artist) return;
        const related = await dz.relatedArtists(artist.id, signal);
        related.forEach((r, rank) => {
          const key = normalizeName(r.name);
          if (seedNames.has(key)) return;
          if (opts.unknownArtistsOnly && opts.knownArtists.has(key)) return;
          const c = candidates.get(key) ?? { artist: r, score: 0, because: [] };
          // Un artiste déjà connu reste proposable (titres inconnus), mais passe après les découvertes.
          c.score += seed.weight * (1 - rank / 30) * (opts.knownArtists.has(key) ? 0.5 : 1);
          if (!c.because.includes(seed.name)) c.because.push(seed.name);
          candidates.set(key, c);
        });
      } catch (e) {
        if (isAbort(e)) throw e;
      } finally {
        opts.onProgress?.('Artistes similaires (Deezer)', ++done, opts.seeds.length);
      }
    },
    { concurrency: 2, minIntervalMs: 0, signal },
  );

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
  const wanted = Math.ceil((opts.size / opts.perArtist) * 1.6);
  const picks: { t: dz.DzTrack; c: (typeof ranked)[number] }[] = [];
  done = 0;
  const pool = ranked.slice(0, wanted);
  await throttledEach(
    pool,
    async (c) => {
      try {
        const top = await dz.artistTop(c.artist.id, 10, signal);
        let taken = 0;
        for (const t of top) {
          if (taken >= opts.perArtist) break;
          if (opts.knownTracks.has(nameKey(t.artist.name, t.title))) continue;
          picks.push({ t, c });
          taken++;
        }
      } catch (e) {
        if (isAbort(e)) throw e;
      } finally {
        opts.onProgress?.('Titres phares', ++done, pool.length);
      }
    },
    { concurrency: 2, minIntervalMs: 0, signal },
  );

  picks.sort((a, b) => b.c.score - a.c.score);
  const out: Recommendation[] = [];
  done = 0;
  const toResolve = picks.slice(0, Math.ceil(opts.size * 1.3));
  await throttledEach(
    toResolve,
    async ({ t, c }) => {
      try {
        const found = await resolveOnSpotify(t.title, t.artist.name, signal);
        if (found?.id && !opts.knownIds.has(found.id)) {
          out.push({
            title: t.title,
            artist: t.artist.name,
            album: t.album.title,
            preview: t.preview || undefined,
            cover: t.album.cover_medium,
            because: c.because.slice(0, 3),
            score: c.score,
            spotify: {
              id: found.id,
              uri: found.uri,
              durationMs: found.duration_ms,
              image: found.album.images?.find((i) => (i.width ?? 300) <= 300)?.url ?? found.album.images?.[0]?.url,
            },
          });
        }
      } catch (e) {
        if (isAbort(e)) throw e;
      } finally {
        opts.onProgress?.('Correspondance Spotify', ++done, toResolve.length);
      }
    },
    { concurrency: 2, minIntervalMs: 150, signal },
  );

  const seen = new Set<string>();
  return out
    .filter((r) => !seen.has(r.spotify.id) && seen.add(r.spotify.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.size);
}

/** Titres phares d'un artiste, résolus sur Spotify (pour « creuser » un artiste). */
export async function artistEssentials(
  name: string,
  knownIds: Set<string>,
  signal?: AbortSignal,
): Promise<Recommendation[]> {
  const artist = await dz.findArtist(name, signal);
  if (!artist) return [];
  const top = await dz.artistTop(artist.id, 10, signal);
  const out: Recommendation[] = [];
  for (const t of top) {
    const found = await resolveOnSpotify(t.title, t.artist.name, signal);
    if (!found?.id || knownIds.has(found.id)) continue;
    out.push({
      title: t.title,
      artist: t.artist.name,
      album: t.album.title,
      preview: t.preview || undefined,
      cover: t.album.cover_medium,
      because: [],
      score: 0,
      spotify: { id: found.id, uri: found.uri, durationMs: found.duration_ms, image: found.album.images?.[0]?.url },
    });
  }
  return out;
}

const DIMS = ['energy', 'valence', 'danceability', 'acousticness'] as const;

export function featureCentroid(list: AudioFeatures[]): Record<(typeof DIMS)[number], number> | null {
  if (!list.length) return null;
  return Object.fromEntries(DIMS.map((d) => [d, list.reduce((s, f) => s + f[d], 0) / list.length])) as Record<
    (typeof DIMS)[number],
    number
  >;
}

/** Réordonne par proximité sonore avec une cible et écarte le tiers le plus éloigné. */
export function rankBySound(recos: Recommendation[], target: Record<(typeof DIMS)[number], number>): Recommendation[] {
  const dist = (f: AudioFeatures) => Math.sqrt(DIMS.reduce((s, d) => s + (f[d] - target[d]) ** 2, 0));
  const withF = recos.filter((r) => r.features).sort((a, b) => dist(a.features!) - dist(b.features!));
  const without = recos.filter((r) => !r.features);
  return [...withF.slice(0, Math.max(1, Math.ceil(withF.length * 0.67))), ...without];
}
