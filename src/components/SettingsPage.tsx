import { useState } from 'react';
import { AsyncButton } from './ui';
import { useStore } from '../store';

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function SettingsPage() {
  const store = useStore();
  const [key, setKey] = useState(store.settings.lastfmKey);
  const [confirmReset, setConfirmReset] = useState(false);
  const [workerUrl, setWorkerUrl] = useState(store.settings.workerUrl);
  const [workerKey, setWorkerKey] = useState(store.settings.workerKey);
  const [confirmHistory, setConfirmHistory] = useState(false);

  const exportCsv = () => {
    if (!store.index) return;
    const header = ['id', 'titre', 'artistes', 'album', 'année', 'liké le', 'familles', 'genres', 'moods', 'énergie', 'positivité', 'dansabilité', 'tempo'];
    const rows = store.index.tracks.map((t) => [
      t.track.id,
      t.track.name,
      t.track.artists.map((a) => a.name).join(' / '),
      t.track.album.name,
      t.year ?? '',
      t.track.likedAt?.slice(0, 10) ?? '',
      t.families.join(' / '),
      t.genres.join(' / '),
      t.moods.join(' / '),
      t.features?.energy ?? '',
      t.features?.valence ?? '',
      t.features?.danceability ?? '',
      t.features ? Math.round(t.features.tempo) : '',
    ]);
    download('sillon-bibliotheque.csv', [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  return (
    <div className="settings">
      <section className="panel">
        <h3>Source des genres</h3>
        <p className="muted small">
          Spotify ne fournit plus les genres aux apps en mode développeur. Sans clé, Sillon interroge MusicBrainz
          (gratuit mais limité à ~1 artiste/seconde). Avec une clé Last.fm gratuite, c’est ~4× plus rapide et les tags
          sont plus riches (y compris des indices d’ambiance).{' '}
          <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">
            Créer une clé Last.fm
          </a>
        </p>
        <div className="row">
          <input value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="Clé API Last.fm (32 caractères)" spellCheck={false} />
          <button className="primary" onClick={() => store.updateSettings({ lastfmKey: key })} disabled={key === store.settings.lastfmKey}>
            Enregistrer
          </button>
        </div>
        <p className="muted small">Après ajout d’une clé, relance l’enrichissement : les artistes restés sans genre seront retentés.</p>
        {store.server?.lastfm && !store.settings.lastfmKey && <p className="success small">Le serveur fournit déjà une clé Last.fm (LASTFM_API_KEY).</p>}
      </section>

      <section className="panel">
        <h3>Création de playlists</h3>
        <label className="field">
          <span>Préfixe ajouté au nom (optionnel)</span>
          <input value={store.settings.playlistPrefix} onChange={(e) => store.updateSettings({ playlistPrefix: e.target.value })} placeholder="ex. « ◎ » ou « Sillon – »" />
        </label>
        <label className="check">
          <input type="checkbox" checked={store.settings.publicByDefault} onChange={(e) => store.updateSettings({ publicByDefault: e.target.checked })} />
          Créer les playlists en public par défaut
        </label>
        {!store.server && (
        <label className="field">
          <span>Actualiser automatiquement les playlists vivantes à l’ouverture de l’app</span>
          <select value={store.settings.autoRefreshDays} onChange={(e) => store.updateSettings({ autoRefreshDays: Number(e.target.value) })}>
            <option value={0}>Jamais (manuellement)</option>
            <option value={1}>Si elles ont plus d’un jour</option>
            <option value={7}>Si elles ont plus d’une semaine</option>
            <option value={30}>Si elles ont plus d’un mois</option>
          </select>
        </label>
        )}
      </section>

      {store.server && (
        <section className="panel">
          <h3>Serveur</h3>
          <p className="muted small">
            Sillon {store.server.version} auto-hébergé sur {new URL(store.server.baseUrl).host} · fuseau {store.server.timezone}. Tes données
            sont sur le serveur et synchronisées entre tous tes appareils ; les tâches planifiées sont dans l’onglet Automatisations.
          </p>
          <div className="row wrap">
            <a className="button ghost" href="/api/export">
              Télécharger un export complet
            </a>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!store.settings.shareOnServer} onChange={(e) => store.updateSettings({ shareOnServer: e.target.checked })} />
            Partager ma carte de goûts avec les autres comptes de ce serveur (onglet Amis)
          </label>
        </section>
      )}

      {!store.server && (
      <section className="panel">
        <h3>Enregistrement continu des écoutes (optionnel)</h3>
        <p className="muted small">
          L’API ne garde que tes 50 dernières écoutes. Un petit worker Cloudflare (gratuit) peut les relever toutes les 30 minutes
          pour que ton historique reste complet même quand Sillon est fermé. Mode d’emploi : dossier <code>worker/</code> du dépôt.
        </p>
        <label className="field">
          <span>URL du worker</span>
          <input value={workerUrl} onChange={(e) => setWorkerUrl(e.target.value.trim())} placeholder="https://sillon-history.ton-compte.workers.dev" spellCheck={false} />
        </label>
        <label className="field">
          <span>Clé d’accès (API_KEY définie sur le worker)</span>
          <input type="password" value={workerKey} onChange={(e) => setWorkerKey(e.target.value.trim())} spellCheck={false} autoComplete="off" />
        </label>
        <div className="row wrap">
          <button className="primary" disabled={workerUrl === store.settings.workerUrl && workerKey === store.settings.workerKey} onClick={() => store.updateSettings({ workerUrl, workerKey })}>
            Enregistrer
          </button>
          <AsyncButton className="ghost" disabled={!store.settings.workerUrl} onClick={() => store.pullWorker()}>
            Récupérer les écoutes maintenant
          </AsyncButton>
        </div>
      </section>
      )}

      <section className="panel">
        <h3>Historique d’écoute</h3>
        <p className="muted small">
          {store.history?.ts.length
            ? `${store.history.ts.length.toLocaleString('fr-FR')} écoutes, du ${new Date(store.history.ts[0]).toLocaleDateString('fr-FR')} au ${new Date(store.history.ts[store.history.ts.length - 1]).toLocaleDateString('fr-FR')}. Fichiers importés : ${store.history.importedFiles.length}.`
            : 'Aucun historique importé (onglet Écoutes).'}
        </p>
        {!!store.history?.ts.length &&
          (confirmHistory ? (
            <div className="row">
              <button className="danger" onClick={() => store.clearHistory().then(() => setConfirmHistory(false))}>
                Confirmer : effacer l’historique
              </button>
              <button className="ghost" onClick={() => setConfirmHistory(false)}>
                Annuler
              </button>
            </div>
          ) : (
            <button className="ghost" onClick={() => setConfirmHistory(true)}>
              Effacer l’historique…
            </button>
          ))}
      </section>

      <section className="panel">
        <h3>Données</h3>
        <p className="muted small">{store.server ? 'Tout est stocké sur ton serveur (SQLite, volume /data).' : 'Tout est stocké localement dans ce navigateur (IndexedDB).'}</p>
        <div className="row wrap">
          <button className="ghost" onClick={exportCsv} disabled={!store.index}>
            Exporter ma bibliothèque (CSV)
          </button>
          {store.server ? null : confirmReset ? (
            <>
              <button className="danger" onClick={() => store.resetAll().then(() => setConfirmReset(false))}>
                Confirmer : tout effacer
              </button>
              <button className="ghost" onClick={() => setConfirmReset(false)}>
                Annuler
              </button>
            </>
          ) : (
            <button className="ghost" onClick={() => setConfirmReset(true)}>
              Effacer le cache local…
            </button>
          )}
          <button className="ghost" onClick={store.logout}>
            Se déconnecter
          </button>
        </div>
      </section>

      <section className="panel">
        <h3>À propos des données</h3>
        <ul className="small muted about">
          <li>Spotify (mode dev) : titres likés, playlists possédées/collaboratives, tops 3 périodes, 50 dernières écoutes, artistes suivis.</li>
          <li>Audio-features (énergie, tempo, tonalité…) : ReccoBeats, service tiers gratuit, qui ne connaît pas tous les titres.</li>
          <li>Genres : tags Last.fm ou MusicBrainz, regroupés en familles.</li>
          <li>Les playlists suivies mais créées par d’autres ne sont pas lisibles via l’API depuis 2026.</li>
          <li>Recommandations : artistes similaires et extraits 30 s via l’API publique de Deezer, puis recherche du titre sur Spotify.</li>
          <li>Historique : tes exports Spotify (restent dans le navigateur), les 50 dernières écoutes à chaque synchro et le worker optionnel.</li>
        </ul>
      </section>
    </div>
  );
}
