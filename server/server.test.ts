// Tests du serveur : API HTTP (via app.request, sans réseau), tâches planifiées contre de fausses
// API Spotify / Deezer / ntfy, planification et gestion des jetons.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillon-test-'));
process.env.SPOTIFY_CLIENT_ID = 'test-client';
process.env.DATA_DIR = dataDir;
process.env.BASE_URL = 'https://sillon.example.com';
process.env.TZ = 'Europe/Paris';
// Interface factice, avec un dossier voisin au nom proche qui ne doit jamais être servi.
process.env.STATIC_DIR = path.join(dataDir, 'dist');
fs.mkdirSync(path.join(dataDir, 'dist'));
fs.writeFileSync(path.join(dataDir, 'dist', 'index.html'), '<title>Sillon</title>');
fs.mkdirSync(path.join(dataDir, 'dist-server'));
fs.writeFileSync(path.join(dataDir, 'dist-server', 'secret.txt'), 'secret');

type Db = typeof import('./db');
type Sched = typeof import('./scheduler');
let db: Db;
let sched: Sched;
let app: (typeof import('./index'))['app'];
let serialize: typeof import('../src/lib/serialize');

const U = 'alice';
const SID = 'session-alice';

beforeAll(async () => {
  db = await import('./db');
  sched = await import('./scheduler');
  app = (await import('./index')).app;
  serialize = await import('../src/lib/serialize');
  db.upsertUser({ id: U, name: 'Alice', refreshToken: 'rt', accessToken: 'at-valid', expiresAt: Date.now() + 3_600_000, scope: 'x' });
  db.createSession(SID, U);
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => vi.unstubAllGlobals());

const req = (p: string, init: RequestInit & { csrf?: boolean } = {}) =>
  app.request(p, { ...init, headers: { Cookie: `sillon_sid=${SID}`, ...(init.csrf === false ? {} : { 'X-Sillon': '1' }), ...(init.headers ?? {}) } });

// ---------- Fausses API ----------

type Handler = (url: URL, init: RequestInit | undefined) => { status?: number; json?: unknown } | undefined;
function fakeNet(handler: Handler) {
  const calls: { method: string; url: URL; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined });
      const r = handler(url, init);
      if (!r) return new Response(JSON.stringify({ error: { message: `non simulé : ${url}` } }), { status: 404 });
      return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const rawTrack = (id: string, name: string, artist: string) => ({
  id,
  uri: `spotify:track:${id}`,
  name,
  type: 'track',
  duration_ms: 200_000,
  explicit: false,
  artists: [{ id: `ar-${artist}`, name: artist }],
  album: { id: `al-${id}`, name: 'Album', release_date: '2020-01-01', images: [] },
});

function seedLibrary() {
  const tracks: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    tracks[`t${i}`] = {
      id: `t${i}`, uri: `spotify:track:t${i}`, name: `Mine ${i}`, artists: [{ id: 'seed', name: 'Seed Artist' }],
      album: { id: 'al', name: 'Al', releaseDate: '2015-01-01' }, durationMs: 200_000, explicit: false, playlists: [], topRanks: {}, likedAt: '2024-01-01T00:00:00Z',
    };
  }
  db.putDoc(U, 'library', {
    user: { id: U, name: 'Alice' },
    tracks,
    artists: { seed: { id: 'seed', name: 'Seed Artist', topRanks: { short_term: 1, long_term: 1 }, followed: true } },
    playlists: [],
    playlistItems: {},
    syncedAt: new Date().toISOString(),
  });
}

// ---------- API ----------

describe('API', () => {
  it('config publique, puis 401 sans session', async () => {
    const conf = await (await app.request('/api/config')).json();
    expect(conf).toMatchObject({ mode: 'server', user: null });
    expect((await app.request('/api/revs')).status).toBe(401);
    const mine = await (await req('/api/config')).json();
    expect(mine.user).toMatchObject({ id: U, name: 'Alice' });
  });

  it('sert l’interface sans jamais sortir de son dossier', async () => {
    expect(await (await app.request('/une/page')).text()).toContain('<title>Sillon');
    for (const p of ['/%2e%2e/dist-server/secret.txt', '/..%2fdist-server%2fsecret.txt']) {
      expect(await (await app.request(p)).text()).not.toContain('secret');
    }
    expect((await app.request('/%E0%A4%A')).status).toBe(400);
  });

  it('donne un jeton valide sans appel réseau', async () => {
    const calls = fakeNet(() => undefined);
    const t = await (await req('/api/token')).json();
    expect(t.accessToken).toBe('at-valid');
    expect(calls).toHaveLength(0);
  });

  it('écrit et relit un document, avec contrôle de version', async () => {
    const put = await req('/api/kv/saved', { method: 'PUT', body: serialize.encode([{ spotifyId: 'p1' }]) });
    expect(put.status).toBe(200);
    const { rev } = await put.json();
    const get = await req('/api/kv/saved');
    expect(get.headers.get('X-Rev')).toBe(String(rev));
    expect(await get.json()).toEqual([{ spotifyId: 'p1' }]);
    // Écriture basée sur une version périmée : refusée.
    const stale = await req('/api/kv/saved', { method: 'PUT', body: '[]', headers: { 'If-Match': String(rev - 1) } });
    expect(stale.status).toBe(409);
    const ok = await req('/api/kv/saved', { method: 'PUT', body: '[]', headers: { 'If-Match': String(rev) } });
    expect(ok.status).toBe(200);
  });

  it('protège les écritures (CSRF) et les documents du serveur', async () => {
    expect((await req('/api/kv/saved', { method: 'PUT', body: '[]', csrf: false })).status).toBe(403);
    expect((await req('/api/kv/history', { method: 'PUT', body: '{}' })).status).toBe(403);
    expect((await req('/api/kv/evil', { method: 'GET' })).status).toBe(404);
  });

  it('importe un historique par lots, sans doublon', async () => {
    const plays = Array.from({ length: 5 }, (_, i) => ({ ts: Date.UTC(2024, 0, i + 1), ms: 200_000, uri: `spotify:track:t${i}`, name: `Mine ${i}`, artist: 'Seed Artist', album: 'Al', flags: 0 }));
    const r1 = await (await req('/api/history/import', { method: 'POST', body: JSON.stringify({ plays, files: ['a.json'] }) })).json();
    const r2 = await (await req('/api/history/import', { method: 'POST', body: JSON.stringify({ plays, files: ['a.json'] }) })).json();
    expect(r1).toEqual({ added: 5, total: 5 });
    expect(r2).toEqual({ added: 0, total: 5 });
    const h = serialize.decode<{ ts: Float64Array }>(await (await req('/api/kv/history')).text());
    expect(h.ts).toBeInstanceOf(Float64Array);
    expect(h.ts.length).toBe(5);
  });
});

// ---------- Tâches ----------

describe('tâches', () => {
  it('relève les écoutes récentes', async () => {
    fakeNet((url) =>
      url.pathname === '/v1/me/player/recently-played'
        ? { json: { items: [{ played_at: new Date().toISOString(), track: rawTrack('t9', 'Mine 9', 'Seed Artist') }] } }
        : undefined,
    );
    await sched.runJob(U, 'record', 'manual');
    const run = db.listRuns(U)[0];
    expect(run).toMatchObject({ kind: 'record', status: 'ok' });
    expect(run.message).toContain('1 nouvelle');
  });

  it('découvertes : crée la playlist, la réutilise, ne repropose jamais les mêmes titres', async () => {
    seedLibrary();
    db.putDoc(U, 'automations', { discoveries: { enabled: true, schedule: { freq: 'weekly', day: 1, hour: 7 }, name: 'Découvertes', size: 4, seed: 'recent', unknownOnly: true } });
    let created = 0;
    const setItems: string[][] = [];
    const deezerTop = (artist: string) => ({ data: [1, 2, 3, 4].map((n) => ({ id: n, title: `${artist} hit ${n}`, duration: 200, preview: '', artist: { id: 9, name: artist }, album: { id: 1, title: 'A' } })) });
    const calls = fakeNet((url, init) => {
      const m = init?.method ?? 'GET';
      if (url.hostname === 'api.deezer.com') {
        if (url.pathname === '/search/artist') return { json: { data: [{ id: 1, name: 'Seed Artist' }] } };
        if (url.pathname === '/artist/1/related') return { json: { data: [{ id: 2, name: 'New One' }, { id: 3, name: 'New Two' }] } };
        if (url.pathname === '/artist/2/top') return { json: deezerTop('New One') };
        if (url.pathname === '/artist/3/top') return { json: deezerTop('New Two') };
      }
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q')!;
        const [, title, artist] = q.match(/track:"(.+)" artist:"(.+)"/)!;
        return { json: { tracks: { items: [rawTrack(title.replace(/\W+/g, '_'), title, artist)], next: null } } };
      }
      if (url.pathname === '/v1/me/playlists' && m === 'POST') {
        created++;
        return { status: 201, json: { id: 'auto-disc', external_urls: { spotify: '' } } };
      }
      if (url.pathname === '/v1/playlists/auto-disc' && m === 'GET') return { json: { id: 'auto-disc', name: 'Découvertes', description: '', snapshot_id: 's', owner: { id: U } } };
      if (url.pathname === '/v1/playlists/auto-disc' && m === 'PUT') return { json: {} };
      if (url.pathname === '/v1/playlists/auto-disc/items' && m === 'PUT') {
        setItems.push(JSON.parse(String(init!.body)).uris);
        return { json: { snapshot_id: 'x' } };
      }
      return undefined;
    });

    await sched.runJob(U, 'discoveries', 'manual');
    expect(db.listRuns(U)[0]).toMatchObject({ kind: 'discoveries', status: 'ok' });
    await sched.runJob(U, 'discoveries', 'manual');
    expect(db.listRuns(U)[0]).toMatchObject({ kind: 'discoveries', status: 'ok' });

    expect(created).toBe(1); // playlist créée une seule fois, puis réutilisée
    expect(setItems).toHaveLength(2);
    expect(setItems[0]).toHaveLength(4);
    // Semaine 2 : uniquement des titres jamais proposés.
    expect(setItems[1].some((u) => setItems[0].includes(u))).toBe(false);
    expect(calls.some((c) => c.url.pathname === '/v1/playlists/auto-disc' && c.method === 'PUT')).toBe(true);
  });

  it('radar : playlist des sorties et notification des nouveautés seulement', async () => {
    db.putDoc(U, 'automations', {
      radar: { enabled: true, schedule: { freq: 'weekly', day: 5, hour: 8 }, name: 'Radar', days: 30, albumTracks: 'first3' },
      notifications: { ntfyUrl: 'https://ntfy.example/sillon', discordUrl: '', webhookUrl: '', onReleases: true, onPlaylists: false, onFailures: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    const notifs: string[] = [];
    fakeNet((url, init) => {
      const m = init?.method ?? 'GET';
      if (url.hostname === 'ntfy.example') {
        notifs.push(url.searchParams.get('title')!);
        return { json: {} };
      }
      if (url.pathname === '/v1/artists/seed/albums') {
        const group = url.searchParams.get('include_groups');
        const items = group === 'album' ? [{ id: 'alb1', uri: 'spotify:album:alb1', name: 'Grand Album', album_type: 'album', release_date: today, total_tracks: 10, artists: [{ id: 'seed', name: 'Seed Artist' }] }] : [{ id: 'old', uri: 'spotify:album:old', name: 'Vieux single', album_type: 'single', release_date: '2019-01-01', total_tracks: 1, artists: [] }];
        return { json: { items, next: null } };
      }
      if (url.pathname === '/v1/albums/alb1/tracks') return { json: { items: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, uri: `spotify:track:a${i}`, name: `t${i}` })), next: null } };
      if (url.pathname === '/v1/me/playlists' && m === 'POST') return { status: 201, json: { id: 'auto-radar' } };
      if (url.pathname === '/v1/playlists/auto-radar/items') return { json: {} };
      if (url.pathname === '/v1/playlists/auto-radar') return { json: { id: 'auto-radar', name: 'Radar', snapshot_id: 's', owner: { id: U } } };
      return undefined;
    });
    await sched.runJob(U, 'radar', 'manual');
    expect(db.listRuns(U)[0]).toMatchObject({ kind: 'radar', status: 'ok', message: '1 sorties (1 nouvelles), 3 titres' });
    await sched.runJob(U, 'radar', 'manual');
    expect(db.listRuns(U)[0].message).toContain('(0 nouvelles)');
    expect(notifs).toEqual(['1 nouvelle(s) sortie(s)']); // une seule notification pour la même sortie
  });

  it('notifie les échecs et les consigne', async () => {
    const notifs: string[] = [];
    fakeNet((url) => {
      if (url.hostname === 'ntfy.example') {
        notifs.push(url.searchParams.get('title')!);
        return { json: {} };
      }
      return undefined;
    });
    db.deleteDoc(U, 'history');
    await sched.runJob(U, 'monthlyTop', 'manual');
    expect(db.listRuns(U)[0]).toMatchObject({ kind: 'monthlyTop', status: 'error' });
    expect(notifs).toEqual(['Échec : Top du mois']);
  });

  it('sauvegarde : export JSON sur disque, réimportable, avec rétention', async () => {
    await sched.runJob(U, 'backup', 'manual');
    expect(db.listRuns(U)[0]).toMatchObject({ kind: 'backup', status: 'ok' });
    const dir = path.join(dataDir, 'exports', U);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const exp = serialize.decode<{ app: string; docs: Record<string, unknown> }>(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(exp.app).toBe('sillon');
    expect(Object.keys(exp.docs)).toContain('library');
  });
});

// ---------- Planification et jetons ----------

describe('planification', () => {
  it('planifie selon la configuration et replanifie à chaque changement', () => {
    db.putDoc(U, 'automations', { recordHistory: true, discoveries: { enabled: true, schedule: { freq: 'weekly', day: 1, hour: 7 } } });
    sched.startScheduler();
    const next = sched.nextRuns(U);
    const disc = next.find((n) => n.kind === 'discoveries')!;
    const d = new Date(disc.at);
    // Lundi 7h, heure de Paris.
    expect(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', hour: 'numeric' }).format(d)).toBe('lundi 07 h');
    expect(next.some((n) => n.kind === 'record')).toBe(true);
    // Une playlist vivante planifiée apparaît dès qu'elle est enregistrée.
    db.putDoc(U, 'saved', [{ spotifyId: 'live1', name: 'V', description: '', rule: {}, createdAt: '', updatedAt: '', trackCount: 0, isPublic: false, schedule: { freq: 'daily', day: 1, hour: 6 } }]);
    expect(sched.nextRuns(U).some((n) => n.kind === 'living' && n.target === 'live1')).toBe(true);
    sched.stopScheduler();
  });

  it('ne lance jamais l’enrichissement pendant une synchro', async () => {
    // Spotify ne répond pas : la synchro reste en cours jusqu'à son annulation.
    vi.stubGlobal('fetch', vi.fn((_: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const sync = sched.runJob(U, 'sync', 'manual');
    await new Promise((r) => setTimeout(r, 10));
    expect(await sched.runJob(U, 'enrich', 'manual')).toBeNull();
    expect(sched.cancelJob(U, sched.runningRuns(U)[0])).toBe(true);
    await sync;
    expect(db.listRuns(U)[0]).toMatchObject({ kind: 'sync', status: 'error', message: 'Arrêtée' });
  });

  it('marque le compte à reconnecter si Spotify révoque l’accès', async () => {
    db.upsertUser({ id: 'bob', name: 'Bob', refreshToken: 'revoked', accessToken: 'old', expiresAt: 0 });
    fakeNet((url) => (url.hostname === 'accounts.spotify.com' ? { status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token revoked' } } : undefined));
    const { userAccessToken } = await import('./auth');
    await expect(userAccessToken('bob')).rejects.toThrow('revoked');
    expect(db.getUser('bob')?.needs_reauth).toBe(1);
    // Les tâches planifiées d'un compte à reconnecter ne tournent plus.
    expect(await sched.runJob('bob', 'record', 'schedule')).toBeNull();
  });
});
