import { useMemo, useRef, useState } from 'react';
import { fetchAudioFeatures, normalizeName } from '../lib/enrich';
import { computeHistoryStats } from '../lib/historyStats';
import { isAbort } from '../lib/http';
import { radarArtists, radarTracks, releaseRadar, type Release } from '../lib/radar';
import { artistEssentials, featureCentroid, knownSets, rankBySound, recommend, seedsFor, type Recommendation, type Seed } from '../lib/recommend';
import * as sp from '../lib/spotify';
import type { AudioFeatures, FeatureStore } from '../lib/types';
import { useStore } from '../store';
import { AsyncButton, ChipSelect, PlaylistPicker, PreviewButton, SubTabs, TrackRow, useSelection } from './ui';

type View = 'reco' | 'radar' | 'dig';

export default function Discover() {
  const [view, setView] = useState<View>('reco');
  return (
    <div className="discover">
      <SubTabs
        tabs={[
          { id: 'reco', label: 'Recommandations' },
          { id: 'radar', label: 'Radar de sorties' },
          { id: 'dig', label: 'À creuser' },
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'reco' && <Recommendations />}
      {view === 'radar' && <Radar />}
      {view === 'dig' && <Dig />}
    </div>
  );
}

// ---------- Tâche locale annulable avec progression ----------

function useJob() {
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const { report } = useStore();
  const start = async (fn: (signal: AbortSignal, onProgress: (label: string, done: number, total: number) => void) => Promise<void>) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setProgress({ label: 'Démarrage…', done: 0, total: 0 });
    try {
      await fn(c.signal, (label, done, total) => setProgress({ label, done, total }));
    } catch (e) {
      if (!isAbort(e)) report(e);
    } finally {
      if (ctrl.current === c) {
        ctrl.current = null;
        setProgress(null);
      }
    }
  };
  const cancel = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    setProgress(null);
  };
  return { progress, start, cancel, running: progress !== null };
}

function JobProgress({ job }: { job: ReturnType<typeof useJob> }) {
  if (!job.progress) return null;
  const { label, done, total } = job.progress;
  return (
    <div className="inline-progress">
      <span className="spinner" aria-hidden />
      <span>
        {label}
        {total ? ` — ${done}/${total}` : ''}
      </span>
      <div className="progress">
        <div className="progress-fill" style={{ width: total ? `${(done / total) * 100}%` : '10%' }} />
      </div>
      <button className="ghost small" onClick={job.cancel}>
        Arrêter
      </button>
    </div>
  );
}

// ---------- Ce que l'utilisateur connaît déjà ----------

function useKnown() {
  const { library, history } = useStore();
  return useMemo(() => knownSets(library, history), [library, history]);
}

// ---------- Recommandations ----------

type SeedMode = 'recent' | 'alltime' | 'playlist' | 'artists';
let lastRecos: { recos: Recommendation[]; label: string; playlistId?: string } | null = null;

function Recommendations() {
  const store = useStore();
  const { library, index, history } = store;
  const known = useKnown();
  const job = useJob();
  const [mode, setMode] = useState<SeedMode>('recent');
  const [playlistId, setPlaylistId] = useState('');
  const [artistIds, setArtistIds] = useState<string[]>([]);
  const [unknownOnly, setUnknownOnly] = useState(true);
  const [size, setSize] = useState(30);
  const [result, setResult] = useState(lastRecos);
  const [target, setTarget] = useState('');
  const sel = useSelection(result?.recos.map((r) => r.spotify.id) ?? []);

  const artistOptions = useMemo(
    () => [...(index?.artistCounts.entries() ?? [])].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ value: id, label: store.artistName(id), count: n })),
    [index, store.artistName],
  );

  const seeds = (): { seeds: Seed[]; label: string; centroid?: ReturnType<typeof featureCentroid> } => {
    if (mode === 'recent') return { seeds: seedsFor(library!, history, 'recent'), label: 'd’après tes écoutes récentes' };
    if (mode === 'alltime') return { seeds: seedsFor(library!, history, 'alltime'), label: 'd’après tes favoris de toujours' };
    if (mode === 'artists') return { seeds: artistIds.slice(0, 8).map((id) => ({ name: store.artistName(id), weight: 1 })), label: `autour de ${artistIds.map(store.artistName).join(', ')}` };
    const ids = library!.playlistItems?.[playlistId] ?? [];
    const counts = new Map<string, number>();
    for (const id of ids) {
      const a = library!.tracks[id]?.artists[0];
      if (a) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
    }
    const max = Math.max(...counts.values(), 1);
    const feats = ids.map((id) => index!.byId.get(id)?.features).filter((f): f is AudioFeatures => !!f);
    const name = library!.playlists.find((p) => p.id === playlistId)?.name ?? 'la playlist';
    return {
      seeds: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => ({ name: n, weight: c / max })),
      label: `pour prolonger « ${name} »`,
      centroid: featureCentroid(feats),
    };
  };

  const run = () =>
    job.start(async (signal, onProgress) => {
      const { seeds: s, label, centroid } = seeds();
      if (!s.length) throw new Error('Pas assez de données pour choisir des artistes de départ.');
      let recos = await recommend({
        seeds: s,
        knownArtists: known.artists,
        knownTracks: known.tracks,
        knownIds: known.ids,
        unknownArtistsOnly: unknownOnly,
        size: centroid ? Math.ceil(size * 1.5) : size,
        perArtist: 2,
        onProgress,
        signal,
      });
      if (centroid) {
        // Pour prolonger une playlist : on garde les titres qui sonnent comme elle.
        const store_: FeatureStore = {};
        await fetchAudioFeatures(recos.map((r) => r.spotify.id), store_, (patch, p) => {
          Object.assign(store_, patch);
          onProgress('Analyse du son', p.done, p.total);
        }, signal);
        recos = rankBySound(recos.map((r) => ({ ...r, features: store_[r.spotify.id] ?? undefined })), centroid).slice(0, size);
      }
      const next = { recos, label, playlistId: mode === 'playlist' ? playlistId : undefined };
      lastRecos = next;
      setResult(next);
      if (mode === 'playlist') setTarget(playlistId);
      sel.clear();
    });

  const chosen = result?.recos.filter((r) => sel.has(r.spotify.id)) ?? [];
  const targetList = chosen.length ? chosen : result?.recos ?? [];

  return (
    <>
      <section className="panel reco-form">
        <div className="row wrap">
          <label className="field">
            <span>Point de départ</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as SeedMode)}>
              <option value="recent">Mes écoutes récentes</option>
              <option value="alltime">Mes favoris de toujours</option>
              <option value="playlist">Prolonger une playlist</option>
              <option value="artists">Des artistes précis</option>
            </select>
          </label>
          {mode === 'playlist' && (
            <label className="field">
              <span>Playlist</span>
              <PlaylistPicker value={playlistId} onChange={setPlaylistId} />
            </label>
          )}
          <label className="field narrow">
            <span>Nombre</span>
            <input type="number" min={10} max={80} value={size} onChange={(e) => setSize(Math.max(5, Math.min(80, Number(e.target.value) || 30)))} />
          </label>
        </div>
        {mode === 'artists' && <ChipSelect options={artistOptions} selected={artistIds} onChange={setArtistIds} placeholder="Chercher un artiste de ta bibliothèque…" maxSuggestions={8} />}
        <label className="check">
          <input type="checkbox" checked={unknownOnly} onChange={(e) => setUnknownOnly(e.target.checked)} />
          Uniquement des artistes que je n’écoute jamais
        </label>
        <div className="row">
          <button className="primary" onClick={run} disabled={job.running || (mode === 'playlist' && !playlistId) || (mode === 'artists' && !artistIds.length)}>
            Trouver des titres
          </button>
          <span className="muted small">Artistes similaires via Deezer, puis correspondance Spotify. Tout ce que tu connais déjà (bibliothèque et historique) est écarté.</span>
        </div>
        <JobProgress job={job} />
      </section>

      {result && (
        <section className="panel">
          <header>
            <h3>
              {result.recos.length} découvertes <span className="muted">{result.label}</span>
            </h3>
          </header>
          <div className="bulk">
            <label className="check">
              <input type="checkbox" checked={sel.all} onChange={sel.toggleAll} /> {chosen.length ? `${chosen.length} sélectionné(s)` : 'Tout sélectionner'}
            </label>
            <span className="spacer" />
            <AsyncButton onClick={() => store.playUris(targetList.map((r) => r.spotify.uri))}>▶ Lire {chosen.length ? 'la sélection' : 'tout'}</AsyncButton>
            <AsyncButton
              onClick={async () => {
                await store.likeTracks(targetList.map((r) => r.spotify.id));
                store.say(`${targetList.length} titre(s) liké(s).`);
              }}
            >
              ❤ Liker
            </AsyncButton>
            <PlaylistPicker value={target} onChange={setTarget} placeholder="Ajouter à…" />
            <AsyncButton
              disabled={!target}
              onClick={async () => {
                const added = await store.addToPlaylist(target, targetList.map((r) => r.spotify.id));
                const skipped = targetList.length - added;
                store.say(`${added} titre(s) ajouté(s) à la playlist${skipped ? ` (${skipped} déjà présent(s))` : ''}.`);
              }}
            >
              Ajouter
            </AsyncButton>
            <AsyncButton
              className="primary small"
              onClick={async () => {
                const name = `Découvertes · ${new Date().toLocaleDateString('fr-FR')}`;
                const { count } = await store.createSimplePlaylist(name, `Recommandations ${result.label} — Sillon`, targetList.map((r) => r.spotify.uri));
                store.say(`Playlist « ${name} » créée (${count} titres).`);
              }}
            >
              Créer une playlist
            </AsyncButton>
          </div>
          <ul className="rows">
            {result.recos.map((r) => (
              <TrackRow
                key={r.spotify.id}
                image={r.spotify.image ?? r.cover}
                title={r.title}
                subtitle={`${r.artist}${r.because.length ? ` · car tu écoutes ${r.because.join(', ')}` : ''}`}
                href={sp.trackUrl(r.spotify.id)}
                selected={sel.has(r.spotify.id)}
                onSelect={(v) => sel.set(r.spotify.id, v)}
              >
                <PreviewButton url={r.preview} />
                <AsyncButton onClick={() => store.queueUri(r.spotify.uri)} title="Ajouter à la file d’attente">
                  + File
                </AsyncButton>
                <AsyncButton onClick={() => store.likeTracks([r.spotify.id]).then(() => store.say(`« ${r.title} » liké.`))} title="Liker">
                  ❤
                </AsyncButton>
              </TrackRow>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---------- Radar de sorties ----------

let lastRadar: { releases: Release[]; days: number; at: number } | null = null;

function Radar() {
  const store = useStore();
  const { library, index } = store;
  const job = useJob();
  const [days, setDays] = useState(30);
  const [result, setResult] = useState(lastRadar);
  const artists = useMemo(() => (library && index ? radarArtists(library, index) : []), [library, index]);
  const knownAlbums = useMemo(() => new Set(Object.values(library?.tracks ?? {}).filter((t) => t.likedAt).map((t) => t.album.id)), [library]);

  const run = () =>
    job.start(async (signal, onProgress) => {
      const releases = await releaseRadar(artists, days, (d, t) => onProgress('Sorties de tes artistes', d, t), signal);
      const next = { releases, days, at: Date.now() };
      lastRadar = next;
      setResult(next);
    });

  const buildPlaylist = async () => {
    if (!result) return;
    const uris = await radarTracks(result.releases, 'all');
    const name = `Radar de sorties · ${new Date().toLocaleDateString('fr-FR')}`;
    const { count } = await store.createSimplePlaylist(name, `Les sorties des ${result.days} derniers jours de mes artistes — Sillon`, uris);
    store.say(`Playlist « ${name} » créée (${count} titres).`);
  };

  return (
    <>
      <section className="panel reco-form">
        <p className="muted small">
          Surveille {artists.length} artistes : ceux que tu suis, ceux de tes tops et les plus présents dans ta bibliothèque.
          Spotify ne fournit plus de flux de nouveautés aux petites apps : on interroge chaque artiste (≈ {Math.ceil((artists.length * 2 * 0.3) / 60)} min).
        </p>
        <div className="row">
          <label className="field narrow">
            <span>Période</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={14}>14 derniers jours</option>
              <option value={30}>30 derniers jours</option>
              <option value={90}>3 derniers mois</option>
            </select>
          </label>
          <button className="primary" onClick={run} disabled={job.running || !artists.length}>
            Scanner les sorties
          </button>
        </div>
        <JobProgress job={job} />
      </section>
      {result && (
        <section className="panel">
          <header>
            <h3>
              {result.releases.length} sorties <span className="muted">sur {result.days} jours</span>
            </h3>
            {result.releases.length > 0 && (
              <AsyncButton className="primary small" onClick={buildPlaylist}>
                Créer la playlist des sorties
              </AsyncButton>
            )}
          </header>
          <div className="releases">
            {result.releases.map((r) => (
              <article key={r.album.id} className="release">
                <img src={r.album.images?.[1]?.url ?? r.album.images?.[0]?.url} alt="" loading="lazy" />
                <div className="release-body">
                  <a href={sp.albumUrl(r.album.id)} target="_blank" rel="noreferrer" className="tl-title">
                    {r.album.name}
                  </a>
                  <span className="tl-sub">{r.album.artists.map((a) => a.name).join(', ')}</span>
                  <span className="muted small">
                    {r.album.album_type === 'single' ? (r.album.total_tracks > 1 ? 'EP' : 'Single') : 'Album'} ·{' '}
                    {new Date(r.album.release_date).toLocaleDateString('fr-FR')}
                    {knownAlbums.has(r.album.id) && ' · déjà liké'}
                  </span>
                  <span className="row">
                    <AsyncButton onClick={() => store.playContext(r.album.uri)}>▶ Lire</AsyncButton>
                    <AsyncButton onClick={() => sp.saveToLibrary([r.album.uri]).then(() => store.say(`« ${r.album.name} » ajouté à ta bibliothèque.`))}>
                      + Bibliothèque
                    </AsyncButton>
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// ---------- À creuser ----------

function Dig() {
  const store = useStore();
  const { library, index, history } = store;
  const known = useKnown();
  const [open, setOpen] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, Recommendation[]>>({});
  const job = useJob();

  // Artistes très écoutés (historique) ou dans tes tops, mais presque absents de ta bibliothèque.
  const artists = useMemo(() => {
    if (!library || !index) return [];
    const inLib = new Map<string, number>();
    for (const [id, n] of index.artistCounts) inLib.set(normalizeName(library.artists[id]?.name ?? ''), n);
    const rows: { name: string; why: string; score: number }[] = [];
    if (history?.ts.length) {
      const s = computeHistoryStats(history, { from: 0, to: Infinity });
      for (const a of s.topArtists) {
        const n = inLib.get(normalizeName(a.key)) ?? 0;
        if (n <= 2 && a.ms > 2 * 3_600_000) rows.push({ name: a.key, why: `${Math.round(a.ms / 3_600_000)} h d’écoute, ${n} titre(s) chez toi`, score: a.ms });
      }
    }
    for (const a of Object.values(library.artists)) {
      const best = Math.min(...Object.values(a.topRanks).map((r) => r!), 99);
      const n = index.artistCounts.get(a.id) ?? 0;
      if (best <= 50 && n <= 2 && !rows.some((r) => normalizeName(r.name) === normalizeName(a.name))) {
        rows.push({ name: a.name, why: `n°${best} de tes tops, ${n} titre(s) chez toi`, score: (51 - best) * 1e5 });
      }
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, 20);
  }, [library, index, history]);

  // Albums dont tu as liké plusieurs titres sans les avoir tous.
  const albums = useMemo(() => {
    if (!index) return [];
    const m = new Map<string, { album: (typeof index.tracks)[number]['track']['album']; artist: string; liked: number }>();
    for (const t of index.tracks) {
      if (!t.track.likedAt) continue;
      const e = m.get(t.track.album.id) ?? { album: t.track.album, artist: t.track.artists[0]?.name ?? '', liked: 0 };
      e.liked++;
      m.set(t.track.album.id, e);
    }
    return [...m.values()]
      .filter((e) => e.liked >= 3 && (e.album.totalTracks ?? 0) >= e.liked + 3)
      .sort((a, b) => b.liked - a.liked)
      .slice(0, 24);
  }, [index]);

  const explore = (name: string) => {
    setOpen(open === name ? null : name);
    if (tracks[name] || open === name) return;
    void job.start(async (signal, onProgress) => {
      onProgress(`Titres phares de ${name}`, 0, 0);
      const list = await artistEssentials(name, known.ids, signal);
      setTracks((t) => ({ ...t, [name]: list }));
    });
  };

  return (
    <div className="grid wide-first">
      <section className="panel">
        <header>
          <h3>Artistes à creuser</h3>
          <span className="muted small">tu les écoutes beaucoup, mais tu n’en as presque rien gardé</span>
        </header>
        {artists.length === 0 ? (
          <p className="muted small">Rien à creuser pour l’instant (importe ton historique pour des suggestions plus fines).</p>
        ) : (
          <ul className="dig-list">
            {artists.map((a) => (
              <li key={a.name}>
                <button className={open === a.name ? 'dig-head open' : 'dig-head'} onClick={() => explore(a.name)}>
                  <strong>{a.name}</strong>
                  <span className="muted small">{a.why}</span>
                  <span aria-hidden>{open === a.name ? '▾' : '▸'}</span>
                </button>
                {open === a.name && (
                  <>
                    <JobProgress job={job} />
                    {tracks[a.name] && (
                      <ul className="rows">
                        {tracks[a.name].length === 0 && <li className="muted small">Tu as déjà tous ses titres phares.</li>}
                        {tracks[a.name].map((r) => (
                          <TrackRow key={r.spotify.id} image={r.spotify.image ?? r.cover} title={r.title} subtitle={r.album} href={sp.trackUrl(r.spotify.id)}>
                            <PreviewButton url={r.preview} />
                            <AsyncButton onClick={() => store.queueUri(r.spotify.uri)}>+ File</AsyncButton>
                            <AsyncButton onClick={() => store.likeTracks([r.spotify.id]).then(() => store.say(`« ${r.title} » liké.`))}>❤</AsyncButton>
                          </TrackRow>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <header>
          <h3>Albums à écouter en entier</h3>
          <span className="muted small">tu en as liké plusieurs titres, pas tous</span>
        </header>
        {albums.length === 0 ? (
          <p className="muted small">Aucun album concerné.</p>
        ) : (
          <ul className="rows">
            {albums.map((a) => (
              <TrackRow key={a.album.id} image={a.album.image} title={a.album.name} subtitle={a.artist} href={sp.albumUrl(a.album.id)} meta={`${a.liked}/${a.album.totalTracks} likés`}>
                <AsyncButton onClick={() => store.playContext(`spotify:album:${a.album.id}`)}>▶ Lire</AsyncButton>
              </TrackRow>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
