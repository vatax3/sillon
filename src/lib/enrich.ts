// Spotify ne fournit plus ni audio-features ni genres fiables aux apps en mode dev.
// On les reconstruit à partir de services ouverts, avec cache persistant :
// - ReccoBeats : audio-features au format Spotify, par ID Spotify, sans clé.
// - Last.fm (clé gratuite, rapide) puis MusicBrainz (sans clé, 1 req/s) : tags d'artistes.
import { chunk, fetchWithRetry, isAbort, serverHeaders, throttledEach } from './http';
import type { Artist, ArtistTags, AudioFeatures, FeatureStore, TagStore } from './types';

export interface EnrichProgress {
  label: string;
  done: number;
  total: number;
}

// ---------- Audio features ----------

const RECCO = 'https://api.reccobeats.com/v1/audio-features';
const RECCO_BATCH = 40; // limite imposée par l'API

export async function fetchAudioFeatures(
  trackIds: string[],
  store: FeatureStore,
  onBatch: (patch: FeatureStore, p: EnrichProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const missing = trackIds.filter((id) => !(id in store));
  const batches = chunk(missing, RECCO_BATCH);
  let done = 0;
  await throttledEach(
    batches,
    async (ids) => {
      const res = await fetchWithRetry(`${RECCO}?ids=${ids.join(',')}`, { signal, headers: serverHeaders() });
      if (!res.ok) throw new Error(`ReccoBeats : ${res.status}`);
      const json: { content: (AudioFeatures & { href: string })[] } = await res.json();
      const patch: FeatureStore = Object.fromEntries(ids.map((id) => [id, null]));
      for (const row of json.content ?? []) {
        const id = row.href?.match(/track\/([A-Za-z0-9]+)/)?.[1];
        if (!id) continue;
        patch[id] = {
          acousticness: row.acousticness,
          danceability: row.danceability,
          energy: row.energy,
          instrumentalness: row.instrumentalness,
          liveness: row.liveness,
          loudness: row.loudness,
          speechiness: row.speechiness,
          tempo: row.tempo,
          valence: row.valence,
          key: row.key,
          mode: row.mode,
        };
      }
      done += ids.length;
      onBatch(patch, { label: 'Audio-features (ReccoBeats)', done, total: missing.length });
    },
    { concurrency: 2, minIntervalMs: 250, signal },
  );
}

// ---------- Tags d'artistes ----------

export const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

async function lastfmTags(name: string, apiKey: string, signal?: AbortSignal): Promise<string[] | null> {
  const params = new URLSearchParams({
    method: 'artist.gettoptags',
    artist: name,
    autocorrect: '1',
    api_key: apiKey,
    format: 'json',
  });
  const res = await fetchWithRetry(`https://ws.audioscrobbler.com/2.0/?${params}`, { signal, headers: serverHeaders() }, { retries: 2 });
  const json = await res.json();
  if (json.error === 10 || json.error === 26) throw new Error('Clé Last.fm invalide');
  if (json.error === 6) return null; // artiste inconnu
  if (json.error) throw new Error(`Last.fm indisponible (${json.error})`); // transitoire : retenté plus tard
  const tags: { name: string; count: number }[] = json.toptags?.tag ?? [];
  return tags.filter((t) => t.count >= 10).slice(0, 10).map((t) => t.name.toLowerCase());
}

async function musicbrainzTags(name: string, signal?: AbortSignal): Promise<string[] | null> {
  const query = `artist:"${name.replace(/"/g, '')}"`;
  const res = await fetchWithRetry(
    `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}&limit=5&fmt=json`,
    { signal, headers: serverHeaders() },
    { retries: 2 },
  );
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`); // transitoire : retenté plus tard
  const json: { artists?: { name: string; score: number; tags?: { name: string; count: number }[] }[] } =
    await res.json();
  const target = normalizeName(name);
  const match = json.artists?.find((a) => a.score >= 90 && normalizeName(a.name) === target);
  if (!match) return null;
  return (match.tags ?? [])
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((t) => t.name.toLowerCase());
}

/**
 * Récupère les tags des artistes, dans l'ordre fourni (mettre les plus présents en premier :
 * l'enrichissement est interruptible et reprend là où il s'était arrêté).
 */
export async function fetchArtistTags(
  artists: Artist[],
  store: TagStore,
  opts: { lastfmKey?: string },
  onItem: (id: string, tags: ArtistTags, p: EnrichProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const now = () => new Date().toISOString();
  // Les artistes pour lesquels on n'a trouvé qu'un résultat vide via MusicBrainz sont retentés
  // si une clé Last.fm a été ajoutée depuis.
  const todo = artists.filter((a) => {
    const known = store[a.id];
    if (!known) return true;
    return !!opts.lastfmKey && known.source !== 'lastfm' && known.source !== 'spotify' && known.tags.length === 0;
  });
  let done = 0;
  const report = (a: Artist, tags: ArtistTags) =>
    onItem(a.id, tags, {
      label: opts.lastfmKey ? 'Genres (Last.fm)' : 'Genres (MusicBrainz, ~1 artiste/s)',
      done: ++done,
      total: todo.length,
    });

  const needFetch: Artist[] = [];
  for (const a of todo) {
    if (a.spotifyGenres?.length) report(a, { tags: a.spotifyGenres, source: 'spotify', fetchedAt: now() });
    else needFetch.push(a);
  }

  const useLastfm = !!opts.lastfmKey;
  await throttledEach(
    needFetch,
    async (a) => {
      try {
        let tags: string[] | null = null;
        let source: ArtistTags['source'] = 'none';
        if (useLastfm) {
          tags = await lastfmTags(a.name, opts.lastfmKey!, signal);
          if (tags?.length) source = 'lastfm';
        } else {
          tags = await musicbrainzTags(a.name, signal);
          if (tags?.length) source = 'musicbrainz';
        }
        report(a, { tags: tags ?? [], source, fetchedAt: now() });
      } catch (e) {
        if (isAbort(e) || (e instanceof Error && e.message === 'Clé Last.fm invalide')) throw e;
        // Erreur réseau ponctuelle : on laisse l'artiste pour une prochaine passe.
      }
    },
    useLastfm
      ? { concurrency: 4, minIntervalMs: 220, signal }
      : { concurrency: 1, minIntervalMs: 1100, signal },
  );
}
