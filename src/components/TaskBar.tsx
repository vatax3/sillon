import { useStore } from '../store';

/** Barre d'état : progression de la synchro/enrichissement et couverture des données. */
export default function TaskBar() {
  const { task, library, index, sync, enrich, cancel } = useStore();

  if (task) {
    const pct = task.total ? Math.round((task.done / task.total) * 100) : null;
    return (
      <div className="taskbar">
        <div className="task-label">
          <span className="spinner" aria-hidden />
          <span>
            {task.label}
            {task.total ? ` — ${task.done} / ${task.total}` : task.done ? ` — ${task.done}` : ''}
          </span>
        </div>
        <div className="progress" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <div className={pct === null ? 'progress-fill indeterminate' : 'progress-fill'} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
        <button className="ghost small" onClick={cancel}>
          {task.kind === 'enrich' ? 'Mettre en pause' : 'Annuler'}
        </button>
      </div>
    );
  }

  if (!library || !index) return null;
  const { coverage } = index;
  const needsEnrich = coverage.features < 0.5 || coverage.artistsTagged / Math.max(1, coverage.artistsTotal) < 0.5;
  return (
    <div className="taskbar idle">
      <span className="muted">
        Synchro {new Date(library.syncedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
      </span>
      <span className="pill" title="Titres pour lesquels on connaît énergie, tempo, positivité…">
        Audio {Math.round(coverage.features * 100)}%
      </span>
      <span className="pill" title="Titres dont au moins un artiste a des genres connus">
        Genres {Math.round(coverage.tags * 100)}%
      </span>
      <span className="spacer" />
      <button className="ghost small" onClick={sync}>
        Resynchroniser
      </button>
      <button className={needsEnrich ? 'primary small' : 'ghost small'} onClick={enrich}>
        {needsEnrich ? 'Enrichir genres & moods' : 'Compléter l’enrichissement'}
      </button>
    </div>
  );
}
