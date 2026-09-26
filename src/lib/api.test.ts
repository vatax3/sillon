// Tests d'intégration du client Spotify contre une fausse API (fetch simulé) :
// pagination, reprise sur 429, lots de 100 / 40, formats 2026 (items/item), fichiers locaux, erreurs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getAccessToken: vi.fn(async () => 'fake-token') }));

import * as sp from './spotify';
import { syncLibrary } from './sync';

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body?: unknown;
}

const BASE = 'https://api.spotify.com/v1';

const track = (id: string, artist = 'ar1', extra: Record<string, unknown> = {}) => ({
  id,
  uri: `spotify:track:${id}`,
  name: `Titre ${id}`,
  type: 'track',
  duration_ms: 200_000,
  explicit: false,
  external_ids: { isrc: `ISRC${id}` },
  artists: [{ id: artist, name: `Artiste ${artist}` }],
  album: { id: `al-${id}`, name: 'Album', release_date: '2019-05-01', total_tracks: 10, images: [{ url: 'https://i/640', width: 640 }, { url: 'https://i/64', width: 64 }] },
  ...extra,
});

function fakeSpotify(handlers: Record<string, (c: Call, n: number) => { status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const hits = new Map<string, number>();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname.replace('/v1', ''), search: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    const handler = handlers[key];
    if (!handler) return new Response(JSON.stringify({ error: { status: 404, message: `pas de route ${key}` } }), { status: 404 });
    const { status = 200, json, headers } = handler(call, n);
    return new Response(json === undefined ? '' : JSON.stringify(json), { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('synchronisation complète', () => {
  it('parcourt toutes les sources, gère la pagination et un 429', async () => {
    const { calls } = fakeSpotify({
      'GET /me': () => ({ json: { id: 'me', display_name: 'Moi', images: [] } }),
      'GET /me/tracks': (c) => {
        // Page 2 : d'abord un 429 (limite de débit), puis la réponse.
        if (c.search.get('offset') === '50') {
          const retried = calls.filter((x) => x.path === '/me/tracks' && x.search.get('offset') === '50').length;
          if (retried === 1) return { status: 429, headers: { 'Retry-After': '0.01' } };
          return { json: { items: [{ added_at: '2024-02-01T00:00:00Z', track: track('t3') }], next: null, total: 51 } };
        }
        return {
          json: {
            items: [
              { added_at: '2024-01-01T00:00:00Z', track: track('t1') },
              { added_at: '2024-01-02T00:00:00Z', track: track('t2', 'ar2') },
            ],
            next: `${BASE}/me/tracks?offset=50&limit=50`,
            total: 51,
          },
        };
      },
      'GET /me/playlists': () => ({
        json: {
          items: [
            { id: 'p1', name: 'À moi', collaborative: false, owner: { id: 'me' }, images: [], items: { total: 4 } },
            { id: 'p2', name: 'Pas à moi', collaborative: false, owner: { id: 'other' }, images: [], items: { total: 10 } },
            null,
          ],
          next: null,
        },
      }),
      'GET /playlists/p1/items': () => ({
        json: {
          items: [
            { item: track('t1') },
            { item: track('t4', 'ar2') },
            { item: { ...track('local'), id: null, uri: 'spotify:local:a:b:c:180', is_local: true } },
            { item: { ...track('ep1'), type: 'episode', uri: 'spotify:episode:ep1' } },
            { item: track('t1') },
          ],
          next: null,
        },
      }),
      'GET /me/top/tracks': (c) => ({ json: { items: c.search.get('time_range') === 'short_term' ? [track('t2', 'ar2'), track('t5')] : [] } }),
      'GET /me/top/artists': (c) => ({ json: { items: c.search.get('time_range') === 'long_term' ? [{ id: 'ar1', name: 'Artiste ar1', genres: null }] : [] } }),
      'GET /me/player/recently-played': () => ({ json: { items: [{ played_at: '2026-09-20T10:00:00Z', track: track('t4', 'ar2') }], next: null } }),
      'GET /me/following': () => ({ json: { artists: { items: [{ id: 'ar2', name: 'Artiste ar2', genres: ['french pop'] }], next: null } } }),
    });

    const progress: string[] = [];
    const lib = await syncLibrary({ excludePlaylistIds: new Set() }, (p) => progress.push(p.label));

    expect(Object.keys(lib.tracks).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(lib.tracks.t3.likedAt).toBe('2024-02-01T00:00:00Z'); // page obtenue après le 429
    expect(lib.tracks.t1.album).toMatchObject({ image: 'https://i/64', totalTracks: 10 });
    expect(lib.tracks.t2.topRanks).toEqual({ short_term: 1 });
    expect(lib.tracks.t4.lastPlayedAt).toBe('2026-09-20T10:00:00Z');
    // Fichier local et épisode ignorés ; le doublon t1 est gardé dans l'ordre de la playlist.
    expect(lib.playlistItems).toEqual({ p1: ['t1', 't4', 't1'] });
    expect(lib.tracks.t1.playlists).toEqual(['p1']);
    // La playlist d'un autre utilisateur n'est pas lue (interdit en mode dev).
    expect(lib.playlists.find((p) => p.id === 'p2')?.synced).toBe(false);
    expect(calls.some((c) => c.path === '/playlists/p2/items')).toBe(false);
    expect(lib.artists.ar1.topRanks).toEqual({ long_term: 1 });
    expect(lib.artists.ar2).toMatchObject({ followed: true, spotifyGenres: ['french pop'] });
    expect(calls.filter((c) => c.path === '/me/tracks')).toHaveLength(3);
    expect(progress).toContain('Titres likés');
  });

  it('exclut les playlists vivantes de la synchro', async () => {
    const { calls } = fakeSpotify({
      'GET /me': () => ({ json: { id: 'me', display_name: 'Moi' } }),
      'GET /me/tracks': () => ({ json: { items: [], next: null } }),
      'GET /me/playlists': () => ({ json: { items: [{ id: 'live', name: 'Vivante', collaborative: false, owner: { id: 'me' }, items: { total: 3 } }], next: null } }),
      'GET /me/top/tracks': () => ({ json: { items: [] } }),
      'GET /me/top/artists': () => ({ json: { items: [] } }),
      'GET /me/player/recently-played': () => ({ json: { items: [] } }),
      'GET /me/following': () => ({ json: { artists: { items: [], next: null } } }),
    });
    const lib = await syncLibrary({ excludePlaylistIds: new Set(['live']) }, () => {});
    expect(lib.playlists[0].synced).toBe(false);
    expect(calls.some((c) => c.path === '/playlists/live/items')).toBe(false);
  });
});

describe('écritures', () => {
  it('remplace une playlist par lots de 100 (PUT puis POST)', async () => {
    const { calls } = fakeSpotify({
      'PUT /playlists/p1/items': () => ({ json: { snapshot_id: 's1' } }),
      'POST /playlists/p1/items': () => ({ status: 201, json: { snapshot_id: 's2' } }),
    });
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:x${i}`);
    await sp.setPlaylistItems('p1', uris);
    expect(calls.map((c) => `${c.method} ${(c.body as { uris: string[] }).uris.length}`)).toEqual(['PUT 100', 'POST 100', 'POST 50']);
    expect((calls[2].body as { uris: string[] }).uris.at(-1)).toBe('spotify:track:x249');
  });

  it('vide une playlist avec un PUT vide', async () => {
    const { calls } = fakeSpotify({ 'PUT /playlists/p1/items': () => ({ json: { snapshot_id: 's' } }) });
    await sp.setPlaylistItems('p1', []);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ uris: [] });
  });

  it('like / suit par lots de 40 URIs en query', async () => {
    const { calls } = fakeSpotify({ 'PUT /me/library': () => ({}) });
    await sp.saveToLibrary(Array.from({ length: 90 }, (_, i) => `spotify:track:t${i}`));
    expect(calls).toHaveLength(3);
    expect(calls[0].search.get('uris')!.split(',')).toHaveLength(40);
    expect(calls[2].search.get('uris')!.split(',')[0]).toBe('spotify:track:t80');
  });
});

describe('lecture pour l’éditeur et erreurs', () => {
  it('lit le contenu complet, épisodes et fichiers locaux compris', async () => {
    fakeSpotify({
      'GET /playlists/p1/items': () => ({
        json: {
          items: [
            { item: track('t1') },
            { item: { ...track('x'), id: null, uri: 'spotify:local:Artiste:Album:Titre:200', is_local: true } },
            { item: { id: 'ep', uri: 'spotify:episode:ep', name: 'Épisode', type: 'episode', duration_ms: 1000, show: { name: 'Mon podcast' }, images: [{ url: 'https://i/ep' }] } },
          ],
          next: null,
        },
      }),
    });
    const entries = await sp.getPlaylistEntries('p1');
    expect(entries.map((e) => e.kind)).toEqual(['track', 'local', 'episode']);
    expect(entries[1].id).toBeUndefined();
    expect(entries[2]).toMatchObject({ artists: 'Mon podcast', image: 'https://i/ep' });
    expect(entries[0].image).toBe('https://i/64');
  });

  it('traduit les erreurs utiles', async () => {
    fakeSpotify({
      'PUT /me/player/play': () => ({ status: 403, json: { error: { status: 403, message: 'Player command failed: Premium required' } } }),
      'GET /me/player': () => ({ status: 404, json: { error: { status: 404, message: 'Not found' } } }),
      'GET /me/tracks': () => ({ status: 403, json: { error: { status: 403, message: 'Forbidden' } } }),
    });
    await expect(sp.play({ uris: ['spotify:track:a'] })).rejects.toThrow('nécessite Spotify Premium');
    await expect(sp.getPlayback()).rejects.toThrow('Aucun appareil Spotify actif');
    await expect(sp.getSavedTracks()).rejects.toThrow('User Management');
  });

  it('abandonne après plusieurs 5xx', async () => {
    const { calls } = fakeSpotify({ 'GET /me': () => ({ status: 503, headers: { 'Retry-After': '0.01' } }) });
    await expect(sp.getMe()).rejects.toThrow('503');
    expect(calls).toHaveLength(6); // 1 essai + 5 reprises
  });
});
