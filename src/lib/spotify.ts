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
    if (res.status === 403) message += ' — ton compte est-il bien ajouté aux utilisateurs de l’app (Dashboard > User Management) ?';
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
  album: { id: string; name: string; release_date: string; images?: { url: string; width?: number }[] };
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

export const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;
export const trackUrl = (id: string) => `https://open.spotify.com/track/${id}`;
