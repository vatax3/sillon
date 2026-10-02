// Planificateur : un jeu de tâches cron par utilisateur, reconstruit dès que sa configuration change.
// Une même tâche (ex. synchro) ne tourne jamais deux fois en parallèle pour un même compte,
// ni la synchro en même temps que l'enrichissement.
import { Cron } from 'croner';
import { JOB_LABELS, toCron, withDefaults, type Automations, type JobKind, type JobRun, type Schedule } from '../src/lib/automations';
import type { SavedPlaylist } from '../src/lib/types';
import { runAs } from './auth';
import { config } from './config';
import { finishRun, getDoc, getUser, listUsers, onDocChange, progressRun, pruneRuns, startRun } from './db';
import { notify } from './notify';
import { TASKS } from './tasks';

const running = new Map<string, { runId: number; controller: AbortController }>();
const crons = new Map<string, Cron[]>();
const runKey = (userId: string, kind: JobKind, target?: string) => `${userId}:${kind}:${target ?? ''}`;
// La synchro enchaîne sur l'enrichissement : les deux écrivent les mêmes documents (features, tags)
// et ne doivent jamais tourner ensemble, sous peine d'écraser le travail de l'autre.
const lockKey = (userId: string, kind: JobKind, target?: string) => runKey(userId, kind === 'enrich' ? 'sync' : kind, target);

export interface NextRun {
  kind: JobKind;
  target?: string;
  at: string;
}

/** Lance une tâche (planifiée ou manuelle). Ne rejette jamais : le résultat va dans le journal. */
export async function runJob(userId: string, kind: Exclude<JobKind, 'import'>, trigger: JobRun['trigger'], target?: string): Promise<number | null> {
  const key = lockKey(userId, kind, target);
  if (running.has(key)) return null;
  const user = getUser(userId);
  if (!user || user.needs_reauth) return null;
  const runId = startRun(userId, kind, trigger, target);
  const controller = new AbortController();
  running.set(key, { runId, controller });
  let lastProgress = 0;
  const started = Date.now();
  const log = (status: string, msg: string) =>
    console.log(`[job] ${userId} ${kind}${target ? `(${target})` : ''} ${status} en ${((Date.now() - started) / 1000).toFixed(1)} s — ${msg}`);
  try {
    const message = await runAs(userId, () =>
      TASKS[kind]({
        userId,
        target,
        signal: controller.signal,
        progress: (label, done, total) => {
          // Au plus une écriture par seconde dans la base.
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          progressRun(runId, { label, done, total });
        },
      }),
    );
    finishRun(runId, 'ok', message);
    log('ok', message);
  } catch (e) {
    const message = controller.signal.aborted ? 'Arrêtée' : e instanceof Error ? e.message : String(e);
    finishRun(runId, 'error', message);
    log('erreur', message);
    if (!controller.signal.aborted) {
      await notify(userId, 'failure', `Échec : ${JOB_LABELS[kind]}`, message).catch(() => undefined);
    }
  } finally {
    running.delete(key);
    pruneRuns(userId);
  }
  return runId;
}

export function cancelJob(userId: string, runId: number): boolean {
  for (const [key, r] of running) {
    if (r.runId === runId && key.startsWith(`${userId}:`)) {
      r.controller.abort();
      return true;
    }
  }
  return false;
}

/** Reconstruit les tâches cron d'un utilisateur à partir de sa configuration. */
export function schedule(userId: string) {
  for (const c of crons.get(userId) ?? []) c.stop();
  const a = withDefaults(getDoc<Partial<Automations>>(userId, 'automations'));
  const saved = getDoc<SavedPlaylist[]>(userId, 'saved') ?? [];
  const jobs: Cron[] = [];
  const add = (pattern: string, kind: Exclude<JobKind, 'import'>, target?: string) => {
    const c = new Cron(pattern, { timezone: config.timezone, protect: true, name: runKey(userId, kind, target) }, () => {
      void runJob(userId, kind, 'schedule', target);
    });
    jobs.push(c);
  };
  const at = (s: Schedule) => toCron(s);

  if (a.recordHistory) add('*/30 * * * *', 'record');
  if (a.librarySync.enabled) add(at(a.librarySync.schedule), 'sync');
  if (a.backups.enabled) add(at(a.backups.schedule), 'backup');
  for (const k of ['discoveries', 'radar', 'timeMachine', 'monthlyTop'] as const) {
    if (a[k].enabled) add(at(a[k].schedule), k);
  }
  if (a.livingRefresh) {
    for (const s of saved) if (s.schedule) add(at(s.schedule), 'living', s.spotifyId);
  }
  crons.set(userId, jobs);
}

export function nextRuns(userId: string): NextRun[] {
  const out: NextRun[] = [];
  for (const c of crons.get(userId) ?? []) {
    const [, kind, target] = (c.name ?? '').split(':');
    const next = c.nextRun();
    if (next) out.push({ kind: kind as JobKind, target: target || undefined, at: next.toISOString() });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export const runningRuns = (userId: string) => [...running.entries()].filter(([k]) => k.startsWith(`${userId}:`)).map(([, r]) => r.runId);

export function startScheduler() {
  for (const u of listUsers()) schedule(u.id);
  // Toute modification de la configuration ou des playlists vivantes replanifie immédiatement.
  onDocChange((userId, key) => {
    if (key === 'automations' || key === 'saved') schedule(userId);
  });
  console.log(`[sillon] planificateur démarré (${listUsers().length} compte(s), fuseau ${config.timezone})`);
}

export function stopScheduler() {
  for (const list of crons.values()) for (const c of list) c.stop();
  for (const r of running.values()) r.controller.abort();
}
