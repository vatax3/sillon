import { useState } from 'react';
import { getClientId, getRedirectUri, login, setClientId } from '../lib/auth';
import { serverLogin, type ServerConfig } from '../lib/remote';

export default function Welcome({ error, server }: { error: string | null; server: ServerConfig | null }) {
  if (server) return <ServerWelcome error={error} server={server} />;
  return <LocalWelcome error={error} />;
}

/** Mode serveur : tout est déjà configuré, il suffit de se connecter. */
function ServerWelcome({ error, server }: { error: string | null; server: ServerConfig }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand big">
          <span className="logo" aria-hidden />
          Sillon
        </div>
        <p className="lead">Ton compagnon Spotify auto-hébergé : analyse, playlists automatiques, historique d’écoute continu.</p>
        {error && <p className="error-text">{error}</p>}
        <button className="primary wide" onClick={serverLogin}>
          Se connecter avec Spotify
        </button>
        <p className="fine">
          Serveur {server.version} · {new URL(server.baseUrl).host}. Ton compte doit être ajouté dans « User Management » de l’app Spotify
          utilisée par ce serveur.
        </p>
      </div>
    </div>
  );
}

function LocalWelcome({ error }: { error: string | null }) {
  const [clientId, setId] = useState(getClientId());
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fromEnv = !!import.meta.env.VITE_SPOTIFY_CLIENT_ID;

  const connect = async () => {
    setLocalError(null);
    if (!/^[0-9a-f]{32}$/i.test(clientId.trim())) {
      setLocalError('Un Client ID Spotify fait 32 caractères hexadécimaux.');
      return;
    }
    setClientId(clientId);
    setBusy(true);
    try {
      await login();
    } catch (e) {
      setBusy(false);
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand big">
          <span className="logo" aria-hidden />
          Sillon
        </div>
        <p className="lead">
          Analyse ta bibliothèque Spotify et génère des playlists par genre, mood, époque, artiste… ou laisse
          l’app détecter tes ambiances toute seule.
        </p>

        {!fromEnv && (
          <details className="setup" open={!clientId}>
            <summary>Configurer l’app Spotify (2 minutes, une seule fois)</summary>
            <ol>
              <li>
                Ouvre le{' '}
                <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                  dashboard développeur Spotify
                </a>{' '}
                et crée une app (API : <em>Web API</em>). Le compte propriétaire doit être Premium.
              </li>
              <li>
                Ajoute cette Redirect URI, à l’identique : <code>{getRedirectUri()}</code>
              </li>
              <li>
                Dans <em>User Management</em>, ajoute l’e-mail de chaque compte qui utilisera l’app (5 max en mode dev).
              </li>
              <li>Colle le Client ID ci-dessous.</li>
            </ol>
            <label className="field">
              <span>Client ID</span>
              <input
                value={clientId}
                onChange={(e) => setId(e.target.value)}
                placeholder="32 caractères, ex. 8f3c…"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </details>
        )}

        {(error || localError) && <p className="error-text">{error ?? localError}</p>}

        <button className="primary wide" onClick={connect} disabled={busy || !clientId}>
          {busy ? 'Redirection…' : 'Se connecter avec Spotify'}
        </button>
        <p className="fine">
          Tout reste dans ton navigateur : pas de serveur, pas de compte. Sillon crée des playlists privées et ne modifie
          une playlist existante qu’à ta demande, après l’avoir sauvegardée.
        </p>
      </div>
    </div>
  );
}
