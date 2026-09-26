// Automatisations (mode serveur) : configuration partagée entre l'interface et le planificateur.

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface Schedule {
  freq: Frequency;
  /** weekly : 1 (lundi) … 7 (dimanche) ; monthly : 1 … 28. */
  day: number;
  hour: number;
  minute?: number;
}

export interface AutoPlaylist {
  enabled: boolean;
  schedule: Schedule;
  name: string;
  /** Playlist Spotify réutilisée d'une exécution à l'autre (créée au premier passage). */
  playlistId?: string;
}

export interface Automations {
  /** Relève des 50 dernières écoutes toutes les 30 min (historique continu). */
  recordHistory: boolean;
  librarySync: { enabled: boolean; schedule: Schedule; enrich: boolean };
  /** Active le planning individuel des playlists vivantes. */
  livingRefresh: boolean;
  discoveries: AutoPlaylist & { size: number; seed: 'recent' | 'alltime'; unknownOnly: boolean };
  radar: AutoPlaylist & { days: number; albumTracks: 'all' | 'first3' };
  timeMachine: AutoPlaylist;
  monthlyTop: AutoPlaylist & { size: number };
  backups: { enabled: boolean; schedule: Schedule; keep: number };
  notifications: {
    /** URL d'un topic ntfy (https://ntfy.sh/mon-topic ou ton instance). */
    ntfyUrl: string;
    /** Webhook Discord. */
    discordUrl: string;
    /** Webhook générique (POST JSON). */
    webhookUrl: string;
    onReleases: boolean;
    onPlaylists: boolean;
    onFailures: boolean;
  };
}

export const defaultAutomations = (): Automations => ({
  recordHistory: true,
  librarySync: { enabled: true, schedule: { freq: 'daily', day: 1, hour: 4 }, enrich: true },
  livingRefresh: true,
  discoveries: { enabled: false, schedule: { freq: 'weekly', day: 1, hour: 7 }, name: 'Découvertes de la semaine', size: 30, seed: 'recent', unknownOnly: true },
  radar: { enabled: false, schedule: { freq: 'weekly', day: 5, hour: 8 }, name: 'Radar de sorties', days: 7, albumTracks: 'first3' },
  timeMachine: { enabled: false, schedule: { freq: 'monthly', day: 1, hour: 9 }, name: 'Il y a un an' },
  monthlyTop: { enabled: false, schedule: { freq: 'monthly', day: 1, hour: 9, minute: 30 }, name: 'Mon top du mois', size: 40 },
  backups: { enabled: true, schedule: { freq: 'daily', day: 1, hour: 3 }, keep: 30 },
  notifications: { ntfyUrl: '', discordUrl: '', webhookUrl: '', onReleases: true, onPlaylists: false, onFailures: true },
});

/** Complète une configuration enregistrée avec les nouveaux champs par défaut. */
export function withDefaults(saved: Partial<Automations> | undefined): Automations {
  const d = defaultAutomations();
  if (!saved) return d;
  const merged = { ...d, ...saved } as Automations;
  for (const k of ['librarySync', 'discoveries', 'radar', 'timeMachine', 'monthlyTop', 'backups', 'notifications'] as const) {
    (merged as unknown as Record<string, unknown>)[k] = { ...d[k], ...(saved[k] ?? {}) };
  }
  return merged;
}

/** Schedule → expression cron (minute heure jour-du-mois mois jour-de-semaine). */
export function toCron(s: Schedule): string {
  const m = s.minute ?? 0;
  switch (s.freq) {
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${s.hour} * * *`;
    case 'weekly':
      return `${m} ${s.hour} * * ${s.day % 7}`; // cron : 0 = dimanche
    case 'monthly':
      return `${m} ${s.hour} ${Math.min(Math.max(s.day, 1), 28)} * *`;
  }
}

const DAYS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function describeSchedule(s: Schedule): string {
  const at = `${s.hour}h${String(s.minute ?? 0).padStart(2, '0')}`;
  switch (s.freq) {
    case 'hourly':
      return `toutes les heures (à :${String(s.minute ?? 0).padStart(2, '0')})`;
    case 'daily':
      return `tous les jours à ${at}`;
    case 'weekly':
      return `chaque ${DAYS[s.day]} à ${at}`;
    case 'monthly':
      return `le ${s.day === 1 ? '1er' : s.day} de chaque mois à ${at}`;
  }
}

// ---------- Suivi des exécutions ----------

export type JobKind =
  | 'record'
  | 'sync'
  | 'enrich'
  | 'living'
  | 'discoveries'
  | 'radar'
  | 'timeMachine'
  | 'monthlyTop'
  | 'backup'
  | 'import';

export const JOB_LABELS: Record<JobKind, string> = {
  record: 'Relève des écoutes',
  sync: 'Synchro de la bibliothèque',
  enrich: 'Enrichissement genres & moods',
  living: 'Actualisation d’une playlist vivante',
  discoveries: 'Découvertes de la semaine',
  radar: 'Radar de sorties',
  timeMachine: 'Il y a un an',
  monthlyTop: 'Top du mois',
  backup: 'Sauvegarde',
  import: 'Import d’historique',
};

export interface JobRun {
  id: number;
  kind: JobKind;
  /** Détail (ex. id de playlist vivante). */
  target?: string;
  status: 'running' | 'ok' | 'error' | 'skipped';
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string;
  message?: string;
  progress?: { label: string; done: number; total?: number };
}

/** État mémorisé entre exécutions (pour ne pas reproposer ni renotifier la même chose). */
export interface AutoState {
  recommended: string[];
  /** Clés artiste|titre des titres déjà recommandés (écartés avant même la recherche Spotify). */
  recommendedNames: string[];
  radarSeen: string[];
  historyCursor: number;
}

export const emptyAutoState = (): AutoState => ({ recommended: [], recommendedNames: [], radarSeen: [], historyCursor: 0 });
