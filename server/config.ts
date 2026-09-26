import path from 'node:path';

const env = process.env;

function required(name: string): string {
  const v = env[name]?.trim();
  if (!v) {
    console.error(`[sillon] Variable d'environnement manquante : ${name} (voir docker-compose.yml)`);
    process.exit(1);
  }
  return v;
}

const port = Number(env.PORT ?? 8080);

export const config = {
  port,
  /** URL publique (celle du navigateur), sans / final. Sert à construire la Redirect URI Spotify. */
  baseUrl: (env.BASE_URL?.trim() || `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
  clientId: required('SPOTIFY_CLIENT_ID'),
  /** Optionnel : sans secret, le serveur utilise PKCE. */
  clientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() ?? '',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  staticDir: path.resolve(env.STATIC_DIR ?? './dist'),
  lastfmKey: env.LASTFM_API_KEY?.trim() ?? '',
  /** Ids Spotify autorisés (vide = tous ceux que l'app Spotify accepte, 5 max en mode dev). */
  allowedUsers: (env.ALLOWED_SPOTIFY_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  timezone: env.TZ?.trim() || 'Europe/Paris',
  /** Garde des exports JSON quotidiens sur disque (jours). */
  version: env.SILLON_VERSION ?? 'dev',
};

export const redirectUri = () => `${config.baseUrl}/auth/callback`;
export const secureCookies = () => config.baseUrl.startsWith('https://');
