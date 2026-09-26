// Client de l'API du serveur auto-hébergé (mode serveur). En mode local (GitHub Pages, dev),
// /api/config n'existe pas et l'app continue de tout faire dans le navigateur.
import type { JobKind, JobRun } from './automations';
import type { RawPlay } from './history';
import { chunk } from './http';
import { decode, encode } from './serialize';
import type { TasteCard } from './social';

export interface ServerConfig {
  mode: 'server';
  version: string;
  timezone: string;
  lastfm: boolean;
  baseUrl: string;
  user: { id: string; name: string; image: string | null; needsReauth: boolean } | null;
}

let serverConfig: ServerConfig | null = null;
export const isServerMode = () => serverConfig !== null;
export const getServerConfig = () => serverConfig;

/** Détecte le mode serveur (réponse JSON de /api/config), avec un délai court. */
export async function detectServer(): Promise<ServerConfig | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${import.meta.env.BASE_URL}api/config`, { signal: ctrl.signal, credentials: 'same-origin' });
    clearTimeout(t);
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    const json = (await res.json()) as ServerConfig;
    serverConfig = json.mode === 'server' ? json : null;
  } catch {
    serverConfig = null;
  }
  return serverConfig;
}

export class ServerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'X-Sillon': '1', ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new ServerError(401, body.error ?? 'Session expirée, reconnecte-toi.');
  }
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ServerError(res.status, body.error ?? `Serveur : ${res.status}`);
  return body as T;
}

// ---------- Jeton Spotify (le serveur garde le refresh token) ----------

let cached: { token: string; expiresAt: number; scope: string } | null = null;

export async function serverToken(force = false): Promise<string> {
  if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const t = await json<{ accessToken: string; expiresAt: number; scope: string }>(`/token${force ? '?force=1' : ''}`);
  cached = { token: t.accessToken, expiresAt: t.expiresAt, scope: t.scope };
  return t.accessToken;
}
export const serverScope = () => cached?.scope ?? null;

export const serverLogin = () => location.assign('/auth/login');
export const serverLogout = () => fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Sillon': '1' } }).catch(() => undefined);

// ---------- Documents ----------

export async function kvGet<T>(key: string): Promise<{ value: T; rev: number } | undefined> {
  const res = await call(`/kv/${key}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ServerError(res.status, `Lecture de « ${key} » impossible`);
  return { value: decode<T>(await res.text()), rev: Number(res.headers.get('X-Rev') ?? 0) };
}

export type PutResult = { ok: true; rev: number } | { ok: false; rev: number };

export async function kvPut(key: string, value: unknown, rev?: number): Promise<PutResult> {
  const res = await call(`/kv/${key}`, {
    method: 'PUT',
    body: encode(value),
    headers: { 'Content-Type': 'application/json', ...(rev !== undefined ? { 'If-Match': String(rev) } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { ok: false, rev: body.rev };
  if (!res.ok) throw new ServerError(res.status, body.error ?? `Écriture de « ${key} » impossible`);
  return { ok: true, rev: body.rev };
}

export const revs = () => json<Record<string, number>>('/revs');

// ---------- Historique ----------

/** Envoie les écoutes par lots de 20 000 (un historique complet dépasse souvent 300 000 écoutes). */
export async function importPlays(plays: RawPlay[], files: string[], onProgress?: (done: number, total: number) => void) {
  let added = 0;
  let total = 0;
  const parts = chunk(plays, 20_000);
  for (const [i, part] of parts.entries()) {
    const r = await json<{ added: number; total: number }>('/history/import', {
      method: 'POST',
      body: JSON.stringify({ plays: part, files: i === parts.length - 1 ? files : [] }),
      headers: { 'Content-Type': 'application/json' },
    });
    added += r.added;
    total = r.total;
    onProgress?.(i + 1, parts.length);
  }
  return { added, total };
}

export const clearServerHistory = () => json('/history', { method: 'DELETE' });

// ---------- Tâches ----------

export interface JobsState {
  runs: JobRun[];
  running: number[];
  next: { kind: JobKind; target?: string; at: string }[];
}

export const jobs = () => json<JobsState>('/jobs');
export const runJob = (kind: JobKind, target?: string) =>
  json(`/jobs/${kind}/run`, { method: 'POST', body: JSON.stringify({ target }), headers: { 'Content-Type': 'application/json' } });
export const cancelRun = (id: number) => json(`/jobs/${id}/cancel`, { method: 'POST' });
export const testNotification = () => json<{ sent: string[] }>('/notify/test', { method: 'POST' });
export const serverFriends = () => json<{ cards: TasteCard[] }>('/friends');
