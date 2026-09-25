import { useEffect, useMemo, useState } from 'react';
import { describeRule, generate } from '../lib/generator';
import { playlistUrl } from '../lib/spotify';
import type { Rule } from '../lib/types';
import { useStore } from '../store';
import { totalDuration, TrackList } from './ui';

/**
 * Aperçu d'une playlist générée : on peut retirer des titres, relancer le tirage,
 * renommer, puis créer la playlist sur Spotify.
 */
export default function PlaylistPreview({
  rule,
  pool,
  defaultName,
  onReroll,
}: {
  rule: Rule;
  pool?: string[];
  defaultName?: string;
  onReroll?: () => void;
}) {
  const store = useStore();
  const index = store.index!;
  const poolSet = useMemo(() => (pool ? new Set(pool) : undefined), [pool]);
  const result = useMemo(() => generate(index, rule, poolSet), [index, rule, poolSet]);
  const auto = useMemo(() => describeRule(rule, store.artistName), [rule, store.artistName]);

  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [name, setName] = useState(defaultName ?? auto.name);
  const [nameTouched, setNameTouched] = useState(false);
  const [isPublic, setPublic] = useState(store.settings.publicByDefault);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Le nom suit les filtres tant que l'utilisateur ne l'a pas modifié.
  useEffect(() => {
    if (!nameTouched) setName(defaultName ?? auto.name);
  }, [auto.name, defaultName, nameTouched]);
  useEffect(() => {
    setRemoved(new Set());
    setCreated(null);
  }, [result]);

  const tracks = result.tracks.filter((t) => !removed.has(t.track.id));
  const djInfo = rule.sort === 'harmonic' || rule.sort === 'energy_arc' || rule.sort === 'tempo_asc';

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await store.createPlaylist({
        name: name.trim() || auto.name,
        description: auto.description,
        isPublic,
        tracks,
        rule,
        pool,
      });
      setCreated(saved.spotifyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="preview">
      <div className="preview-head">
        <div>
          <h3>
            {tracks.length} titres <span className="muted">· {totalDuration(tracks)}</span>
          </h3>
          <p className="muted small">
            {result.matchedCount} titres correspondent aux critères
            {result.missingFeatures > 0 &&
              ` · ${result.missingFeatures} écartés faute d’audio-features (lance l’enrichissement)`}
          </p>
        </div>
        <span className="row">
          {tracks.length > 0 && (
            <button className="ghost" onClick={() => store.playUris(tracks.map((t) => t.track.uri))} title="Lire sur ton appareil Spotify actif, sans créer la playlist">
              ▶ Écouter
            </button>
          )}
          {onReroll && tracks.length > 0 && (
            <button className="ghost" onClick={onReroll} title="Nouveau tirage avec les mêmes critères">
              🎲 Autre tirage
            </button>
          )}
        </span>
      </div>

      {tracks.length === 0 ? (
        <p className="empty-inline">Aucun titre ne correspond. Élargis un peu les critères.</p>
      ) : (
        <>
          <div className="create-row">
            <input
              className="name-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              aria-label="Nom de la playlist"
              maxLength={100}
            />
            <label className="check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} /> Publique
            </label>
            {created ? (
              <a className="button primary" href={playlistUrl(created)} target="_blank" rel="noreferrer">
                Ouvrir dans Spotify ↗
              </a>
            ) : (
              <button className="primary" onClick={create} disabled={busy}>
                {busy ? 'Création…' : 'Créer sur Spotify'}
              </button>
            )}
          </div>
          {created && <p className="success small">Playlist créée. Tu la retrouves dans « Mes playlists » pour l’actualiser plus tard.</p>}
          {error && <p className="error-text small">{error}</p>}
          <TrackList
            tracks={tracks}
            showDjInfo={djInfo}
            onPlay={(i) => store.playUris(tracks.map((t) => t.track.uri), i)}
            onRemove={created ? undefined : (id) => setRemoved(new Set(removed).add(id))}
          />
        </>
      )}
    </section>
  );
}
