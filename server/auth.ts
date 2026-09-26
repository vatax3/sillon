// Connexion Spotify côté serveur : le serveur garde le refresh token (une seule chaîne de jetons
// par compte, partagée par tous les appareils et par les tâches planifiées).
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SCOPES } from '../src/lib/scopes';
import { setTokenSource } from '../src/lib/spotify';
import { config, redirectUri } from './config';
import { getUser, markNeedsReauth, saveTokens, upsertUser } from './db';

const b64url = (buf: Buffer) => buf.toString('base64url');

// États OAuth en attente (10 min).
const pending = new Map<string, { verifier: string; at: number }>();

export function loginUrl(): string {
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, { verifier, at: Date.now() });
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    scope: SCOPES.join(' '),
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const params = new URLSearchParams(body);
  if (config.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  } else {
    params.set('client_id', config.clientId);
  }
  const res = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers, body: params });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Spotify token ${res.status}`);
    (err as Error & { code?: string }).code = json.error;
    throw err;
  }
  return json;
}

export class AccessDenied extends Error {}

/** Échange le code reçu sur /auth/callback, crée ou met à jour l'utilisateur. */
export async function completeLogin(code: string, state: string): Promise<string> {
  const p = pending.get(state);
  if (!p) throw new Error('Lien de connexion expiré, recommence.');
  pending.delete(state);
  const body: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri() };
  if (!config.clientSecret) body.code_verifier = p.verifier;
  const t = await tokenRequest(body);
  const meRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (!meRes.ok) throw new Error(`Spotify /me : ${meRes.status} — ce compte est-il ajouté dans User Management de l’app Spotify ?`);
  const me = (await meRes.json()) as { id: string; display_name: string | null; images?: { url: string }[] };
  if (config.allowedUsers.length && !config.allowedUsers.includes(me.id)) {
    throw new AccessDenied(`Le compte Spotify « ${me.id} » n’est pas autorisé sur ce serveur (ALLOWED_SPOTIFY_IDS).`);
  }
  upsertUser({
    id: me.id,
    name: me.display_name || me.id,
    image: me.images?.[0]?.url,
    refreshToken: t.refresh_token ?? '',
    accessToken: t.access_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    scope: t.scope,
  });
  return me.id;
}

const refreshing = new Map<string, Promise<string>>();

/** Jeton d'accès valide pour un utilisateur, rafraîchi si besoin (dédoublonné par utilisateur). */
export async function userAccessToken(userId: string, force = false): Promise<string> {
  const u = getUser(userId);
  if (!u) throw new Error('Utilisateur inconnu');
  if (u.needs_reauth) throw new Error('Session Spotify expirée : reconnecte-toi dans Sillon.');
  if (!force && u.access_token && u.expires_at - 60_000 > Date.now()) return u.access_token;
  let p = refreshing.get(userId);
  if (!p) {
    p = tokenRequest({ grant_type: 'refresh_token', refresh_token: u.refresh_token })
      .then((t) => {
        saveTokens(userId, { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, refreshToken: t.refresh_token, scope: t.scope });
        return t.access_token;
      })
      .catch((e: Error & { code?: string }) => {
        // Accès révoqué ou refresh token invalide : il faudra se reconnecter.
        if (e.code === 'invalid_grant') markNeedsReauth(userId);
        throw e;
      })
      .finally(() => refreshing.delete(userId));
    refreshing.set(userId, p);
  }
  return p;
}

// ---------- Contexte d'exécution ----------
// Le client Spotify partagé (src/lib/spotify) demande son jeton à une « source » unique.
// Côté serveur, cette source lit l'utilisateur de la tâche en cours via AsyncLocalStorage :
// deux tâches de deux comptes différents peuvent tourner en même temps sans se mélanger.

const als = new AsyncLocalStorage<{ userId: string }>();

export const runAs = <T>(userId: string, fn: () => Promise<T>) => als.run({ userId }, fn);

export function currentUser(): string {
  const ctx = als.getStore();
  if (!ctx) throw new Error('Appel Spotify hors du contexte d’un utilisateur');
  return ctx.userId;
}

setTokenSource((force) => userAccessToken(currentUser(), force));
