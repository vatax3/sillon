import { useState } from 'react';
import { describeRule } from '../lib/generator';
import { playlistUrl } from '../lib/spotify';
import type { Rule } from '../lib/types';
import { useStore } from '../store';

export default function MyPlaylists({ onEdit }: { onEdit: (r: Rule) => void }) {
  const store = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (id: string) => {
    const s = store.saved.find((x) => x.spotifyId === id);
    if (!s) return;
    setBusy(id);
    setError(null);
    try {
      await store.refreshSaved(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    for (const s of store.saved) await refresh(s.spotifyId);
  };

  if (!store.saved.length) {
    return (
      <div className="empty">
        <h2>Aucune playlist créée pour l’instant</h2>
        <p className="muted">
          Chaque playlist créée par Sillon garde sa recette : tu pourras l’actualiser en un clic quand ta bibliothèque
          évolue (nouveaux likes, nouveau tirage).
        </p>
      </div>
    );
  }

  return (
    <div className="mine">
      <div className="toolbar">
        <p className="muted">
          Playlists « vivantes » : « Actualiser » remplace leur contenu par un nouveau tirage selon la même recette,
          à partir de ta dernière synchro.
        </p>
        <span className="spacer" />
        <button className="ghost" onClick={refreshAll} disabled={!!busy}>
          Tout actualiser
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <ul className="saved-list">
        {store.saved.map((s) => (
          <li key={s.spotifyId} className="panel saved">
            <div className="saved-main">
              <a href={playlistUrl(s.spotifyId)} target="_blank" rel="noreferrer" className="saved-title">
                {s.name} ↗
              </a>
              <span className="muted small">{describeRule(s.rule, store.artistName).description.split(' — ')[0]}</span>
              <span className="muted small">
                {s.trackCount} titres · {s.isPublic ? 'publique' : 'privée'}
                {s.pool ? ' · ambiance figée' : ''} · mise à jour le{' '}
                {new Date(s.updatedAt).toLocaleDateString('fr-FR')}
              </span>
            </div>
            <div className="saved-actions">
              <button className="primary small" onClick={() => refresh(s.spotifyId)} disabled={!!busy}>
                {busy === s.spotifyId ? 'Actualisation…' : 'Actualiser'}
              </button>
              {!s.pool && (
                <button className="ghost small" onClick={() => onEdit({ ...s.rule })}>
                  Dupliquer la recette
                </button>
              )}
              <button className="ghost small" onClick={() => store.forgetSaved(s.spotifyId)} title="Oublie la recette dans Sillon, la playlist reste sur Spotify">
                Oublier
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
