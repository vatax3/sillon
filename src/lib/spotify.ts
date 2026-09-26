// Client Web API Spotify, aligné sur les règles « Development Mode » de 2026 :
// - pas d'endpoints batch (GET /artists?ids=…), pas d'audio-features, pas de popularité ;
// - playlists : /me/playlists (création) et /playlists/{id}/items (contenu) ;
// - le contenu n'est lisible que pour les playlists possédées ou collaboratives.
import { getAccessToken } from './auth';
import { chunk, fetchWithRetry, HttpError } from './http';
import type { TimeRange } from './types';

const BASE = 'https://api.spotify.com/v1';

async function authHeaders(force = false): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getAccessToken(force)}`,
    'Content-Type': 'application/json',
  };
}

export async function api<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await fetchWithRetry(
    url,
    { ...init, signal, headers: { ...(await authHeaders()), ...init.headers } },
    { onUnauthorized: async () => ({ ...init, signal, headers: await authHeaders(true) }) },
  );
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body?.error?.message || message;
    } catch {
      /* corps vide */
    }
    if (res.status === 403 && /premium/i.test(message)) message = 'Cette action nécessite Spotify Premium.';
    else if (res.status === 403) message += ' — ton compte est-il bien ajouté aux utilisateurs de l’app (Dashboard > User Management) ?';
    if (res.status === 404 && url.includes('/me/player')) message = 'Aucun appareil Spotify actif : ouvre Spotify sur ton téléphone ou ordinateur.';
    throw new HttpError(res.status, `Spotify : ${message}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface Page<T> {
  items: T[];
  next: string | null;
  total?: number;
}

/** Parcourt toutes les pages d'un endpoint paginé. */
export async function paginate<T>(
  path: string,
  onPage?: (loaded: number, total?: number) => void,
  signal?: AbortSignal,
  unwrap?: (json: any) => Page<T>,
): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = path;
  while (url) {
    const json: any = await api<any>(url, {}, signal);
    const page: Page<T> = unwrap ? unwrap(json) : json;
    all.push(...(page.items ?? []));
    onPage?.(all.length, page.total);
    url = page.next;
  }
  return all;
}

// ---- Objets bruts (sous-ensemble utile) ----

export interface RawArtist {
  id: string;
  name: string;
  genres?: string[] | null;
}

export interface RawTrack {
  id: string | null;
  uri: string;
  name: string;
  type?: string;
  is_local?: boolean;
  duration_ms: number;
  explicit: boolean;
  external_ids?: { isrc?: string };
  artists: { id: string | null; name: string }[];
  album: { id: string; name: string; release_date: string; total_tracks?: number; images?: { url: string; width?: number }[] };
}

export interface RawPlaylist {
  id: string;
  name: string;
  collaborative: boolean;
  owner: { id: string };
  images?: { url: string }[] | null;
  items?: { total: number };
  /** Ancien nom du champ, gardé pour les apps en Extended Quota. */
  tracks?: { total: number };
}

// ---- Endpoints ----

export const getMe = () =>
  api<{ id: string; display_name: string | null; images?: { url: string }[] }>('/me');

export const getSavedTracks = (onPage?: (n: number, t?: number) => void, signal?: AbortSignal) =>
  paginate<{ added_at: string; track: RawTrack }>('/me/tracks?limit=50', onPage, signal);

export const getMyPlaylists = (signal?: AbortSignal) =>
  paginate<RawPlaylist | null>('/me/playlists?limit=50', undefined, signal);

export async function getPlaylistTracks(id: string, signal?: AbortSignal): Promise<RawTrack[]> {
  const rows = await paginate<{ item?: RawTrack | null; track?: RawTrack | null }>(
    `/playlists/${id}/items?limit=50&additional_types=track`,
    undefined,
    signal,
  );
  return rows.map((r) => r.item ?? r.track).filter((t): t is RawTrack => !!t);
}

/** Métadonnées d'une playlist (nom, description, version). */
export async function getPlaylistMeta(id: string) {
  return api<{ id: string; name: string; description: string | null; snapshot_id: string; public: boolean | null; collaborative: boolean; owner: { id: string } }>(
    `/playlists/${id}?fields=id,name,description,snapshot_id,public,collaborative,owner(id)`,
  );
}

export interface PlaylistEntry {
  uri: string;
  id?: string;
  name: string;
  artists: string;
  image?: string;
  durationMs: number;
  kind: 'track' | 'episode' | 'local';
}

/** Contenu complet d'une playlist, épisodes et fichiers locaux compris (pour l'éditeur). */
export async function getPlaylistEntries(id: string, signal?: AbortSignal): Promise<PlaylistEntry[]> {
  type Raw = RawTrack & { show?: { name: string }; images?: { url: string }[] };
  const rows = await paginate<{ item?: Raw | null; track?: Raw | null; is_local?: boolean }>(`/playlists/${id}/items?limit=50&additional_types=track,episode`, undefined, signal);
  return rows
    .map((r) => r.item ?? r.track)
    .filter((t): t is Raw => !!t)
    .map((t) => {
      const kind: PlaylistEntry['kind'] = t.is_local || t.uri.startsWith('spotify:local:') ? 'local' : t.type === 'episode' ? 'episode' : 'track';
      const images = t.album?.images ?? t.images ?? [];
      return {
        uri: t.uri,
        id: kind === 'local' ? undefined : (t.id ?? undefined),
        name: t.name,
        artists: kind === 'episode' ? (t.show?.name ?? 'Podcast') : (t.artists ?? []).map((a) => a.name).join(', '),
        image: [...images].sort((a, b) => ((a as { width?: number }).width ?? 0) - ((b as { width?: number }).width ?? 0))[0]?.url,
        durationMs: t.duration_ms,
        kind,
      };
    });
}

export async function getTop<T extends 'tracks' | 'artists'>(
  type: T,
  range: TimeRange,
  signal?: AbortSignal,
): Promise<T extends 'tracks' ? RawTrack[] : RawArtist[]> {
  // Le top est plafonné à 50 éléments par période en mode dev ; une page suffit.
  const page = await api<Page<any>>(`/me/top/${type}?limit=50&time_range=${range}`, {}, signal);
  return page.items;
}

export async function getRecentlyPlayed(signal?: AbortSignal) {
  const page = await api<Page<{ played_at: string; track: RawTrack }>>(
    '/me/player/recently-played?limit=50',
    {},
    signal,
  );
  return page.items;
}

export const getFollowedArtists = (signal?: AbortSignal) =>
  paginate<RawArtist>('/me/following?type=artist&limit=50', undefined, signal, (json) => json.artists);

export async function createPlaylist(name: string, description: string, isPublic: boolean) {
  return api<{ id: string; external_urls: { spotify: string } }>('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, description, public: isPublic }),
  });
}

export async function updatePlaylistDetails(id: string, name: string, description: string) {
  await api(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify({ name, description }) });
}

/** Remplace tout le contenu d'une playlist (PUT limité à 100 URIs, le reste en POST). */
export async function setPlaylistItems(id: string, uris: string[]) {
  const [first = [], ...rest] = chunk(uris, 100);
  await api(`/playlists/${id}/items`, { method: 'PUT', body: JSON.stringify({ uris: first }) });
  for (const part of rest) {
    await api(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify({ uris: part }) });
  }
}

export async function addPlaylistItems(id: string, uris: string[]) {
  for (const part of chunk(uris, 100)) {
    await api(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify({ uris: part }) });
  }
}

// ---- Bibliothèque (endpoints génériques de 2026, URIs en query, 40 max) ----

/** Like des titres / suit des artistes : `spotify:track:…`, `spotify:artist:…`. */
export async function saveToLibrary(uris: string[]) {
  for (const part of chunk(uris, 40)) {
    await api(`/me/library?uris=${part.map(encodeURIComponent).join(',')}`, { method: 'PUT' });
  }
}

// ---- Catalogue ----

export interface SimpleAlbum {
  id: string;
  uri: string;
  name: string;
  album_type: 'album' | 'single' | 'compilation';
  release_date: string;
  total_tracks: number;
  images?: { url: string; width?: number }[];
  artists: { id: string; name: string }[];
}

/** Dernières sorties d'un artiste (la limite est de 10 par page en mode dev). */
export async function getArtistReleases(id: string, group: 'album' | 'single', signal?: AbortSignal) {
  const page = await api<Page<SimpleAlbum>>(`/artists/${id}/albums?include_groups=${group}&limit=5`, {}, signal);
  return page.items;
}

export async function getAlbumTracks(id: string, signal?: AbortSignal) {
  const page = await api<Page<{ id: string; uri: string; name: string }>>(`/albums/${id}/tracks?limit=50`, {}, signal);
  return page.items;
}

/** Recherche de titres (10 résultats max en mode dev). */
export async function searchTracks(q: string, limit = 5, signal?: AbortSignal): Promise<RawTrack[]> {
  const json = await api<{ tracks: Page<RawTrack> }>(
    `/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`,
    {},
    signal,
  );
  return json.tracks?.items ?? [];
}

// ---- Lecteur (Spotify Connect, nécessite Premium) ----

export interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
}

export interface PlaybackState {
  is_playing: boolean;
  progress_ms: number | null;
  device: Device;
  shuffle_state: boolean;
  item: RawTrack | null;
}

/** undefined quand aucun appareil n'est actif (réponse 204). */
export const getPlayback = () => api<PlaybackState | undefined>('/me/player');
export const getDevices = async () => (await api<{ devices: Device[] }>('/me/player/devices')).devices;

export async function play(opts: { uris?: string[]; contextUri?: string; offset?: number; deviceId?: string }) {
  const q = opts.deviceId ? `?device_id=${opts.deviceId}` : '';
  const body: Record<string, unknown> = {};
  // Au-delà de quelques centaines d'URIs la requête est refusée : on démarre avec un lot raisonnable.
  if (opts.uris) body.uris = opts.uris.slice(0, 200);
  if (opts.contextUri) body.context_uri = opts.contextUri;
  if (opts.offset !== undefined) body.offset = { position: opts.offset };
  await api(`/me/player/play${q}`, { method: 'PUT', body: JSON.stringify(body) });
}
export const pause = () => api('/me/player/pause', { method: 'PUT' });
export const resume = () => api('/me/player/play', { method: 'PUT' });
export const nextTrack = () => api('/me/player/next', { method: 'POST' });
export const previousTrack = () => api('/me/player/previous', { method: 'POST' });
export const queue = (uri: string) => api(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
export const transferPlayback = (deviceId: string) =>
  api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) });

export const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;
export const trackUrl = (id: string) => `https://open.spotify.com/track/${id}`;
export const albumUrl = (id: string) => `https://open.spotify.com/album/${id}`;
export const artistUrl = (id: string) => `https://open.spotify.com/artist/${id}`;
