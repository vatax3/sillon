import { useMemo, useState } from 'react';
import { defaultRule } from '../lib/generator';
import { computeStats } from '../lib/stats';
import { trackUrl } from '../lib/spotify';
import type { Mood, Rule } from '../lib/types';
import { useStore } from '../store';
import { BarChart, Columns } from './ui';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function Dashboard({ onOpenRule }: { onOpenRule: (r: Rule) => void }) {
  const { library, index } = useStore();
  const stats = useMemo(() => computeStats(library!, index!), [library, index]);
  const open = (patch: Partial<Rule>) => onOpenRule({ ...defaultRule(), ...patch });
  const cov = index!.coverage;
  const hasFeatures = stats.profile.length > 0;
  const [allDupes, setAllDupes] = useState(false);

  return (
    <div className="dashboard">
      <section className="kpis">
        <div className="kpi hero">
          <span className="kpi-value">{stats.totalTracks.toLocaleString('fr-FR')}</span>
          <span className="kpi-label">titres analysés</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{stats.likedTracks.toLocaleString('fr-FR')}</span>
          <span className="kpi-label">titres likés</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{stats.totalArtists.toLocaleString('fr-FR')}</span>
          <span className="kpi-label">artistes</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{Math.round(stats.totalHours).toLocaleString('fr-FR')} h</span>
          <span className="kpi-label">d’écoute bout à bout</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{stats.medianYear ?? '—'}</span>
          <span className="kpi-label">année médiane de sortie</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{pct(stats.explicitShare)}</span>
          <span className="kpi-label">de titres explicites</span>
        </div>
      </section>

      {(cov.features < 0.5 || cov.tags < 0.5) && (
        <p className="warn">
          Données partielles : {pct(cov.features)} des titres ont des audio-features et {pct(cov.tags)} des genres.
          Clique sur « Enrichir genres &amp; moods » en haut pour compléter (reprise automatique si tu interromps).
        </p>
      )}

      <div className="grid">
        <Card title="Familles de genres" hint="Clique pour créer une playlist">
          <BarChart bars={stats.families} onSelect={(b) => open({ families: [b.key], sort: 'affinity' })} emptyText="Lance l’enrichissement pour découvrir tes genres." />
        </Card>
        <Card title="Moods" hint={hasFeatures ? 'Mood dominant de chaque titre' : 'Estimés via les tags'}>
          <BarChart bars={stats.moods} onSelect={(b) => open({ moods: [b.key as Mood] })} emptyText="Lance l’enrichissement pour détecter les moods." />
        </Card>
        <Card title="Décennies de sortie">
          <BarChart bars={stats.decades} onSelect={(b) => open({ yearMin: Number(b.key), yearMax: Number(b.key) + 9 })} />
        </Card>
        <Card title="Genres précis" hint="Top 20">
          <BarChart bars={stats.genres} onSelect={(b) => open({ genres: [b.key] })} emptyText="Aucun genre connu pour l’instant." />
        </Card>
        <Card title="Artistes les plus présents" hint="Nombre de titres">
          <BarChart bars={stats.topArtists} onSelect={(b) => open({ artistsInclude: [b.key], sort: 'affinity', maxPerArtist: 0, maxTracks: 100 })} />
        </Card>
        <Card title="Profil sonore" hint="Moyenne de ta bibliothèque">
          <BarChart bars={stats.profile} format={pct} max={1} emptyText="Disponible après l’enrichissement audio." />
        </Card>
        <Card title="Titres likés par année">
          <Columns bars={stats.likedPerYear} unit="titres" />
        </Card>
        <Card title="Nouveaux artistes découverts par année" hint="Premier titre liké de chaque artiste">
          <Columns bars={stats.newArtistsPerYear} unit="artistes" />
        </Card>
      </div>

      <Card title={`Doublons probables dans tes likés (${stats.duplicates.length})`} hint="Même titre, même artiste : versions remaster, single vs album…">
        {stats.duplicates.length === 0 ? (
          <p className="muted small">Aucun doublon détecté. 👌</p>
        ) : (
          <ul className="dupes">
            {stats.duplicates.slice(0, allDupes ? undefined : 6).map((g) => (
              <li key={g.key}>
                <strong>{g.tracks[0].track.name}</strong> <span className="muted">— {g.tracks[0].track.artists[0]?.name}</span>
                <span className="dupe-versions">
                  {g.tracks.map((t) => (
                    <a key={t.track.id} href={trackUrl(t.track.id)} target="_blank" rel="noreferrer" className="tag subtle">
                      {t.track.album.name} ({t.year ?? '?'})
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {stats.duplicates.length > 6 && (
          <button className="ghost small dupes-toggle" onClick={() => setAllDupes(!allDupes)}>
            {allDupes ? 'Réduire' : `Voir les ${stats.duplicates.length}`}
          </button>
        )}
      </Card>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
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
