import { useMemo, useRef, useState } from 'react';
import type { HistoryStore } from '../lib/history';
import {
  availablePeriods,
  computeHistoryStats,
  CONTEXTS,
  loyalArtists,
  moodByMoment,
  rankedUris,
  timeMachine,
  topTracksWhere,
  yearsSummary,
  type Ranked,
} from '../lib/historyStats';
import { trackUrl } from '../lib/spotify';
import { useStore } from '../store';
import { AsyncButton, BarChart, Columns, Heatmap, SubTabs, TrackRow } from './ui';

type View = 'overview' | 'habits' | 'time';
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const hours = (ms: number) => Math.round(ms / 3_600_000).toLocaleString('fr-FR');
const monthLabel = (k: string) => {
  const [y, m] = k.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

export default function History() {
  const { history } = useStore();
  if (!history || history.ts.length === 0) return <ImportPanel first />;
  return <HistoryView h={history} />;
}

function ImportPanel({ first }: { first?: boolean }) {
  const { importHistory, report } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handle = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const { added, skipped } = await importHistory(files);
      setResult(`${added.toLocaleString('fr-FR')} écoutes ajoutées.${skipped.length ? ` Fichiers ignorés : ${skipped.join(', ')}` : ''}`);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={first ? 'panel import first' : 'panel import'}>
      {first && (
        <>
          <h2>Tes vraies stats d’écoute</h2>
          <p className="muted">
            L’API Spotify ne donne que tes 50 dernières écoutes. Pour des stats complètes, importe ton historique :
            c’est gratuit et ça ne quitte pas ton navigateur.
          </p>
          <ol className="small">
            <li>
              Va sur{' '}
              <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">
                spotify.com › Compte › Confidentialité
              </a>{' '}
              et coche <strong>« Historique de streaming étendu »</strong> (tout depuis la création du compte, avec les
              skips). « Données du compte » marche aussi mais ne couvre qu’un an, sans skips.
            </li>
            <li>Spotify t’envoie un e-mail (quelques jours, jusqu’à 30). Dézippe l’archive.</li>
            <li>
              Glisse ici tous les fichiers <code>Streaming_History_Audio_*.json</code> (ou{' '}
              <code>StreamingHistory_music_*.json</code>).
            </li>
          </ol>
          <p className="muted small">En attendant, chaque synchro ajoute tes 50 dernières écoutes, et le worker optionnel (Réglages) les enregistre en continu.</p>
        </>
      )}
      <div
        className={drag ? 'dropzone on' : 'dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void handle(e.dataTransfer.files);
        }}
      >
        <input ref={input} type="file" accept=".json,application/json" multiple hidden onChange={(e) => handle(e.target.files)} />
        <button className="primary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Import en cours…' : first ? 'Choisir les fichiers JSON' : 'Importer d’autres fichiers'}
        </button>
        <span className="muted small">ou glisse-les ici · les doublons sont ignorés</span>
      </div>
      {result && <p className="success small">{result}</p>}
    </section>
  );
}

function HistoryView({ h }: { h: HistoryStore }) {
  const { library, features } = useStore();
  const periods = useMemo(() => availablePeriods(h), [h]);
  const [periodId, setPeriodId] = useState('12m');
  const period = periods.find((p) => p.id === periodId) ?? periods[0];
  const stats = useMemo(() => computeHistoryStats(h, period), [h, period]);
  const [view, setView] = useState<View>('overview');

  const first = new Date(h.ts[0]).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const imageOf = (key: string) => library?.tracks[key]?.album.image;
  const likedIds = useMemo(() => new Set(Object.values(library?.tracks ?? {}).filter((t) => t.likedAt).map((t) => t.id)), [library]);

  return (
    <div className="history">
      <div className="toolbar">
        <div className="chips">
          {periods.map((p) => (
            <button key={p.id} className={p.id === period.id ? 'chip on' : 'chip'} onClick={() => setPeriodId(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted small">
          {h.ts.length.toLocaleString('fr-FR')} écoutes depuis {first}
        </span>
      </div>

      <SubTabs
        tabs={[
          { id: 'overview', label: 'Vue d’ensemble' },
          { id: 'habits', label: 'Habitudes' },
          { id: 'time', label: 'Remonter le temps' },
        ]}
        value={view}
        onChange={setView}
      />

      {view === 'overview' && (
        <>
          <section className="kpis">
            <div className="kpi hero">
              <span className="kpi-value">{hours(stats.totalMs)} h</span>
              <span className="kpi-label">d’écoute · {period.label.toLowerCase()}</span>
            </div>
            <Kpi value={stats.streams.toLocaleString('fr-FR')} label="écoutes de plus de 30 s" />
            <Kpi value={stats.uniqueTracks.toLocaleString('fr-FR')} label="titres différents" />
            <Kpi value={stats.uniqueArtists.toLocaleString('fr-FR')} label="artistes différents" />
            <Kpi value={stats.activeDays ? `${Math.round(stats.totalMs / 60_000 / stats.activeDays)} min` : '—'} label="par jour d’écoute" />
            <Kpi value={`${stats.longestStreak.days} j`} label="plus longue série de jours d’affilée" />
          </section>

          <div className="grid">
            <Panel title="Quand tu écoutes" hint="minutes par jour et par heure">
              <Heatmap data={stats.heatmap} />
            </Panel>
            <Panel title="Heures d’écoute par mois">
              <Columns bars={stats.perMonth.map((m) => ({ key: m.key, label: m.key.slice(2).replace('-', '/'), value: Math.round(m.value / 60) }))} unit="h" />
            </Panel>
            <Panel title="Top artistes" hint="heures d’écoute">
              <BarChart bars={stats.topArtists.slice(0, 15).map((a) => ({ key: a.key, label: a.key, value: a.ms / 3_600_000 }))} format={(v) => `${v.toFixed(v < 10 ? 1 : 0)} h`} />
            </Panel>
            <Panel title="Top albums" hint="heures d’écoute">
              <BarChart
                bars={stats.topAlbums.slice(0, 12).map((a) => {
                  const [album, artist] = a.key.split('\u0000');
                  return { key: a.key, label: `${album} — ${artist}`, value: a.ms / 3_600_000 };
                })}
                format={(v) => `${v.toFixed(v < 10 ? 1 : 0)} h`}
              />
            </Panel>
          </div>

          <TopTracks h={h} title={`Top titres · ${period.label}`} rows={stats.topTracks} imageOf={imageOf} playlistName={`Mon top · ${period.label}`} />
        </>
      )}

      {view === 'habits' && (
        <>
          <div className="grid">
            <Panel title="Tes époques" hint="artiste dominant, mois par mois">
              <ol className="eras">
                {stats.eras.slice(-24).reverse().map((e) => (
                  <li key={e.from}>
                    <span className="era-date">{e.from === e.to ? monthLabel(e.from) : `${monthLabel(e.from)} → ${monthLabel(e.to)}`}</span>
                    <strong>{e.artist}</strong>
                    <span className="muted small">{hours(e.ms)} h</span>
                  </li>
                ))}
              </ol>
            </Panel>
            <Panel title="Obsessions" hint="le plus d’écoutes d’un titre en 14 jours">
              {stats.obsessions.length === 0 ? (
                <p className="muted small">Pas d’obsession détectée sur cette période (12 écoutes en 14 jours minimum).</p>
              ) : (
                <ul className="rows">
                  {stats.obsessions.map((o) => {
                    const t = h.tracks[o.track];
                    return (
                      <TrackRow key={o.track} image={imageOf(t.key)} title={t.name} subtitle={`${t.artist} · à partir du ${new Date(o.start).toLocaleDateString('fr-FR')}`} href={t.key.startsWith('n:') ? undefined : trackUrl(t.key)} meta={`${o.count}× en 14 j`} />
                    );
                  })}
                </ul>
              )}
            </Panel>
            <Panel title="Titres que tu skippes" hint="au moins 5 écoutes, skippés plus d’une fois sur deux">
              {stats.skippedTracks.length === 0 ? (
                <p className="muted small">Rien à signaler (ou ton export ne contient pas l’info de skip).</p>
              ) : (
                <ul className="rows">
                  {stats.skippedTracks.slice(0, 15).map((r) => {
                    const t = h.tracks[r.key as number];
                    return (
                      <TrackRow key={t.key} image={imageOf(t.key)} title={t.name} subtitle={t.artist} href={t.key.startsWith('n:') ? undefined : trackUrl(t.key)} meta={<>{likedIds.has(t.key) && <span className="tag">liké</span>} {Math.round(r.rate * 100)}% skip · {r.plays}×</>} />
                    );
                  })}
                </ul>
              )}
            </Panel>
            <Panel title="Artistes les plus skippés" hint="au moins 15 écoutes">
              <BarChart bars={stats.skippedArtists.slice(0, 12).map((r) => ({ key: String(r.key), label: String(r.key), value: r.rate }))} format={(v) => `${Math.round(v * 100)}%`} max={1} emptyText="Aucun artiste skippé plus d’une fois sur deux." />
            </Panel>
            <MoodPanel h={h} period={period} features={features} />
            <LoyaltyPanel h={h} />
          </div>
          <p className="muted small">Mode aléatoire activé sur {Math.round(stats.shuffleShare * 100)}% des écoutes de la période.</p>
        </>
      )}

      {view === 'time' && <TimeView h={h} stats={stats} imageOf={imageOf} />}

      <ImportPanel />
    </div>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className="kpi">
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header>
        <h3>{title}</h3>
        {hint && <span className="muted small">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function CreateFromHistory({ h, rows, name, description }: { h: HistoryStore; rows: Ranked<number>[]; name: string; description: string }) {
  const { createSimplePlaylist, say, playUris } = useStore();
  const uris = useMemo(() => rankedUris(h, rows), [h, rows]);
  if (!uris.length) return null;
  return (
    <span className="row">
      <AsyncButton onClick={() => playUris(uris)} title="Lire sur ton appareil Spotify actif">
        ▶ Lire
      </AsyncButton>
      <AsyncButton
        className="primary small"
        onClick={async () => {
          const { count } = await createSimplePlaylist(name, description, uris);
          say(`Playlist « ${name} » créée (${count} titres).`);
        }}
      >
        Créer la playlist ({uris.length})
      </AsyncButton>
    </span>
  );
}

function TopTracks({ h, title, rows, imageOf, playlistName }: { h: HistoryStore; title: string; rows: Ranked<number>[]; imageOf: (k: string) => string | undefined; playlistName: string }) {
  const [all, setAll] = useState(false);
  return (
    <section className="panel">
      <header>
        <h3>{title}</h3>
        <CreateFromHistory h={h} rows={rows} name={playlistName} description="Mes titres les plus écoutés — Sillon" />
      </header>
      <ol className="rows numbered">
        {rows.slice(0, all ? 50 : 10).map((r) => {
          const t = h.tracks[r.key];
          return <TrackRow key={t.key} image={imageOf(t.key)} title={t.name} subtitle={t.artist} href={t.key.startsWith('n:') ? undefined : trackUrl(t.key)} meta={`${r.streams}× · ${hours(r.ms)} h`} />;
        })}
      </ol>
      {rows.length > 10 && (
        <button className="ghost small" onClick={() => setAll(!all)}>
          {all ? 'Réduire' : 'Voir le top 50'}
        </button>
      )}
    </section>
  );
}

function MoodPanel({ h, period, features }: { h: HistoryStore; period: { from: number; to: number }; features: Parameters<typeof moodByMoment>[1] }) {
  const m = useMemo(() => moodByMoment(h, features, period), [h, features, period]);
  const has = m.coverage > 0.05;
  return (
    <section className="panel">
      <header>
        <h3>Humeur × moment</h3>
        <span className="muted small">{has ? `${Math.round(m.coverage * 100)}% du temps d’écoute analysé` : 'lance l’enrichissement'}</span>
      </header>
      {has ? (
        <>
          <p className="small muted">Énergie moyenne selon l’heure</p>
          <Columns bars={m.byHour.map((b, i) => ({ key: String(i), label: `${i}h`, value: Math.round(b.energy * 100) }))} unit="% d’énergie" />
          <p className="small muted">Positivité moyenne selon le mois</p>
          <Columns bars={m.byMonth.map((b, i) => ({ key: String(i), label: MONTHS[i], value: Math.round(b.valence * 100) }))} unit="% de positivité" />
        </>
      ) : (
        <p className="muted small">Il faut les audio-features de tes titres les plus écoutés : clique sur « Enrichir » en haut (les 3 000 titres les plus écoutés sont inclus).</p>
      )}
    </section>
  );
}

function LoyaltyPanel({ h }: { h: HistoryStore }) {
  const rows = useMemo(() => loyalArtists(h), [h]);
  return (
    <Panel title="Fidélité" hint="artistes écoutés sur le plus d’années différentes">
      <BarChart bars={rows.slice(0, 12).map((r) => ({ key: r.artist, label: r.artist, value: r.years }))} format={(v) => `${v} ans`} emptyText="Il faut au moins 3 ans d’historique." />
    </Panel>
  );
}

function TimeView({ h, stats, imageOf }: { h: HistoryStore; stats: ReturnType<typeof computeHistoryStats>; imageOf: (k: string) => string | undefined }) {
  const machine = useMemo(() => timeMachine(h), [h]);
  const years = useMemo(() => yearsSummary(h), [h]);
  const yearAgo = { from: Date.now() - 365 * 86_400_000, to: Infinity };
  const contexts = useMemo(() => CONTEXTS.map((c) => ({ ...c, rows: topTracksWhere(h, yearAgo, c.test, 40) })), [h]);
  const month = MONTHS[new Date().getMonth()];

  return (
    <>
      <section className="panel">
        <header>
          <h3>Machine à remonter le temps</h3>
          <span className="muted small">ce que tu écoutais en {month}, les années précédentes</span>
        </header>
        {machine.length === 0 ? (
          <p className="muted small">Pas encore assez d’historique sur les années passées.</p>
        ) : (
          <div className="cards">
            {machine.map((y) => (
              <div key={y.year} className="card static">
                <div className="card-body">
                  <strong>
                    {month} {y.year}
                  </strong>
                  <ol className="mini">
                    {y.tracks.slice(0, 5).map((r) => (
                      <li key={r.key}>
                        {h.tracks[r.key].name} <span className="muted">— {h.tracks[r.key].artist}</span>
                      </li>
                    ))}
                  </ol>
                  <CreateFromHistory h={h} rows={y.tracks} name={`${month} ${y.year}`} description={`Ce que j’écoutais en ${month} ${y.year} — Sillon`} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <header>
          <h3>Playlists de tes moments</h3>
          <span className="muted small">tes titres les plus écoutés dans chaque contexte, sur 12 mois</span>
        </header>
        <div className="cards">
          {contexts
            .filter((c) => c.rows.length >= 10)
            .map((c) => (
              <div key={c.id} className="card static">
                <div className="card-body">
                  <strong>{c.label}</strong>
                  <span className="muted small">
                    {c.rows
                      .slice(0, 3)
                      .map((r) => h.tracks[r.key].artist)
                      .join(', ')}
                    …
                  </span>
                  <CreateFromHistory h={h} rows={c.rows} name={c.label.replace(/^\p{Extended_Pictographic}️?\s*/u, '')} description="Mes titres de ce moment, d’après mon historique — Sillon" />
                </div>
              </div>
            ))}
        </div>
      </section>

      <div className="grid">
        <Panel title="Nouveaux artistes par mois" hint="première écoute, sur la période">
          <Columns bars={stats.newArtistsPerMonth.map((m) => ({ key: m.key, label: m.key.slice(2).replace('-', '/'), value: m.value }))} unit="artistes" />
        </Panel>
        <Panel title="Découvertes qui ont duré" hint="découverts sur la période, 5 écoutes ou plus">
          <BarChart bars={stats.discoveries.map((d) => ({ key: d.key, label: d.key, value: d.streams }))} format={(v) => `${v}×`} emptyText="Aucune découverte marquante sur cette période." />
        </Panel>
      </div>

      <section className="panel">
        <header>
          <h3>Année par année</h3>
        </header>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Année</th>
                <th className="num">Heures</th>
                <th className="num">Écoutes</th>
                <th className="num">Artistes</th>
                <th className="num">Nouveaux</th>
                <th>Artiste n°1</th>
                <th>Titre n°1</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr key={y.year}>
                  <td>{y.year}</td>
                  <td className="num">{Math.round(y.minutes / 60).toLocaleString('fr-FR')}</td>
                  <td className="num">{y.streams.toLocaleString('fr-FR')}</td>
                  <td className="num">{y.artists.toLocaleString('fr-FR')}</td>
                  <td className="num">{y.newArtists.toLocaleString('fr-FR')}</td>
                  <td>{y.topArtist ?? '—'}</td>
                  <td>
                    {y.topTrack !== undefined ? (
                      <span className="with-img">
                        {imageOf(h.tracks[y.topTrack].key) && <img src={imageOf(h.tracks[y.topTrack].key)} alt="" />}
                        {h.tracks[y.topTrack].name}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
