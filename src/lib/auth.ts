// Authorization Code + PKCE : aucun secret côté client, donc pas de backend nécessaire.
// https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export { SCOPES } from './scopes';
import { SCOPES } from './scopes';

const K_CLIENT = 'sillon.clientId';
const K_TOKENS = 'sillon.tokens';
const K_VERIFIER = 'sillon.pkce.verifier';
const K_STATE = 'sillon.pkce.state';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Scopes accordés (absent sur les sessions créées avant leur mémorisation). */
  scope?: string;
}

export function getClientId(): string {
  return import.meta.env.VITE_SPOTIFY_CLIENT_ID || localStorage.getItem(K_CLIENT) || '';
}

export function setClientId(id: string) {
  localStorage.setItem(K_CLIENT, id.trim());
}

export function getRedirectUri(): string {
  return import.meta.env.VITE_REDIRECT_URI || `${location.origin}${import.meta.env.BASE_URL}callback`;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

export async function login(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error('Client ID Spotify manquant');
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  sessionStorage.setItem(K_VERIFIER, verifier);
  sessionStorage.setItem(K_STATE, state);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES.join(' '),
    state,
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
}

/** Traite le retour de Spotify sur /callback. Retourne true si un login vient d'aboutir. */
export async function handleCallback(): Promise<boolean> {
  // Sous-chemin possible (GitHub Pages : /sillon/callback, servi via 404.html).
  if (!location.pathname.endsWith('/callback')) return false;
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  const code = params.get('code');
  const state = params.get('state');
  history.replaceState(null, '', import.meta.env.BASE_URL);
  if (error) throw new Error(`Connexion refusée par Spotify : ${error}`);
  if (!code) return false;
  if (state !== sessionStorage.getItem(K_STATE)) throw new Error('État OAuth invalide, réessaie.');
  const verifier = sessionStorage.getItem(K_VERIFIER);
  if (!verifier) throw new Error('Vérificateur PKCE introuvable, réessaie.');
  sessionStorage.removeItem(K_VERIFIER);
  sessionStorage.removeItem(K_STATE);

  await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });
  return true;
}

async function requestTokens(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getClientId(), ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'Échec du token Spotify');
  const previous = readTokens();
  const tokens: Tokens = {
    accessToken: json.access_token,
    // Spotify ne renvoie pas toujours un nouveau refresh token.
    refreshToken: json.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope ?? previous?.scope,
  };
  localStorage.setItem(K_TOKENS, JSON.stringify(tokens));
  return tokens;
}

function readTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(K_TOKENS);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

/** Scopes demandés par l'app mais pas accordés à la session actuelle (nouvelles fonctions). */
export function missingScopes(): string[] {
  const granted = new Set((readTokens()?.scope ?? '').split(' '));
  return SCOPES.filter((s) => !granted.has(s));
}

export function isLoggedIn(): boolean {
  return !!readTokens()?.refreshToken;
}

let refreshing: Promise<Tokens> | null = null;

export async function getAccessToken(force = false): Promise<string> {
  const tokens = readTokens();
  if (!tokens) throw new Error('Non connecté');
  if (!force && tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  refreshing ??= requestTokens({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  }).finally(() => {
    refreshing = null;
  });
  return (await refreshing).accessToken;
}

export function logout() {
  localStorage.removeItem(K_TOKENS);
}
