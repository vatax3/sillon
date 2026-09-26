// Stockage SQLite (module natif node:sqlite, aucune dépendance compilée).
// Les données de chaque utilisateur sont des « documents » (bibliothèque, historique, playlists
// vivantes…), les mêmes que ceux que le navigateur gardait dans IndexedDB, versionnés par `rev`.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JobKind, JobRun } from '../src/lib/automations';
import { decode, encode } from '../src/lib/serialize';
import { config } from './config';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'sillon.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0,
    scope TEXT,
    needs_reauth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS docs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target TEXT,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    message TEXT,
    progress TEXT
  );
  CREATE INDEX IF NOT EXISTS job_runs_user ON job_runs(user_id, id DESC);
`);

// Une exécution interrompue par un redémarrage ne doit pas rester « en cours ».
db.prepare(`UPDATE job_runs SET status = 'error', message = 'Interrompue (redémarrage du serveur)', finished_at = ? WHERE status = 'running'`).run(
  new Date().toISOString(),
);

// ---------- Méta ----------

export function getMeta(key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}
export function setMeta(key: string, value: string) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- Utilisateurs ----------

export interface UserRow {
  id: string;
  name: string;
  image: string | null;
  refresh_token: string;
  access_token: string | null;
  expires_at: number;
  scope: string | null;
  needs_reauth: number;
  created_at: string;
  last_seen_at: string | null;
}

export const getUser = (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as UserRow[];

export function upsertUser(u: { id: string; name: string; image?: string; refreshToken: string; accessToken: string; expiresAt: number; scope?: string }) {
  db.prepare(
    `INSERT INTO users (id, name, image, refresh_token, access_token, expires_at, scope, needs_reauth, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, image = excluded.image, refresh_token = excluded.refresh_token,
       access_token = excluded.access_token, expires_at = excluded.expires_at, scope = excluded.scope, needs_reauth = 0,
       last_seen_at = excluded.last_seen_at`,
  ).run(u.id, u.name, u.image ?? null, u.refreshToken, u.accessToken, u.expiresAt, u.scope ?? null, new Date().toISOString(), new Date().toISOString());
}

export function saveTokens(id: string, t: { accessToken: string; expiresAt: number; refreshToken?: string; scope?: string }) {
  db.prepare(
    `UPDATE users SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token), scope = COALESCE(?, scope), needs_reauth = 0 WHERE id = ?`,
  ).run(t.accessToken, t.expiresAt, t.refreshToken ?? null, t.scope ?? null, id);
}

export const markNeedsReauth = (id: string) => db.prepare('UPDATE users SET needs_reauth = 1 WHERE id = ?').run(id);
export const touchUser = (id: string) => db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);

// ---------- Sessions ----------

const SESSION_DAYS = 180;

export function createSession(id: string, userId: string) {
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    new Date().toISOString(),
    Date.now() + SESSION_DAYS * 86_400_000,
  );
}
export function sessionUser(id: string): string | undefined {
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(id) as { user_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  return row.user_id;
}
export const deleteSession = (id: string) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
export const purgeSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// ---------- Documents ----------

/** Documents que le navigateur peut écrire ; les autres sont gérés uniquement par le serveur. */
export const CLIENT_WRITABLE = new Set(['library', 'tags', 'features', 'saved', 'backups', 'friends', 'settings', 'automations']);
export const ALL_DOCS = [...CLIENT_WRITABLE, 'history', 'autostate'];

type Listener = (userId: string, key: string) => void;
const listeners: Listener[] = [];
/** Prévient le planificateur quand un document qui le concerne change. */
export const onDocChange = (l: Listener) => listeners.push(l);

export function getDocRaw(userId: string, key: string): { value: string; rev: number } | undefined {
  return db.prepare('SELECT value, rev FROM docs WHERE user_id = ? AND key = ?').get(userId, key) as { value: string; rev: number } | undefined;
}

export function getDoc<T>(userId: string, key: string): T | undefined {
  const row = getDocRaw(userId, key);
  return row ? decode<T>(row.value) : undefined;
}

export function docRevs(userId: string): Record<string, number> {
  const rows = db.prepare('SELECT key, rev FROM docs WHERE user_id = ?').all(userId) as { key: string; rev: number }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.rev]));
}

/**
 * Écrit un document déjà encodé. Avec `expectedRev`, refuse si le document a changé depuis
 * (écriture concurrente d'un autre appareil ou d'une tâche) et renvoie la révision actuelle.
 */
export function putDocRaw(userId: string, key: string, value: string, expectedRev?: number): { ok: true; rev: number } | { ok: false; rev: number } {
  const current = db.prepare('SELECT rev FROM docs WHERE user_id = ? AND key = ?').get(userId, key) as { rev: number } | undefined;
  if (expectedRev !== undefined && (current?.rev ?? 0) !== expectedRev) return { ok: false, rev: current?.rev ?? 0 };
  const rev = (current?.rev ?? 0) + 1;
  db.prepare(
    `INSERT INTO docs (user_id, key, value, rev, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, rev = excluded.rev, updated_at = excluded.updated_at`,
  ).run(userId, key, value, rev, new Date().toISOString());
  for (const l of listeners) l(userId, key);
  return { ok: true, rev };
}

export const putDoc = (userId: string, key: string, value: unknown) => putDocRaw(userId, key, encode(value));

/** Lecture-modification-écriture synchrone (atomique : aucune autre tâche ne s'intercale). */
export function updateDoc<T>(userId: string, key: string, fn: (current: T | undefined) => T): T {
  const next = fn(getDoc<T>(userId, key));
  putDoc(userId, key, next);
  return next;
}

export const deleteDoc = (userId: string, key: string) => {
  db.prepare('DELETE FROM docs WHERE user_id = ? AND key = ?').run(userId, key);
  for (const l of listeners) l(userId, key);
};

// ---------- Exécutions de tâches ----------

interface JobRow {
  id: number;
  kind: string;
  target: string | null;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  message: string | null;
  progress: string | null;
}

const toRun = (r: JobRow): JobRun => ({
  id: r.id,
  kind: r.kind as JobKind,
  target: r.target ?? undefined,
  status: r.status as JobRun['status'],
  trigger: r.trigger as JobRun['trigger'],
  startedAt: r.started_at,
  finishedAt: r.finished_at ?? undefined,
  message: r.message ?? undefined,
  progress: r.progress ? JSON.parse(r.progress) : undefined,
});

export function startRun(userId: string, kind: JobKind, trigger: JobRun['trigger'], target?: string): number {
  const res = db
    .prepare(`INSERT INTO job_runs (user_id, kind, target, status, trigger, started_at) VALUES (?, ?, ?, 'running', ?, ?)`)
    .run(userId, kind, target ?? null, trigger, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function progressRun(id: number, progress: JobRun['progress']) {
  db.prepare('UPDATE job_runs SET progress = ? WHERE id = ?').run(JSON.stringify(progress), id);
}

export function finishRun(id: number, status: JobRun['status'], message?: string) {
  db.prepare('UPDATE job_runs SET status = ?, message = ?, finished_at = ?, progress = NULL WHERE id = ?').run(status, message ?? null, new Date().toISOString(), id);
}

export function listRuns(userId: string, limit = 60): JobRun[] {
  return (db.prepare('SELECT * FROM job_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as unknown as JobRow[]).map(toRun);
}

/** Garde les 500 dernières exécutions par utilisateur. */
export function pruneRuns(userId: string) {
  db.prepare('DELETE FROM job_runs WHERE user_id = ? AND id NOT IN (SELECT id FROM job_runs WHERE user_id = ? ORDER BY id DESC LIMIT 500)').run(userId, userId);
}
