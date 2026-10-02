import { useDeferredValue, useEffect, useMemo, useState } from 'react';
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
  rule: liveRule,
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
  // Les curseurs restent fluides : l'aperçu se recalcule juste après, sans bloquer la saisie.
  const rule = useDeferredValue(liveRule);
  const stale = rule !== liveRule;
  const poolSet = useMemo(() => (pool ? new Set(pool) : undefined), [pool]);
  const auto = useMemo(() => describeRule(rule, store.artistName), [rule, store.artistName]);

  // Titres retirés de l'aperçu : remplacés par d'autres, et mémorisés comme exclus dans la recette.
  const [removed, setRemoved] = useState<string[]>([]);
  const effectiveRule = useMemo<Rule>(() => (removed.length ? { ...rule, excluded: [...(rule.excluded ?? []), ...removed] } : rule), [rule, removed]);
  const result = useMemo(() => generate(index, effectiveRule, poolSet), [index, effectiveRule, poolSet]);
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
    setRemoved([]);
    setCreated(null);
  }, [rule, poolSet]);

  const tracks = result.tracks;
  const djInfo = rule.sort === 'harmonic' || rule.sort === 'energy_arc' || rule.sort === 'tempo_asc' || rule.sort === 'tempo_desc';
  const fullName = `${store.settings.playlistPrefix}${name.trim() || auto.name}`.slice(0, 100);
  const nameTaken = useMemo(
    () => !created && [...(store.library?.playlists ?? []).map((p) => p.name), ...store.saved.map((s) => s.name)].some((n) => n.toLowerCase() === fullName.toLowerCase()),
    [created, fullName, store.library, store.saved],
  );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await store.createPlaylist({
        name: name.trim() || auto.name,
        description: auto.description,
        isPublic,
        tracks,
        rule: effectiveRule,
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
    <section className={stale ? 'preview stale' : 'preview'}>
      <div className="preview-head">
        <div>
          <h3>
            {tracks.length} titres <span className="muted">· {totalDuration(tracks)}</span>
          </h3>
          <p className="muted small">
            {result.matchedCount} titres correspondent aux critères
            {result.duplicatesRemoved > 0 && (
              <span title="Autres versions d’un morceau déjà retenu (remaster, single / album…). Désactivable dans « Mise en forme ».">
                {` · ${result.duplicatesRemoved} doublon(s) écarté(s)`}
              </span>
            )}
            {removed.length > 0 && ` · ${removed.length} retiré(s) à la main`}
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
              <>
                <button className="ghost" onClick={() => store.openEditor(created)}>
                  Modifier à la main
                </button>
                <a className="button primary" href={playlistUrl(created)} target="_blank" rel="noreferrer">
                  Ouvrir dans Spotify ↗
                </a>
              </>
            ) : (
              <button className="primary" onClick={create} disabled={busy}>
                {busy ? 'Création…' : 'Créer sur Spotify'}
              </button>
            )}
          </div>
          {nameTaken && <p className="warn small">Une playlist porte déjà ce nom sur ton compte : Spotify en créera une deuxième.</p>}
          {created && <p className="success small">Playlist créée. Tu la retrouves dans « Mes playlists » pour l’actualiser plus tard.</p>}
          {error && <p className="error-text small">{error}</p>}
          <TrackList
            tracks={tracks}
            showDjInfo={djInfo}
            onPlay={(i) => store.playUris(tracks.map((t) => t.track.uri), i)}
            onRemove={created ? undefined : (id) => setRemoved([...removed, id])}
            removeHint="Retirer (remplacé par un autre titre s’il en reste, et jamais remis lors des actualisations)"
          />
        </>
      )}
    </section>
  );
}
