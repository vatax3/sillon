// Worker d'enregistrement des écoutes pour Sillon.
// L'API Spotify ne renvoie que les 50 dernières écoutes : ce worker les relève toutes les 30 minutes
// et les stocke dans KV, par mois. L'app les récupère via GET /plays.
//
// Il a sa propre session Spotify (PKCE, sans secret), distincte de celle du navigateur,
// pour que les deux ne se disputent pas la rotation des refresh tokens.

interface Env {
  HISTORY: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  API_KEY: string;
  ALLOWED_ORIGIN?: string;
}

interface Auth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Meta {
  /** ms epoch de la dernière écoute enregistrée (curseur `after` de l'API). */
  cursor: number;
  lastPollAt?: string;
  lastError?: string;
  total: number;
}

/** [horodatage ms, uri, titre, artiste, album, durée ms] — format compact attendu par l'app. */
type Row = [number, string, string, string, string, number];

const SCOPES = 'user-read-recently-played';

// ---------- Utilitaires ----------

const json = (env: Env, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });

const cors = (env: Env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
});

function authorized(req: Request, env: Env, url: URL): boolean {
  if (!env.API_KEY) return false;
  const header = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return header === env.API_KEY || url.searchParams.get('key') === env.API_KEY;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomString = (n: number) => base64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
const monthKey = (ts: number) => `plays:${new Date(ts).toISOString().slice(0, 7)}`;

async function getMeta(env: Env): Promise<Meta> {
  return (await env.HISTORY.get<Meta>('meta', 'json')) ?? { cursor: 0, total: 0 };
}

// ---------- Jetons Spotify ----------

async function tokenRequest(env: Env, body: Record<string, string>): Promise<Auth> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.SPOTIFY_CLIENT_ID, ...body }),
  });
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Spotify token : ${data.error_description ?? data.error ?? res.status}`);
  const previous = await env.HISTORY.get<Auth>('auth', 'json');
  const auth: Auth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await env.HISTORY.put('auth', JSON.stringify(auth));
  return auth;
}

async function accessToken(env: Env): Promise<string> {
  const auth = await env.HISTORY.get<Auth>('auth', 'json');
  if (!auth) throw new Error('Worker non connecté à Spotify : ouvre /login?key=TA_CLE');
  if (auth.expiresAt - 60_000 > Date.now()) return auth.accessToken;
  return (await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: auth.refreshToken })).accessToken;
}

// ---------- Relève des écoutes ----------

interface RecentItem {
  played_at: string;
  track: { uri: string; name: string; duration_ms: number; artists: { name: string }[]; album: { name: string } } | null;
}

export async function poll(env: Env): Promise<{ added: number }> {
  const meta = await getMeta(env);
  try {
    const token = await accessToken(env);
    const res = await fetch(`https://api.spotify.com/v1/me/player/recently-played?limit=50${meta.cursor ? `&after=${meta.cursor}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Spotify recently-played : ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { items: RecentItem[] };
    const rows: Row[] = data.items
      .filter((i) => i.track?.uri.startsWith('spotify:track:'))
      .map((i) => [Date.parse(i.played_at), i.track!.uri, i.track!.name, i.track!.artists[0]?.name ?? '', i.track!.album?.name ?? '', i.track!.duration_ms]);

    // Regroupe par mois et fusionne sans doublon (même horodatage + même titre).
    const byMonth = new Map<string, Row[]>();
    for (const r of rows) byMonth.set(monthKey(r[0]), [...(byMonth.get(monthKey(r[0])) ?? []), r]);
    let added = 0;
    for (const [key, incoming] of byMonth) {
      const existing = (await env.HISTORY.get<Row[]>(key, 'json')) ?? [];
      const seen = new Set(existing.map((r) => `${r[0]}|${r[1]}`));
      const fresh = incoming.filter((r) => !seen.has(`${r[0]}|${r[1]}`));
      if (!fresh.length) continue;
      added += fresh.length;
      await env.HISTORY.put(key, JSON.stringify([...existing, ...fresh].sort((a, b) => a[0] - b[0])));
    }
    const cursor = Math.max(meta.cursor, ...rows.map((r) => r[0]));
    await env.HISTORY.put('meta', JSON.stringify({ cursor, total: meta.total + added, lastPollAt: new Date().toISOString() } satisfies Meta));
    return { added };
  } catch (e) {
    await env.HISTORY.put('meta', JSON.stringify({ ...meta, lastPollAt: new Date().toISOString(), lastError: String(e instanceof Error ? e.message : e) }));
    throw e;
  }
}

async function playsSince(env: Env, since: number): Promise<Row[]> {
  // Mois à lire : du mois de `since` (borné à 3 ans) à aujourd'hui.
  const start = new Date(Math.max(since, Date.now() - 3 * 365 * 86_400_000));
  const keys: string[] = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); d.getTime() <= Date.now(); d.setUTCMonth(d.getUTCMonth() + 1)) {
    keys.push(monthKey(d.getTime()));
  }
  const months = await Promise.all(keys.map((k) => env.HISTORY.get<Row[]>(k, 'json')));
  return months.flatMap((m) => m ?? []).filter((r) => r[0] > since);
}

// ---------- Routes ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (url.pathname === '/') {
      const [meta, auth] = await Promise.all([getMeta(env), env.HISTORY.get('auth')]);
      return json(env, {
        service: 'sillon-history',
        connected: !!auth,
        configured: !!env.SPOTIFY_CLIENT_ID && !!env.API_KEY,
        total: meta.total,
        lastPollAt: meta.lastPollAt ?? null,
        lastError: meta.lastError ?? null,
      });
    }

    if (url.pathname === '/login') {
      if (!authorized(req, env, url)) return json(env, { error: 'Clé invalide' }, 401);
      if (!env.SPOTIFY_CLIENT_ID) return json(env, { error: 'SPOTIFY_CLIENT_ID manquant dans wrangler.toml' }, 500);
      const verifier = randomString(64);
      const state = randomString(16);
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      await env.HISTORY.put(`pkce:${state}`, verifier, { expirationTtl: 600 });
      const params = new URLSearchParams({
        client_id: env.SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: `${url.origin}/callback`,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: SCOPES,
        state,
      });
      return Response.redirect(`https://accounts.spotify.com/authorize?${params}`, 302);
    }

    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code');
      const verifier = await env.HISTORY.get(`pkce:${state}`);
      if (!code || !verifier) return new Response('Lien expiré ou invalide : recommence depuis /login.', { status: 400 });
      await env.HISTORY.delete(`pkce:${state}`);
      await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/callback`, code_verifier: verifier });
      const { added } = await poll(env);
      return new Response(`Connecté ✔ — ${added} écoute(s) récente(s) enregistrée(s). Le worker relèvera tes écoutes toutes les 30 minutes. Tu peux fermer cet onglet.`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/plays') {
      if (!authorized(req, env, url)) return json(env, { error: 'Clé invalide' }, 401);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      return json(env, { plays: await playsSince(env, since) });
    }

    if (url.pathname === '/poll') {
      if (!authorized(req, env, url)) return json(env, { error: 'Clé invalide' }, 401);
      return json(env, await poll(env));
    }

    return json(env, { error: 'Not found' }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(poll(env).catch(() => undefined));
  },
} satisfies ExportedHandler<Env>;
