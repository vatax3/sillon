// Serveur Sillon : sert l'interface, garde les données et les jetons, exécute les tâches planifiées.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { JobKind } from '../src/lib/automations';
import type { HistoryStore, RawPlay } from '../src/lib/history';
import { buildIndex } from '../src/lib/indexer';
import { buildTasteCard, type TasteCard } from '../src/lib/social';
import type { FeatureStore, Library, Settings, TagStore } from '../src/lib/types';
import { AccessDenied, completeLogin, loginUrl, userAccessToken } from './auth';
import { config, secureCookies } from './config';
import {
  ALL_DOCS,
  CLIENT_WRITABLE,
  createSession,
  deleteDoc,
  deleteSession,
  docRevs,
  getDoc,
  getDocRaw,
  getUser,
  listRuns,
  listUsers,
  purgeSessions,
  putDocRaw,
  sessionUser,
  touchUser,
} from './db';
import { notify } from './notify';
import { cancelJob, nextRuns, runJob, runningRuns, schedule, startScheduler, stopScheduler } from './scheduler';
import { exportUser, mergeHistory } from './tasks';

type Env = { Variables: { userId: string } };
const app = new Hono<Env>();
const COOKIE = 'sillon_sid';

app.get('/healthz', (c) => c.json({ ok: true, version: config.version, users: listUsers().length }));

// ---------- Connexion ----------

app.get('/auth/login', (c) => c.redirect(loginUrl()));

app.get('/auth/callback', async (c) => {
  const error = c.req.query('error');
  if (error) return c.redirect(`/?authError=${encodeURIComponent(`Connexion refusée par Spotify : ${error}`)}`);
  try {
    const userId = await completeLogin(c.req.query('code') ?? '', c.req.query('state') ?? '');
    const sid = crypto.randomBytes(32).toString('base64url');
    createSession(sid, userId);
    setCookie(c, COOKIE, sid, { httpOnly: true, sameSite: 'Lax', secure: secureCookies(), path: '/', maxAge: 180 * 86_400 });
    schedule(userId);
    return c.redirect('/');
  } catch (e) {
    const msg = e instanceof AccessDenied ? e.message : `Échec de la connexion : ${e instanceof Error ? e.message : e}`;
    return c.redirect(`/?authError=${encodeURIComponent(msg)}`);
  }
});

app.post('/auth/logout', (c) => {
  const sid = getCookie(c, COOKIE);
  if (sid) deleteSession(sid);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---------- API ----------

const api = new Hono<Env>();
api.use('*', compress());

// Configuration publique : permet à l'interface de savoir qu'elle tourne en mode serveur.
api.get('/config', (c) => {
  const sid = getCookie(c, COOKIE);
  const userId = sid ? sessionUser(sid) : undefined;
  const u = userId ? getUser(userId) : undefined;
  return c.json({
    mode: 'server',
    version: config.version,
    timezone: config.timezone,
    lastfm: !!config.lastfmKey,
    baseUrl: config.baseUrl,
    user: u ? { id: u.id, name: u.name, image: u.image, needsReauth: !!u.needs_reauth } : null,
  });
});

// Toutes les autres routes exigent une session ; les écritures exigent un en-tête maison (anti-CSRF).
api.use('*', async (c, next) => {
  const sid = getCookie(c, COOKIE);
  const userId = sid ? sessionUser(sid) : undefined;
  if (!userId || !getUser(userId)) return c.json({ error: 'Non connecté' }, 401);
  if (c.req.method !== 'GET' && c.req.header('X-Sillon') !== '1') return c.json({ error: 'En-tête X-Sillon manquant' }, 403);
  c.set('userId', userId);
  await next();
});

let lastTouch = new Map<string, number>();
api.get('/token', async (c) => {
  const userId = c.get('userId');
  if (Date.now() - (lastTouch.get(userId) ?? 0) > 600_000) {
    touchUser(userId);
    lastTouch.set(userId, Date.now());
  }
  try {
    const accessToken = await userAccessToken(userId, c.req.query('force') === '1');
    const u = getUser(userId)!;
    return c.json({ accessToken, expiresAt: u.expires_at, scope: u.scope ?? '' });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), needsReauth: !!getUser(userId)?.needs_reauth }, 401);
  }
});

api.get('/revs', (c) => c.json(docRevs(c.get('userId'))));

const validKey = (key: string) => ALL_DOCS.includes(key);

api.get('/kv/:key', (c) => {
  const key = c.req.param('key');
  if (!validKey(key)) return c.json({ error: 'Clé inconnue' }, 404);
  const row = getDocRaw(c.get('userId'), key);
  if (!row) return c.body(null, 404);
  return c.body(row.value, 200, { 'Content-Type': 'application/json', 'X-Rev': String(row.rev) });
});

api.put('/kv/:key', async (c) => {
  const key = c.req.param('key');
  if (!CLIENT_WRITABLE.has(key)) return c.json({ error: `Le document « ${key} » est géré par le serveur` }, 403);
  const ifMatch = c.req.header('If-Match');
  const body = await c.req.text();
  try {
    JSON.parse(body);
  } catch {
    return c.json({ error: 'JSON invalide' }, 400);
  }
  const res = putDocRaw(c.get('userId'), key, body, ifMatch === undefined ? undefined : Number(ifMatch));
  return res.ok ? c.json({ rev: res.rev }) : c.json({ error: 'Conflit', rev: res.rev }, 409);
});

api.post('/history/import', async (c) => {
  const { plays, files } = await c.req.json<{ plays: RawPlay[]; files?: string[] }>();
  if (!Array.isArray(plays)) return c.json({ error: 'plays manquant' }, 400);
  return c.json(mergeHistory(c.get('userId'), plays, files ?? []));
});

api.delete('/history', (c) => {
  deleteDoc(c.get('userId'), 'history');
  return c.json({ ok: true });
});

api.get('/jobs', (c) => {
  const userId = c.get('userId');
  return c.json({ runs: listRuns(userId), running: runningRuns(userId), next: nextRuns(userId) });
});

const RUNNABLE = new Set<JobKind>(['record', 'sync', 'enrich', 'living', 'discoveries', 'radar', 'timeMachine', 'monthlyTop', 'backup']);
api.post('/jobs/:kind/run', async (c) => {
  const kind = c.req.param('kind') as JobKind;
  if (!RUNNABLE.has(kind)) return c.json({ error: 'Tâche inconnue' }, 404);
  const { target } = await c.req.json<{ target?: string }>().catch(() => ({ target: undefined }));
  // Lancée en arrière-plan : l'interface suit la progression via /api/jobs.
  void runJob(c.get('userId'), kind as Exclude<JobKind, 'import'>, 'manual', target);
  return c.json({ ok: true });
});

api.post('/jobs/:id/cancel', (c) => c.json({ ok: cancelJob(c.get('userId'), Number(c.req.param('id'))) }));

api.post('/notify/test', async (c) => {
  try {
    const sent = await notify(c.get('userId'), 'test', 'Sillon', 'Les notifications fonctionnent 🎵');
    return c.json({ sent });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// Cartes de goûts des autres comptes du serveur qui ont choisi de la partager.
const cardCache = new Map<string, { key: string; card: TasteCard }>();
api.get('/friends', (c) => {
  const me = c.get('userId');
  const cards: TasteCard[] = [];
  for (const u of listUsers()) {
    if (u.id === me || !getDoc<Settings>(u.id, 'settings')?.shareOnServer) continue;
    const revs = docRevs(u.id);
    const key = ['library', 'tags', 'features', 'history'].map((k) => revs[k] ?? 0).join('.');
    let hit = cardCache.get(u.id);
    if (!hit || hit.key !== key) {
      const lib = getDoc<Library>(u.id, 'library');
      if (!lib) continue;
      const history = getDoc<HistoryStore>(u.id, 'history') ?? null;
      const index = buildIndex(lib, getDoc<TagStore>(u.id, 'tags') ?? {}, getDoc<FeatureStore>(u.id, 'features') ?? {}, history);
      hit = { key, card: buildTasteCard(lib, index, history) };
      cardCache.set(u.id, hit);
    }
    cards.push(hit.card);
  }
  return c.json({ cards });
});

api.get('/export', (c) =>
  c.body(exportUser(c.get('userId')), 200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="sillon-export-${new Date().toISOString().slice(0, 10)}.json"`,
  }),
);

app.route('/api', api);

// ---------- Interface (fichiers statiques + fallback SPA) ----------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function sendFile(c: Context, file: string) {
  const ext = path.extname(file);
  // Les assets Vite ont un hash dans leur nom : cache long. index.html : jamais en cache.
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  return c.body(fs.readFileSync(file), 200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': cache });
}

app.get('*', (c) => {
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.text('URL invalide', 400);
  }
  const file = path.resolve(config.staticDir, `.${rel}`);
  // Protection contre la sortie du dossier (…/%2e%2e/…) : le séparateur final évite qu'un dossier voisin
  // au nom proche (dist-server à côté de dist) passe le test.
  if (file.startsWith(config.staticDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(c, file);
  const index = path.join(config.staticDir, 'index.html');
  if (!fs.existsSync(index)) return c.text('Interface non construite (npm run build).', 500);
  return sendFile(c, index);
});

// ---------- Démarrage ----------

/** Démarre l'écoute HTTP et le planificateur (pas lors d'un import par les tests). */
export function start() {
  startScheduler();
  setInterval(purgeSessions, 86_400_000).unref();
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`[sillon] ${config.version} à l'écoute sur :${info.port} — URL publique ${config.baseUrl}`);
    console.log(`[sillon] Redirect URI à déclarer dans l'app Spotify : ${config.baseUrl}/auth/callback`);
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`[sillon] ${sig} : arrêt propre`);
      stopScheduler();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();

export { app };
