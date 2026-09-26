import { useState } from 'react';
import { JOB_LABELS, type AutoPlaylist, type Automations, type Frequency, type JobKind, type JobRun, type Schedule } from '../lib/automations';
import { testNotification } from '../lib/remote';
import { playlistUrl } from '../lib/spotify';
import { useStore } from '../store';
import { AsyncButton } from './ui';

const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function SchedulePicker({ value, onChange, allowHourly }: { value: Schedule; onChange: (s: Schedule) => void; allowHourly?: boolean }) {
  return (
    <span className="schedule">
      <select value={value.freq} onChange={(e) => onChange({ ...value, freq: e.target.value as Frequency, day: e.target.value === 'weekly' ? 1 : value.day })} aria-label="Fréquence">
        {allowHourly && <option value="hourly">Toutes les heures</option>}
        <option value="daily">Tous les jours</option>
        <option value="weekly">Chaque semaine</option>
        <option value="monthly">Chaque mois</option>
      </select>
      {value.freq === 'weekly' && (
        <select value={value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })} aria-label="Jour">
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i + 1}>
              le {d}
            </option>
          ))}
        </select>
      )}
      {value.freq === 'monthly' && (
        <select value={value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })} aria-label="Jour du mois">
          {Array.from({ length: 28 }, (_, i) => (
            <option key={i} value={i + 1}>
              le {i + 1 === 1 ? '1er' : i + 1}
            </option>
          ))}
        </select>
      )}
      {value.freq !== 'hourly' && (
        <select value={value.hour} onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })} aria-label="Heure">
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              à {h}h
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

const fmtDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const duration = (r: JobRun) => {
  if (!r.finishedAt) return '';
  const s = (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.round(s / 60)} min`;
};

export default function AutomationsPage() {
  const store = useStore();
  const a = store.automations;
  const set = (fn: (a: Automations) => Automations) => store.updateAutomations(fn);
  const jobs = store.serverJobs;
  const running = new Set(jobs?.running ?? []);
  const nextOf = (kind: JobKind, target?: string) => jobs?.next.find((n) => n.kind === kind && (target === undefined || n.target === target));
  const run = (kind: JobKind, target?: string) => store.runServerJob(kind, target);
  const isRunning = (kind: JobKind, target?: string) => jobs?.runs.some((r) => running.has(r.id) && r.kind === kind && (target === undefined || r.target === target));
  const living = store.saved;

  const Row = ({ kind, children, target }: { kind: JobKind; children?: React.ReactNode; target?: string }) => {
    const next = nextOf(kind, target);
    const last = jobs?.runs.find((r) => r.kind === kind && (target === undefined || r.target === target) && r.status !== 'running');
    return (
      <div className="auto-meta small">
        {next && <span className="muted">Prochaine : {fmtDate(next.at)}</span>}
        {last && (
          <span className={last.status === 'error' ? 'error-text' : 'muted'}>
            Dernière : {fmtDate(last.startedAt)} · {last.status === 'ok' ? '✓' : '✗'} {last.message}
          </span>
        )}
        <span className="spacer" />
        {children}
        <AsyncButton disabled={isRunning(kind, target)} onClick={() => run(kind, target)}>
          {isRunning(kind, target) ? 'En cours…' : 'Lancer maintenant'}
        </AsyncButton>
      </div>
    );
  };

  const autoCard = <K extends 'discoveries' | 'radar' | 'timeMachine' | 'monthlyTop'>(key: K, title: string, hint: string, extra?: React.ReactNode) => {
    const conf = a[key] as AutoPlaylist;
    return (
      <section className={conf.enabled ? 'panel auto on' : 'panel auto'}>
        <header>
          <label className="check auto-title">
            <input type="checkbox" checked={conf.enabled} onChange={(e) => set((x) => ({ ...x, [key]: { ...x[key], enabled: e.target.checked } }))} />
            <h3>{title}</h3>
          </label>
          {conf.playlistId && (
            <a className="small" href={playlistUrl(conf.playlistId)} target="_blank" rel="noreferrer">
              Ouvrir la playlist ↗
            </a>
          )}
        </header>
        <p className="muted small">{hint}</p>
        <SchedulePicker value={conf.schedule} onChange={(schedule) => set((x) => ({ ...x, [key]: { ...x[key], schedule } }))} />
        {!conf.playlistId && (
          <label className="field">
            <span>Nom de la playlist (à la création)</span>
            <input value={conf.name} onChange={(e) => set((x) => ({ ...x, [key]: { ...x[key], name: e.target.value } }))} />
          </label>
        )}
        {extra}
        <Row kind={key} />
      </section>
    );
  };

  return (
    <div className="automations">
      <p className="muted">
        Ces tâches tournent sur ton serveur, même quand l’app est fermée (fuseau {store.server?.timezone}). Chaque playlist automatique
        réutilise la même playlist Spotify d’une fois sur l’autre : son lien ne change pas.
      </p>

      <div className="grid">
        <section className={a.recordHistory ? 'panel auto on' : 'panel auto'}>
          <header>
            <label className="check auto-title">
              <input type="checkbox" checked={a.recordHistory} onChange={(e) => set((x) => ({ ...x, recordHistory: e.target.checked }))} />
              <h3>Historique d’écoute continu</h3>
            </label>
          </header>
          <p className="muted small">Relève tes 50 dernières écoutes toutes les 30 minutes : ton historique reste complet sans rien faire (remplace le worker Cloudflare).</p>
          <Row kind="record" />
        </section>

        <section className={a.librarySync.enabled ? 'panel auto on' : 'panel auto'}>
          <header>
            <label className="check auto-title">
              <input type="checkbox" checked={a.librarySync.enabled} onChange={(e) => set((x) => ({ ...x, librarySync: { ...x.librarySync, enabled: e.target.checked } }))} />
              <h3>Synchro de la bibliothèque</h3>
            </label>
          </header>
          <p className="muted small">Likés, playlists, tops, artistes suivis ; sauvegarde des playlists si elles ont changé.</p>
          <div className="row wrap">
            <SchedulePicker value={a.librarySync.schedule} onChange={(schedule) => set((x) => ({ ...x, librarySync: { ...x.librarySync, schedule } }))} />
            <label className="check">
              <input type="checkbox" checked={a.librarySync.enrich} onChange={(e) => set((x) => ({ ...x, librarySync: { ...x.librarySync, enrich: e.target.checked } }))} />
              puis enrichir (genres & moods)
            </label>
          </div>
          <Row kind="sync">
            <AsyncButton disabled={isRunning('enrich')} onClick={() => run('enrich')}>
              Enrichir seulement
            </AsyncButton>
          </Row>
        </section>
      </div>

      <section className={a.livingRefresh ? 'panel auto on' : 'panel auto'}>
        <header>
          <label className="check auto-title">
            <input type="checkbox" checked={a.livingRefresh} onChange={(e) => set((x) => ({ ...x, livingRefresh: e.target.checked }))} />
            <h3>Playlists vivantes</h3>
          </label>
        </header>
        <p className="muted small">Nouveau tirage automatique selon leur recette, en gardant tes titres épinglés et exclus.</p>
        {living.length === 0 ? (
          <p className="muted small">Aucune playlist vivante : crée-en depuis Playlists › Suggestions ou Créateur.</p>
        ) : (
          <ul className="living-schedules">
            {living.map((s) => (
              <li key={s.spotifyId}>
                <a href={playlistUrl(s.spotifyId)} target="_blank" rel="noreferrer" className="living-name">
                  {s.name}
                </a>
                <span className="row">
                  <select
                    value={s.schedule ? 'on' : 'off'}
                    onChange={(e) => store.setLivingSchedule(s.spotifyId, e.target.value === 'on' ? { freq: 'weekly', day: 1, hour: 6 } : null)}
                    aria-label={`Actualisation de ${s.name}`}
                  >
                    <option value="off">Manuelle</option>
                    <option value="on">Automatique</option>
                  </select>
                  {s.schedule && <SchedulePicker value={s.schedule} onChange={(sc) => store.setLivingSchedule(s.spotifyId, sc)} />}
                </span>
                <Row kind="living" target={s.spotifyId} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid">
        {autoCard(
          'discoveries',
          'Découvertes de la semaine',
          'Titres d’artistes proches de tes écoutes, jamais écoutés ni déjà proposés les semaines précédentes.',
          <div className="row wrap">
            <label className="field narrow">
              <span>Titres</span>
              <input type="number" min={10} max={80} value={a.discoveries.size} onChange={(e) => set((x) => ({ ...x, discoveries: { ...x.discoveries, size: Math.max(5, Math.min(80, Number(e.target.value) || 30)) } }))} />
            </label>
            <label className="field">
              <span>D’après</span>
              <select value={a.discoveries.seed} onChange={(e) => set((x) => ({ ...x, discoveries: { ...x.discoveries, seed: e.target.value as 'recent' | 'alltime' } }))}>
                <option value="recent">mes écoutes récentes</option>
                <option value="alltime">mes favoris de toujours</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={a.discoveries.unknownOnly} onChange={(e) => set((x) => ({ ...x, discoveries: { ...x.discoveries, unknownOnly: e.target.checked } }))} />
              artistes inconnus uniquement
            </label>
          </div>,
        )}
        {autoCard(
          'radar',
          'Radar de sorties',
          'Nouveaux albums et singles de tes artistes (suivis, tops, les plus présents), avec notification des nouveautés.',
          <div className="row wrap">
            <label className="field narrow">
              <span>Fenêtre</span>
              <select value={a.radar.days} onChange={(e) => set((x) => ({ ...x, radar: { ...x.radar, days: Number(e.target.value) } }))}>
                <option value={7}>7 jours</option>
                <option value={14}>14 jours</option>
                <option value={30}>30 jours</option>
              </select>
            </label>
            <label className="field">
              <span>Pour les albums</span>
              <select value={a.radar.albumTracks} onChange={(e) => set((x) => ({ ...x, radar: { ...x.radar, albumTracks: e.target.value as 'all' | 'first3' } }))}>
                <option value="first3">les 3 premiers titres</option>
                <option value="all">tous les titres</option>
              </select>
            </label>
          </div>,
        )}
        {autoCard('timeMachine', 'Il y a un an', 'Tes titres les plus écoutés à la même époque l’an dernier (nécessite un historique).')}
        {autoCard(
          'monthlyTop',
          'Top du mois',
          'Tes titres les plus écoutés le mois précédent (nécessite un historique).',
          <label className="field narrow">
            <span>Titres</span>
            <input type="number" min={10} max={100} value={a.monthlyTop.size} onChange={(e) => set((x) => ({ ...x, monthlyTop: { ...x.monthlyTop, size: Math.max(5, Math.min(100, Number(e.target.value) || 40)) } }))} />
          </label>,
        )}
      </div>

      <div className="grid">
        <section className={a.backups.enabled ? 'panel auto on' : 'panel auto'}>
          <header>
            <label className="check auto-title">
              <input type="checkbox" checked={a.backups.enabled} onChange={(e) => set((x) => ({ ...x, backups: { ...x.backups, enabled: e.target.checked } }))} />
              <h3>Sauvegardes</h3>
            </label>
            <a className="small" href="/api/export">
              Télécharger un export complet
            </a>
          </header>
          <p className="muted small">Instantané des playlists + export JSON complet dans <code>/data/exports</code> sur le serveur.</p>
          <div className="row wrap">
            <SchedulePicker value={a.backups.schedule} onChange={(schedule) => set((x) => ({ ...x, backups: { ...x.backups, schedule } }))} />
            <label className="field narrow">
              <span>Garder</span>
              <select value={a.backups.keep} onChange={(e) => set((x) => ({ ...x, backups: { ...x.backups, keep: Number(e.target.value) } }))}>
                {[7, 14, 30, 90].map((n) => (
                  <option key={n} value={n}>
                    {n} dernières
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Row kind="backup" />
        </section>

        <Notifications />
      </div>

      <JobLog />
    </div>
  );
}

function Notifications() {
  const store = useStore();
  const n = store.automations.notifications;
  const [draft, setDraft] = useState(n);
  const [result, setResult] = useState<string | null>(null);
  const dirty = draft.ntfyUrl !== n.ntfyUrl || draft.discordUrl !== n.discordUrl || draft.webhookUrl !== n.webhookUrl;
  const setFlag = (k: 'onReleases' | 'onPlaylists' | 'onFailures', v: boolean) => store.updateAutomations((x) => ({ ...x, notifications: { ...x.notifications, [k]: v } }));

  return (
    <section className="panel auto on">
      <header>
        <h3>Notifications</h3>
      </header>
      <p className="muted small">
        Sur ton téléphone avec l’appli gratuite{' '}
        <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
          ntfy
        </a>{' '}
        (abonne-toi à un topic difficile à deviner), sur Discord, ou n’importe quel webhook.
      </p>
      <label className="field">
        <span>Topic ntfy</span>
        <input value={draft.ntfyUrl} onChange={(e) => setDraft({ ...draft, ntfyUrl: e.target.value.trim() })} placeholder="https://ntfy.sh/sillon-xxxxxxxx" spellCheck={false} />
      </label>
      <label className="field">
        <span>Webhook Discord</span>
        <input value={draft.discordUrl} onChange={(e) => setDraft({ ...draft, discordUrl: e.target.value.trim() })} placeholder="https://discord.com/api/webhooks/…" spellCheck={false} />
      </label>
      <label className="field">
        <span>Webhook générique (POST JSON)</span>
        <input value={draft.webhookUrl} onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value.trim() })} placeholder="https://…" spellCheck={false} />
      </label>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={n.onReleases} onChange={(e) => setFlag('onReleases', e.target.checked)} /> Nouvelles sorties de mes artistes
        </label>
        <label className="check">
          <input type="checkbox" checked={n.onPlaylists} onChange={(e) => setFlag('onPlaylists', e.target.checked)} /> Chaque playlist générée
        </label>
        <label className="check">
          <input type="checkbox" checked={n.onFailures} onChange={(e) => setFlag('onFailures', e.target.checked)} /> Échecs de tâches (ex. accès Spotify révoqué)
        </label>
      </div>
      <div className="row">
        <button className="primary small" disabled={!dirty} onClick={() => store.updateAutomations((x) => ({ ...x, notifications: { ...x.notifications, ...draft } }))}>
          Enregistrer
        </button>
        <AsyncButton
          disabled={dirty || !(n.ntfyUrl || n.discordUrl || n.webhookUrl)}
          onClick={async () => {
            setResult(null);
            const r = await testNotification();
            setResult(r.sent.length ? `Envoyée via ${r.sent.join(', ')}.` : 'Aucun canal configuré.');
          }}
        >
          Envoyer un test
        </AsyncButton>
        {result && <span className="success small">{result}</span>}
      </div>
    </section>
  );
}

function JobLog() {
  const store = useStore();
  const jobs = store.serverJobs;
  const [all, setAll] = useState(false);
  const nameOf = (r: JobRun) => (r.kind === 'living' ? `« ${store.saved.find((s) => s.spotifyId === r.target)?.name ?? 'playlist'} »` : '');
  if (!jobs) return null;
  const runs = all ? jobs.runs : jobs.runs.slice(0, 12);
  return (
    <section className="panel">
      <header>
        <h3>Journal</h3>
        {jobs.next[0] && (
          <span className="muted small">
            Prochaine tâche : {JOB_LABELS[jobs.next[0].kind]} {fmtDate(jobs.next[0].at)}
          </span>
        )}
      </header>
      {runs.length === 0 ? (
        <p className="muted small">Aucune exécution pour l’instant.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tâche</th>
                <th>Début</th>
                <th>Durée</th>
                <th>Résultat</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={`run ${r.status}`}>
                  <td>
                    <span className={`dot ${r.status}`} aria-hidden /> {JOB_LABELS[r.kind]} {nameOf(r)}
                    {r.trigger === 'manual' && <span className="muted small"> · manuel</span>}
                  </td>
                  <td className="muted">{fmtDate(r.startedAt)}</td>
                  <td className="num muted">{r.status === 'running' ? '…' : duration(r)}</td>
                  <td>
                    {r.status === 'running'
                      ? r.progress
                        ? `${r.progress.label}${r.progress.total ? ` — ${r.progress.done}/${r.progress.total}` : ''}`
                        : 'En cours…'
                      : r.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {jobs.runs.length > 12 && (
        <button className="ghost small" onClick={() => setAll(!all)}>
          {all ? 'Réduire' : `Voir les ${jobs.runs.length}`}
        </button>
      )}
    </section>
  );
}

