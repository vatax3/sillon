import { useState } from 'react';
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

  const exportCsv = () => {
    const header = ['id', 'titre', 'artistes', 'album', 'année', 'liké le', 'familles', 'genres', 'moods', 'énergie', 'positivité', 'dansabilité', 'tempo'];
    const rows = store.index!.tracks.map((t) => [
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
      </section>

      <section className="panel">
        <h3>Données</h3>
        <p className="muted small">Tout est stocké localement dans ce navigateur (IndexedDB).</p>
        <div className="row wrap">
          <button className="ghost" onClick={exportCsv}>
            Exporter ma bibliothèque (CSV)
          </button>
          {confirmReset ? (
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
        </ul>
      </section>
    </div>
  );
}
