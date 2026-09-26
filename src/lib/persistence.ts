// Où vivent les documents de l'app : IndexedDB (mode local) ou le serveur (mode serveur).
import { kvClear, kvGet as idbGet, kvSet as idbSet } from './db';
import * as remote from './remote';

export interface Persistence {
  readonly server: boolean;
  load<T>(key: string): Promise<T | undefined>;
  /**
   * Enregistre un document. En mode serveur, s'il a changé ailleurs (autre appareil, tâche planifiée) :
   * avec `rebase`, la modification est réappliquée sur la version à jour ; sans, la version du serveur
   * l'emporte. `replaced` indique la valeur finalement retenue quand elle diffère de celle fournie.
   */
  save<T>(key: string, value: T, rebase?: (fresh: T | undefined) => T): Promise<{ replaced?: T }>;
  /** Documents modifiés côté serveur depuis leur dernier chargement. */
  changedKeys(): Promise<string[]>;
  clear(): Promise<void>;
}

export const localPersistence: Persistence = {
  server: false,
  load: idbGet,
  save: async (key, value) => {
    await idbSet(key, value);
    return {};
  },
  changedKeys: async () => [],
  clear: kvClear,
};

export function serverPersistence(): Persistence {
  const revs = new Map<string, number>();
  // Écritures d'un même document sérialisées : chacune part de la révision laissée par la précédente.
  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <R>(key: string, fn: () => Promise<R>): Promise<R> => {
    const p = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(key, p.catch(() => undefined));
    return p;
  };

  return {
    server: true,
    async load<T>(key: string) {
      const r = await remote.kvGet<T>(key);
      revs.set(key, r?.rev ?? 0);
      return r?.value;
    },
    save<T>(key: string, value: T, rebase?: (fresh: T | undefined) => T) {
      return enqueue(key, async () => {
        let v = value;
        for (let attempt = 0; attempt < 4; attempt++) {
          const res = await remote.kvPut(key, v, revs.get(key) ?? 0);
          if (res.ok) {
            revs.set(key, res.rev);
            return v === value ? {} : { replaced: v };
          }
          const fresh = await remote.kvGet<T>(key);
          revs.set(key, fresh?.rev ?? 0);
          if (!rebase) return { replaced: fresh?.value };
          v = rebase(fresh?.value);
        }
        throw new Error(`Modifications concurrentes répétées sur « ${key} », réessaie.`);
      });
    },
    async changedKeys() {
      const current = await remote.revs();
      return Object.entries(current)
        .filter(([k, rev]) => (revs.get(k) ?? 0) < rev)
        .map(([k]) => k);
    },
    clear: async () => undefined,
  };
}
