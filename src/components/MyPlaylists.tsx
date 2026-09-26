import { useEffect, useState } from 'react';
import { describeRule } from '../lib/generator';
import { playlistUrl } from '../lib/spotify';
import type { Rule } from '../lib/types';
import { useStore } from '../store';
import { describeSchedule } from '../lib/automations';
import { SchedulePicker } from './Automations';
import PlaylistEditor from './PlaylistEditor';

export default function MyPlaylists({ onEdit }: { onEdit: (r: Rule) => void }) {
  const store = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(store.editRequest?.id ?? null);
  const [filter, setFilter] = useState('');

  // Ouverture demandée depuis ailleurs (ex. juste après la création d'une playlist).
  useEffect(() => {
    if (store.editRequest) setEditing(store.editRequest.id);
  }, [store.editRequest?.nonce]);

  const close = () => {
    setEditing(null);
    store.openEditor(null);
  };

  if (editing) return <PlaylistEditor playlistId={editing} onClose={close} />;

  const refresh = async (id: string) => {
    const s = store.saved.find((x) => x.spotifyId === id);
    if (!s) return;
    setBusy(id);
    try {
      // En mode serveur, l'actualisation passe par le serveur (même code que la tâche planifiée).
      if (store.server) await store.runServerJob('living', id);
      else await store.refreshSaved(s);
    } catch (e) {
      store.report(e);
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    for (const s of store.saved) await refresh(s.spotifyId);
  };

  const livingIds = new Set(store.saved.map((s) => s.spotifyId));
  const others = (store.library?.playlists ?? [])
    .filter((p) => (p.owned || p.collaborative) && !livingIds.has(p.id))
    .filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="mine">
      <section>
        <div className="toolbar">
          <h3>Playlists vivantes</h3>
          <span className="muted small">
            créées par Sillon : « Actualiser » refait un tirage selon la même recette, en gardant tes retouches manuelles
          </span>
          <span className="spacer" />
          {store.saved.length > 1 && (
            <button className="ghost small" onClick={refreshAll} disabled={!!busy}>
              Tout actualiser
            </button>
          )}
        </div>
        {!store.saved.length ? (
          <p className="muted small panel">Aucune pour l’instant : crée-en une depuis les Suggestions ou le Créateur.</p>
        ) : (
          <ul className="saved-list">
            {store.saved.map((s) => {
              const touches = (s.rule.pinned?.length ?? 0) + (s.rule.excluded?.length ?? 0);
              return (
                <li key={s.spotifyId} className="panel saved">
                  <div className="saved-main">
                    <a href={playlistUrl(s.spotifyId)} target="_blank" rel="noreferrer" className="saved-title">
                      {s.name} ↗
                    </a>
                    <span className="muted small">{describeRule(s.rule, store.artistName).description.split(' — ')[0]}</span>
                    <span className="muted small">
                      {s.trackCount} titres · {s.isPublic ? 'publique' : 'privée'}
                      {s.pool ? ' · ambiance figée' : ''}
                      {touches ? ` · ${s.rule.pinned?.length ?? 0} épinglé(s), ${s.rule.excluded?.length ?? 0} exclu(s)` : ''} · mise à jour le{' '}
                      {new Date(s.updatedAt).toLocaleDateString('fr-FR')}
                    </span>
                    {store.server && (
                      <span className="row small living-auto">
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={!!s.schedule}
                            onChange={(e) => store.setLivingSchedule(s.spotifyId, e.target.checked ? { freq: 'weekly', day: 1, hour: 6 } : null)}
                          />
                          Actualisation automatique{s.schedule && !store.automations.livingRefresh ? ' (désactivée dans Automatisations)' : ''}
                        </label>
                        {s.schedule && <SchedulePicker value={s.schedule} onChange={(sc) => store.setLivingSchedule(s.spotifyId, sc)} />}
                      </span>
                    )}
                    {!store.server && s.schedule && <span className="muted small">Planifiée côté serveur : {describeSchedule(s.schedule)}</span>}
                  </div>
                  <div className="saved-actions">
                    <button className="primary small" onClick={() => refresh(s.spotifyId)} disabled={!!busy}>
                      {busy === s.spotifyId ? 'Actualisation…' : 'Actualiser'}
                    </button>
                    <button className="ghost small" onClick={() => setEditing(s.spotifyId)}>
                      Modifier
                    </button>
                    {!s.pool && (
                      <button className="ghost small" onClick={() => onEdit({ ...s.rule, pinned: [], excluded: [] })}>
                        Dupliquer la recette
                      </button>
                    )}
                    <button className="ghost small" onClick={() => store.forgetSaved(s.spotifyId)} title="Oublie la recette dans Sillon ; la playlist reste sur Spotify et devient une playlist normale">
                      Figer
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <header>
          <h3>Toutes mes playlists</h3>
          <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer les playlists" />
        </header>
        {!others.length ? (
          <p className="muted small">{filter ? 'Aucune playlist ne correspond.' : 'Aucune autre playlist (resynchronise si tu viens d’en créer).'}</p>
        ) : (
          <ul className="rows">
            {others.map((p) => (
              <li key={p.id} className="trackrow">
                {p.image ? <img src={p.image} alt="" loading="lazy" /> : <span className="noimg" />}
                <span className="tl-main">
                  <a className="tl-title" href={playlistUrl(p.id)} target="_blank" rel="noreferrer">
                    {p.name}
                  </a>
                  <span className="tl-sub">
                    {p.trackCount} titres{p.collaborative ? ' · collaborative' : ''}
                  </span>
                </span>
                <button className="ghost small" onClick={() => setEditing(p.id)}>
                  Modifier
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
