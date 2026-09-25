import { useEffect, useRef, useState } from 'react';
import * as sp from '../lib/spotify';
import { useStore } from '../store';

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Mini-lecteur Spotify Connect : pilote l'appareil actif (téléphone, ordi, enceinte). Premium requis. */
export default function PlayerBar() {
  const { playerTick, bumpPlayer, needsReauth } = useStore();
  const [state, setState] = useState<sp.PlaybackState | null | undefined>(undefined);
  const [devices, setDevices] = useState<sp.Device[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const fetchedAt = useRef(Date.now());

  const poll = async () => {
    if (document.hidden || needsReauth) return;
    try {
      const s = await sp.getPlayback();
      fetchedAt.current = Date.now();
      setState(s ?? null);
      if (!s) setDevices(await sp.getDevices());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void poll();
    const t = setInterval(poll, 8000);
    return () => clearInterval(t);
  }, [playerTick, needsReauth]);

  // Interpolation locale de la progression entre deux sondages.
  useEffect(() => {
    if (!state?.is_playing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state?.is_playing]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    bumpPlayer();
  };

  if (hidden || state === undefined || needsReauth) return null;

  const item = state?.item;
  const progress = state ? Math.min((state.progress_ms ?? 0) + (state.is_playing ? now - fetchedAt.current : 0), item?.duration_ms ?? 0) : 0;

  return (
    <div className="playerbar" role="region" aria-label="Lecteur Spotify">
      {!state ? (
        <div className="pb-empty">
          <span className="muted small">Aucune lecture en cours.</span>
          {devices && devices.length > 0 ? (
            <>
              <span className="muted small">Lire sur :</span>
              {devices.map((d) => (
                <button key={d.id ?? d.name} className="ghost small" disabled={!d.id} onClick={() => act(() => sp.transferPlayback(d.id!))}>
                  {d.name}
                </button>
              ))}
            </>
          ) : (
            <span className="muted small">Ouvre Spotify sur un appareil pour piloter la lecture d’ici.</span>
          )}
        </div>
      ) : (
        <>
          {item?.album.images?.[0] && <img src={item.album.images[item.album.images.length - 1].url} alt="" />}
          <div className="pb-info">
            <span className="pb-title">{item?.name ?? '—'}</span>
            <span className="tl-sub">
              {item?.artists.map((a) => a.name).join(', ')} · sur {state.device.name}
            </span>
          </div>
          <div className="pb-controls">
            <button className="ghost small icon" onClick={() => act(sp.previousTrack)} aria-label="Précédent">
              ⏮
            </button>
            <button className="primary small icon" onClick={() => act(state.is_playing ? sp.pause : sp.resume)} aria-label={state.is_playing ? 'Pause' : 'Lecture'}>
              {state.is_playing ? '❚❚' : '▶'}
            </button>
            <button className="ghost small icon" onClick={() => act(sp.nextTrack)} aria-label="Suivant">
              ⏭
            </button>
          </div>
          {item && (
            <div className="pb-progress">
              <span className="small muted">{fmt(progress)}</span>
              <div className="progress">
                <div className="progress-fill" style={{ width: `${(progress / item.duration_ms) * 100}%` }} />
              </div>
              <span className="small muted">{fmt(item.duration_ms)}</span>
            </div>
          )}
        </>
      )}
      {error && <span className="error-text small pb-error">{error}</span>}
      <button className="ghost small icon pb-close" onClick={() => setHidden(true)} aria-label="Masquer le lecteur">
        ✕
      </button>
    </div>
  );
}
