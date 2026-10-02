import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { logout as clearTokens, missingScopes } from './lib/auth';
import { withDefaults, type Automations, type JobKind, type Schedule } from './lib/automations';
import { localPersistence, serverPersistence } from './lib/persistence';
import * as remote from './lib/remote';
import { SCOPES } from './lib/scopes';
import { dedupeSongs, dedupeUris, SongSet, trackRef } from './lib/dedupe';
import { applyManualEdits } from './lib/editor';
import { fetchArtistTags, fetchAudioFeatures } from './lib/enrich';
import { livingRefresh } from './lib/generator';
import { emptyHistory, mergePlays, playsFromApi, readExportFiles, type HistoryStore, type RawPlay } from './lib/history';
import { mostPlayedIds } from './lib/historyStats';
import { HttpError, isAbort } from './lib/http';
import { artistsByImportance, buildIndex, type EnrichedTrack, type LibraryIndex } from './lib/indexer';
import type { TasteCard } from './lib/social';
import * as sp from './lib/spotify';
import { syncLibrary } from './lib/sync';
import { sameSnapshot, snapshot } from './lib/tools';
import type { FeatureStore, Library, PlaylistBackup, Rule, SavedPlaylist, Settings, TagStore } from './lib/types';

export interface TaskState {
  kind: 'sync' | 'enrich';
  label: string;
  done: number;
  total?: number;
  /** Mode serveur : exécution suivie (annulable). */
  serverRunId?: number;
}

interface Store {
  ready: boolean;
  library: Library | null;
  index: LibraryIndex | null;
  tags: TagStore;
  features: FeatureStore;
  saved: SavedPlaylist[];
  history: HistoryStore | null;
  backups: PlaylistBackup[];
  friends: TasteCard[];
  settings: Settings;
  task: TaskState | null;
  error: string | null;
  notice: string | null;
  needsReauth: boolean;
  /** Incrémenté après chaque commande de lecture, pour que la barre de lecture se rafraîchisse. */
  playerTick: number;
  artistName: (id: string) => string;
  sync: () => Promise<void>;
  enrich: () => Promise<void>;
  cancel: () => void;
  createPlaylist: (p: { name: string; description: string; isPublic: boolean; tracks: EnrichedTrack[]; rule: Rule; pool?: string[] }) => Promise<SavedPlaylist>;
  /** Crée une playlist sans doublons (sauf `exact`, ex. restauration) ; renvoie son id et le nombre de titres envoyés. */
  createSimplePlaylist: (name: string, description: string, uris: string[], opts?: { exact?: boolean }) => Promise<{ id: string; count: number }>;
  refreshSaved: (s: SavedPlaylist) => Promise<void>;
  forgetSaved: (id: string) => void;
  updateSavedRule: (id: string, rule: Rule) => void;
  likeTracks: (trackIds: string[]) => Promise<void>;
  followArtists: (artistIds: string[]) => Promise<void>;
  /** Ajoute les titres absents de la playlist (ni le même titre, ni une autre version) ; renvoie le nombre ajouté. */
  addToPlaylist: (playlistId: string, trackIds: string[]) => Promise<number>;
  rewritePlaylist: (playlistId: string, trackIds: string[], reason: string) => Promise<void>;
  createBackup: () => Promise<void>;
  restoreFromBackup: (backupId: string, playlistId: string) => Promise<void>;
  savePlaylistEdit: (p: PlaylistEdit) => Promise<void>;
  /** Demande d'ouverture de l'éditeur (lue par l'onglet Playlists). */
  editRequest: { id: string; nonce: number } | null;
  openEditor: (playlistId: string | null) => void;
  importHistory: (files: FileList | File[]) => Promise<{ added: number; skipped: string[] }>;
  pullWorker: (quiet?: boolean) => Promise<number>;
  clearHistory: () => Promise<void>;
  addFriend: (card: TasteCard) => void;
  removeFriend: (name: string, createdAt: string) => void;
  playUris: (uris: string[], offset?: number) => Promise<void>;
  playContext: (contextUri: string) => Promise<void>;
  queueUri: (uri: string) => Promise<void>;
  bumpPlayer: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  report: (e: unknown) => void;
  say: (msg: string) => void;
  dismiss: () => void;
  resetAll: () => Promise<void>;
  logout: () => void;
  // ---- Mode serveur ----
  server: remote.ServerConfig | null;
  automations: Automations;
  updateAutomations: (fn: (a: Automations) => Automations) => void;
  serverJobs: remote.JobsState | null;
  runServerJob: (kind: JobKind, target?: string) => Promise<void>;
  setLivingSchedule: (playlistId: string, schedule: Schedule | null) => void;
}

export interface PlaylistEdit {
  id: string;
  name: string;
  description: string;
  /** Contenu final, dans l'ordre. */
  uris: string[];
  /** État à l'ouverture de l'éditeur (pour la sauvegarde et les playlists vivantes). */
  before: { name: string; description: string; uris: string[]; snapshotId: string };
  /** Écrase même si la playlist a changé ailleurs depuis l'ouverture. */
  force?: boolean;
}

export class PlaylistConflictError extends Error {}

const Ctx = createContext<Store | null>(null);

const DEFAULT_SETTINGS: Settings = {
  lastfmKey: '',
  playlistPrefix: '',
  publicByDefault: false,
  workerUrl: '',
  workerKey: '',
  autoRefreshDays: 0,
};
const K_SETTINGS = 'sillon.settings';
const MAX_BACKUPS = 15;

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(K_SETTINGS) || '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function StoreProvider({ children, onLogout, server = null }: { children: ReactNode; onLogout: () => void; server?: remote.ServerConfig | null }) {
  const persist = useMemo(() => (server ? serverPersistence() : localPersistence), [server]);
  const [ready, setReady] = useState(false);
  const [library, setLibraryState] = useState<Library | null>(null);
  const [tags, setTags] = useState<TagStore>({});
  const [features, setFeatures] = useState<FeatureStore>({});
  const [saved, setSaved] = useState<SavedPlaylist[]>([]);
  const [history, setHistory] = useState<HistoryStore | null>(null);
  const [backups, setBackups] = useState<PlaylistBackup[]>([]);
  const [friends, setFriends] = useState<TasteCard[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [task, setTask] = useState<TaskState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playerTick, setPlayerTick] = useState(0);
  const [editRequest, setEditRequest] = useState<Store['editRequest']>(null);
  const [automations, setAutomations] = useState<Automations>(withDefaults(undefined));
  const [serverJobs, setServerJobs] = useState<remote.JobsState | null>(null);
  const [serverScope, setServerScope] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Références à jour pour les actions asynchrones enchaînées (évite les closures périmées).
  const libRef = useRef<Library | null>(null);
  const historyRef = useRef<HistoryStore | null>(null);

  const setLibrary = (lib: Library | null) => {
    libRef.current = lib;
    setLibraryState(lib);
  };
  const setHistoryState = (h: HistoryStore | null) => {
    historyRef.current = h;
    setHistory(h);
  };

  // Setters par document : utilisés quand le serveur impose sa version ou qu'un autre appareil a écrit.
  const setters: Record<string, (v: never) => void> = {
    library: (v: Library | undefined) => setLibrary(v ?? null),
    tags: (v: TagStore | undefined) => setTags(v ?? {}),
    features: (v: FeatureStore | undefined) => setFeatures(v ?? {}),
    saved: (v: SavedPlaylist[] | undefined) => setSaved(v ?? []),
    history: (v: HistoryStore | undefined) => setHistoryState(v ?? null),
    backups: (v: PlaylistBackup[] | undefined) => setBackups(v ?? []),
    friends: (v: TasteCard[] | undefined) => setFriends(v ?? []),
    settings: (v: Partial<Settings> | undefined) => setSettings({ ...DEFAULT_SETTINGS, ...(v ?? {}) }),
    automations: (v: Partial<Automations> | undefined) => setAutomations(withDefaults(v)),
  };

  const save = <T,>(key: string, value: T, rebase?: (fresh: T | undefined) => T) => {
    persist
      .save(key, value, rebase)
      .then((r) => {
        if (r.replaced !== undefined) (setters[key] as (v: T) => void)?.(r.replaced);
      })
      .catch((e) => setError(message(e)));
  };

  const commitLibrary = (lib: Library, rebase?: (fresh: Library | undefined) => Library) => {
    setLibrary(lib);
    save('library', lib, rebase);
  };
  const commitHistory = (h: HistoryStore | null) => {
    setHistoryState(h);
    // En mode serveur, l'historique appartient au serveur (import et relève passent par l'API).
    if (!persist.server) save('history', h);
  };

  useEffect(() => {
    const keys = ['library', 'tags', 'features', 'saved', 'history', 'backups', 'friends', ...(persist.server ? ['settings', 'automations'] : [])];
    Promise.all(keys.map((k) => persist.load(k)))
      .then((values) => {
        keys.forEach((k, i) => (setters[k] as (v: unknown) => void)(values[i]));
        setReady(true);
      })
      .catch((e) => {
        setError(`Chargement impossible : ${message(e)}`);
        setReady(true);
      });
  }, [persist]);

  // Mode serveur : on récupère ce que les tâches planifiées ou les autres appareils ont modifié.
  const reloadChanged = useCallback(async () => {
    if (!persist.server) return;
    try {
      for (const key of await persist.changedKeys()) {
        if (setters[key]) (setters[key] as (v: unknown) => void)(await persist.load(key));
      }
    } catch {
      /* hors ligne : on réessaiera */
    }
  }, [persist]);

  useEffect(() => {
    if (!persist.server) return;
    const t = setInterval(reloadChanged, 20_000);
    const onFocus = () => void reloadChanged();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [reloadChanged]);

  // Mode serveur : suivi des tâches (rapide pendant qu'une tâche tourne).
  const jobsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollJobs = useCallback(async () => {
    if (!persist.server) return;
    if (jobsTimer.current) clearTimeout(jobsTimer.current);
    let busy = false;
    try {
      const j = await remote.jobs();
      busy = j.running.length > 0;
      setServerJobs((prev) => {
        // Une tâche vient de se terminer : ses résultats sont à recharger.
        if (prev && prev.running.length > j.running.length) void reloadChanged();
        return j;
      });
    } catch {
      /* réessai au prochain tour */
    }
    jobsTimer.current = setTimeout(pollJobs, busy ? 2500 : 30_000);
  }, [persist, reloadChanged]);

  useEffect(() => {
    void pollJobs();
    return () => {
      if (jobsTimer.current) clearTimeout(jobsTimer.current);
    };
  }, [pollJobs]);

  useEffect(() => {
    if (!server) return;
    remote.serverToken().then(() => setServerScope(remote.serverScope())).catch(() => undefined);
  }, [server]);

  const runServerJob = async (kind: JobKind, target?: string) => {
    await remote.runJob(kind, target);
    setTimeout(pollJobs, 400);
  };

  const index = useMemo(() => (library ? buildIndex(library, tags, features, history) : null), [library, tags, features, history]);
  const artistName = useCallback((id: string) => library?.artists[id]?.name ?? id, [library]);

  // Mises à jour fonctionnelles : réappliquées telles quelles si le serveur a une version plus récente.
  const updateSaved = (fn: (prev: SavedPlaylist[]) => SavedPlaylist[]) =>
    setSaved((prev) => {
      const next = fn(prev);
      save('saved', next, (fresh) => fn(fresh ?? []));
      return next;
    });

  const addBackup = (list: PlaylistBackup[], b: PlaylistBackup) => (list[0] && sameSnapshot(list[0], b) ? list : [b, ...list].slice(0, MAX_BACKUPS));
  const pushBackup = (b: PlaylistBackup) =>
    setBackups((prev) => {
      const next = addBackup(prev, b);
      if (next !== prev) save('backups', next, (fresh) => addBackup(fresh ?? [], b));
      return next;
    });

  const updateAutomations = (fn: (a: Automations) => Automations) =>
    setAutomations((prev) => {
      const next = fn(prev);
      save('automations', next, (fresh) => fn(withDefaults(fresh)));
      return next;
    });

  const setLivingSchedule = (playlistId: string, sched: Schedule | null) =>
    updateSaved((prev) => prev.map((s) => (s.spotifyId === playlistId ? { ...s, schedule: sched } : s)));

  const run = async (kind: TaskState['kind'], fn: (signal: AbortSignal) => Promise<void>) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setTask({ kind, label: 'Démarrage…', done: 0 });
    try {
      await fn(ctrl.signal);
    } catch (e) {
      if (!isAbort(e)) setError(message(e));
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setTask(null);
      }
    }
  };

  const mergeIntoHistory = (plays: RawPlay[], files: string[] = []) => {
    const before = historyRef.current?.ts.length ?? 0;
    const next = mergePlays(historyRef.current ?? emptyHistory(), plays, files);
    commitHistory(next);
    return next.ts.length - before;
  };

  const pullWorker = async (quiet = false): Promise<number> => {
    if (persist.server || !settings.workerUrl || !settings.workerKey) return 0;
    try {
      const since = historyRef.current?.ts.length ? historyRef.current.ts[historyRef.current.ts.length - 1] - 7 * 86_400_000 : 0;
      const res = await fetch(`${settings.workerUrl.replace(/\/$/, '')}/plays?since=${Math.floor(since)}`, {
        headers: { Authorization: `Bearer ${settings.workerKey}` },
      });
      if (!res.ok) throw new Error(`Worker : ${res.status} ${await res.text()}`);
      const json: { plays: [number, string, string, string, string, number][] } = await res.json();
      const added = mergeIntoHistory(
        json.plays.map(([ts, uri, name, artist, album, ms]) => ({ ts, uri, name, artist, album, ms, flags: 4 })),
      );
      if (!quiet) setNotice(`Worker : ${added} nouvelle(s) écoute(s) ajoutée(s).`);
      return added;
    } catch (e) {
      if (!quiet) setError(message(e));
      return 0;
    }
  };

  const sync = () =>
    persist.server ? runServerJob('sync').catch((e) => setError(message(e))) : run('sync', async (signal) => {
      const lib = await syncLibrary(
        { excludePlaylistIds: new Set(saved.map((s) => s.spotifyId)) },
        (p) => setTask({ kind: 'sync', ...p }),
        signal,
      );
      commitLibrary(lib);
      pushBackup(snapshot(lib));
      // Les 50 dernières écoutes viennent compléter l'historique à chaque synchro.
      mergeIntoHistory(playsFromApi(await sp.getRecentlyPlayed(signal)));
      await pullWorker(true);
      setNotice(`Bibliothèque synchronisée : ${Object.keys(lib.tracks).length} titres.`);
    });

  const enrich = () =>
    persist.server ? runServerJob('enrich').catch((e) => setError(message(e))) : run('enrich', async (signal) => {
      if (!library) return;
      const f: FeatureStore = { ...features };
      const t: TagStore = { ...tags };
      let lastFlush = 0;
      // Chaque écriture reconstruit l'index de toute la bibliothèque : pas plus d'une toutes les 5 s.
      const flush = (force = false) => {
        if (!force && Date.now() - lastFlush < 5000) return;
        lastFlush = Date.now();
        setFeatures({ ...f });
        setTags({ ...t });
        save('features', f);
        save('tags', t);
      };
      try {
        // Bibliothèque d'abord, puis les titres les plus écoutés de l'historique (humeur × moment).
        const ids = [...Object.keys(library.tracks), ...(historyRef.current ? mostPlayedIds(historyRef.current, 3000) : [])];
        await fetchAudioFeatures(
          [...new Set(ids)],
          f,
          (patch, p) => {
            Object.assign(f, patch);
            setTask({ kind: 'enrich', ...p });
            flush();
          },
          signal,
        );
        flush(true);
        const artists = artistsByImportance(library).map((id) => library.artists[id]).filter(Boolean);
        await fetchArtistTags(
          artists,
          t,
          { lastfmKey: settings.lastfmKey || undefined },
          (id, value, p) => {
            t[id] = value;
            setTask({ kind: 'enrich', ...p });
            flush();
          },
          signal,
        );
        setNotice('Enrichissement terminé.');
      } finally {
        flush(true);
      }
    });

  const cancel = () => {
    const serverRun = serverJobs?.running[0];
    if (persist.server && serverRun) void remote.cancelRun(serverRun).then(() => setTimeout(pollJobs, 400));
    abortRef.current?.abort();
    abortRef.current = null;
    setTask(null);
  };

  const createPlaylist: Store['createPlaylist'] = async ({ name, description, isPublic, tracks, rule, pool }) => {
    const fullName = `${settings.playlistPrefix}${name}`.slice(0, 100);
    const created = await sp.createPlaylist(fullName, description, isPublic);
    await sp.setPlaylistItems(created.id, tracks.map((t) => t.track.uri));
    const now = new Date().toISOString();
    const entry: SavedPlaylist = {
      spotifyId: created.id,
      name: fullName,
      description,
      rule,
      pool,
      createdAt: now,
      updatedAt: now,
      trackCount: tracks.length,
      isPublic,
    };
    updateSaved((prev) => [entry, ...prev]);
    return entry;
  };

  /** Référence d'un titre connu de la bibliothèque, pour reconnaître ses autres versions. */
  const refOfUri = (uri: string) => {
    const t = libRef.current?.tracks[uri.replace('spotify:track:', '')];
    return t ? trackRef(t) : undefined;
  };

  const createSimplePlaylist: Store['createSimplePlaylist'] = async (name, description, uris, opts) => {
    const list = opts?.exact ? uris : dedupeUris(uris, refOfUri);
    const created = await sp.createPlaylist(`${settings.playlistPrefix}${name}`.slice(0, 100), description.slice(0, 300), settings.publicByDefault);
    await sp.setPlaylistItems(created.id, list);
    return { id: created.id, count: list.length };
  };

  const refreshSaved = async (s: SavedPlaylist) => {
    if (!index) return;
    const { rule, uris } = livingRefresh(index, s);
    await sp.setPlaylistItems(s.spotifyId, uris);
    updateSaved((prev) =>
      prev.map((x) => (x.spotifyId === s.spotifyId ? { ...x, rule, updatedAt: new Date().toISOString(), trackCount: uris.length } : x)),
    );
    setNotice(`« ${s.name} » actualisée (${uris.length} titres).`);
  };

  // Actualisation automatique des playlists vivantes à l'ouverture.
  const autoRefreshed = useRef(false);
  useEffect(() => {
    // En mode serveur, c'est le planificateur qui s'en charge.
    if (persist.server || !ready || !index || autoRefreshed.current || !settings.autoRefreshDays) return;
    autoRefreshed.current = true;
    const limit = Date.now() - settings.autoRefreshDays * 86_400_000;
    const stale = saved.filter((s) => Date.parse(s.updatedAt) < limit);
    (async () => {
      for (const s of stale) {
        try {
          await refreshSaved(s);
        } catch (e) {
          setError(message(e));
          return;
        }
      }
      if (stale.length) setNotice(`${stale.length} playlist(s) vivante(s) actualisée(s) automatiquement.`);
    })();
  }, [ready, index]);

  // Récupère les écoutes du worker à l'ouverture.
  const pulled = useRef(false);
  useEffect(() => {
    if (!ready || pulled.current) return;
    pulled.current = true;
    void pullWorker(true);
  }, [ready]);

  const forgetSaved = (id: string) => updateSaved((prev) => prev.filter((s) => s.spotifyId !== id));
  const updateSavedRule = (id: string, rule: Rule) => updateSaved((prev) => prev.map((s) => (s.spotifyId === id ? { ...s, rule } : s)));

  // ---- Actions sur la bibliothèque (mise à jour locale optimiste après succès de l'API) ----

  const patchLibrary = (fn: (lib: Library) => void) => {
    const current = libRef.current;
    if (!current) return;
    const apply = (base: Library) => {
      const next: Library = structuredClone(base);
      fn(next);
      return next;
    };
    commitLibrary(apply(current), (fresh) => apply(fresh ?? current));
  };

  const likeTracks = async (trackIds: string[]) => {
    await sp.saveToLibrary(trackIds.map((id) => `spotify:track:${id}`));
    const now = new Date().toISOString();
    patchLibrary((lib) => trackIds.forEach((id) => lib.tracks[id] && (lib.tracks[id].likedAt ??= now)));
  };

  const followArtists = async (artistIds: string[]) => {
    await sp.saveToLibrary(artistIds.map((id) => `spotify:artist:${id}`));
    patchLibrary((lib) => artistIds.forEach((id) => lib.artists[id] && (lib.artists[id].followed = true)));
  };

  const addToPlaylist = async (playlistId: string, ids: string[]) => {
    const lib = libRef.current;
    // Déjà présents (contenu connu si la playlist est synchronisée) : on ne les rajoute pas.
    const present = new SongSet();
    const presentIds = new Set(lib?.playlistItems?.[playlistId] ?? []);
    for (const id of presentIds) if (lib?.tracks[id]) present.add(trackRef(lib.tracks[id]));
    const trackIds = dedupeSongs(
      [...new Set(ids)].filter((id) => !presentIds.has(id)),
      (id) => (lib?.tracks[id] ? trackRef(lib.tracks[id]) : undefined),
      present,
    ).kept;
    if (!trackIds.length) return 0;
    await sp.addPlaylistItems(playlistId, trackIds.map((id) => `spotify:track:${id}`));
    patchLibrary((lib) => {
      lib.playlistItems ??= {};
      lib.playlistItems[playlistId] = [...(lib.playlistItems[playlistId] ?? []), ...trackIds];
      for (const id of trackIds) {
        const t = lib.tracks[id];
        if (t && !t.playlists.includes(playlistId)) t.playlists.push(playlistId);
      }
      const meta = lib.playlists.find((p) => p.id === playlistId);
      if (meta) meta.trackCount += trackIds.length;
    });
    return trackIds.length;
  };

  /** Remplace le contenu d'une playlist, après une sauvegarde automatique. */
  const rewritePlaylist = async (playlistId: string, trackIds: string[], reason: string) => {
    const lib = libRef.current;
    if (!lib) return;
    pushBackup({ ...snapshot(lib), id: `b${Date.now()}`, createdAt: new Date().toISOString() });
    await sp.setPlaylistItems(playlistId, trackIds.map((id) => `spotify:track:${id}`));
    patchLibrary((l) => {
      l.playlistItems ??= {};
      const before = new Set(l.playlistItems[playlistId] ?? []);
      l.playlistItems[playlistId] = trackIds;
      const after = new Set(trackIds);
      for (const id of before) if (!after.has(id) && l.tracks[id]) l.tracks[id].playlists = l.tracks[id].playlists.filter((p) => p !== playlistId);
      for (const id of after) if (l.tracks[id] && !l.tracks[id].playlists.includes(playlistId)) l.tracks[id].playlists.push(playlistId);
      const meta = l.playlists.find((p) => p.id === playlistId);
      if (meta) meta.trackCount = trackIds.length;
    });
    setNotice(`${reason} (une sauvegarde a été faite juste avant).`);
  };

  const createBackup = async () => {
    const lib = libRef.current;
    if (!lib) return;
    const b = snapshot(lib);
    setBackups((prev) => {
      const next = [b, ...prev].slice(0, MAX_BACKUPS);
      save('backups', next, (fresh) => [b, ...(fresh ?? [])].slice(0, MAX_BACKUPS));
      return next;
    });
    setNotice('Sauvegarde créée.');
  };

  const restoreFromBackup = async (backupId: string, playlistId: string) => {
    const b = backups.find((x) => x.id === backupId);
    const p = b?.playlists.find((x) => x.id === playlistId);
    const lib = libRef.current;
    if (!p || !lib) return;
    if (lib.playlists.some((x) => x.id === playlistId)) {
      await rewritePlaylist(playlistId, p.trackIds, `« ${p.name} » restaurée`);
      return;
    }
    // Playlist hors synchro (ex. playlist vivante) : on tente de la réécrire, sinon on la recrée.
    try {
      await sp.setPlaylistItems(playlistId, p.trackIds.map((t) => `spotify:track:${t}`));
      setNotice(`« ${p.name} » restaurée.`);
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 403)) throw e;
      await createSimplePlaylist(`${p.name} (restaurée)`, `Restaurée par Sillon depuis la sauvegarde du ${new Date(b!.createdAt).toLocaleString('fr-FR')}`, p.trackIds.map((t) => `spotify:track:${t}`), { exact: true });
      setNotice(`« ${p.name} » recréée (${p.trackIds.length} titres). Resynchronise pour la voir.`);
    }
  };

  const savePlaylistEdit = async (e: PlaylistEdit) => {
    // Garde-fou : si la playlist a bougé ailleurs (app Spotify, autre appareil) depuis l'ouverture, on prévient.
    const current = await sp.getPlaylistMeta(e.id);
    if (!e.force && current.snapshot_id !== e.before.snapshotId) {
      throw new PlaylistConflictError('Cette playlist a été modifiée ailleurs depuis que tu l’as ouverte.');
    }
    const idOf = (uri: string) => uri.match(/^spotify:track:(.+)$/)?.[1];
    const beforeIds = e.before.uris.map(idOf).filter((x): x is string => !!x);
    const afterIds = e.uris.map(idOf).filter((x): x is string => !!x);
    pushBackup({
      id: `b${Date.now()}`,
      createdAt: new Date().toISOString(),
      label: `avant modification de « ${e.before.name} »`,
      playlists: [{ id: e.id, name: e.before.name, trackIds: beforeIds }],
    });
    if (e.name !== e.before.name || e.description !== e.before.description) {
      await sp.updatePlaylistDetails(e.id, e.name, e.description);
    }
    if (e.uris.join() !== e.before.uris.join()) await sp.setPlaylistItems(e.id, e.uris);

    patchLibrary((l) => {
      const meta = l.playlists.find((p) => p.id === e.id);
      if (meta) {
        meta.name = e.name;
        meta.trackCount = e.uris.length;
      }
      if (l.playlistItems?.[e.id]) {
        l.playlistItems[e.id] = afterIds;
        const after = new Set(afterIds);
        for (const id of beforeIds) if (!after.has(id) && l.tracks[id]) l.tracks[id].playlists = l.tracks[id].playlists.filter((p) => p !== e.id);
        for (const id of afterIds) if (l.tracks[id] && !l.tracks[id].playlists.includes(e.id)) l.tracks[id].playlists.push(e.id);
      }
    });
    // Playlist vivante : les retouches deviennent des épinglés / exclus, pour survivre aux actualisations.
    updateSaved((prev) =>
      prev.map((s) =>
        s.spotifyId === e.id
          ? { ...s, name: e.name, description: e.description, rule: applyManualEdits(s.rule, beforeIds, afterIds), trackCount: e.uris.length, updatedAt: new Date().toISOString() }
          : s,
      ),
    );
    setNotice(`« ${e.name} » enregistrée (une sauvegarde de l’ancienne version a été faite).`);
  };

  // ---- Historique ----

  const importHistory = async (files: FileList | File[]) => {
    const { plays, names, skipped } = await readExportFiles(files);
    if (persist.server) {
      const { added } = await remote.importPlays(plays, names);
      setters.history((await persist.load<HistoryStore>('history')) as never);
      setNotice(`${added.toLocaleString('fr-FR')} écoutes importées sur le serveur depuis ${names.length} fichier(s).`);
      return { added, skipped };
    }
    const added = mergeIntoHistory(plays, names);
    setNotice(`${added.toLocaleString('fr-FR')} écoutes importées depuis ${names.length} fichier(s).`);
    return { added, skipped };
  };

  const clearHistory = async () => {
    if (persist.server) await remote.clearServerHistory();
    commitHistory(null);
  };

  // ---- Amis ----

  const updateFriends = (fn: (prev: TasteCard[]) => TasteCard[]) =>
    setFriends((prev) => {
      const next = fn(prev);
      save('friends', next, (fresh) => fn(fresh ?? []));
      return next;
    });
  const addFriend = (card: TasteCard) => updateFriends((prev) => [card, ...prev.filter((f) => f.name !== card.name)]);
  const removeFriend = (name: string, createdAt: string) => updateFriends((prev) => prev.filter((f) => !(f.name === name && f.createdAt === createdAt)));

  // ---- Lecteur ----

  const bumpPlayer = () => setTimeout(() => setPlayerTick((t) => t + 1), 600);
  const withPlayer = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      bumpPlayer();
    } catch (e) {
      setError(message(e));
    }
  };
  const playUris = (uris: string[], offset?: number) => withPlayer(() => sp.play({ uris, offset }));
  const playContext = (contextUri: string) => withPlayer(() => sp.play({ contextUri }));
  const queueUri = (uri: string) =>
    withPlayer(async () => {
      await sp.queue(uri);
      setNotice('Ajouté à la file d’attente.');
    });

  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    // Mode serveur : réglages partagés entre appareils et lus par les tâches planifiées.
    if (persist.server) save('settings', next, (fresh) => ({ ...DEFAULT_SETTINGS, ...(fresh ?? {}), ...patch }));
    else localStorage.setItem(K_SETTINGS, JSON.stringify(next));
  };

  const resetAll = async () => {
    cancel();
    await persist.clear();
    setLibrary(null);
    setTags({});
    setFeatures({});
    setSaved([]);
    commitHistory(null);
    setBackups([]);
    setFriends([]);
  };

  const logout = () => {
    cancel();
    if (persist.server) void remote.serverLogout().then(onLogout);
    else {
      clearTokens();
      onLogout();
    }
  };

  // Tâche serveur en cours → affichée comme une tâche locale dans la barre d'état.
  const serverTask = useMemo<TaskState | null>(() => {
    const id = serverJobs?.running[0];
    const run = id ? serverJobs?.runs.find((r) => r.id === id) : undefined;
    if (!run) return null;
    return {
      kind: run.kind === 'enrich' ? 'enrich' : 'sync',
      label: run.progress?.label ?? `Serveur : ${run.kind === 'sync' ? 'synchro' : run.kind}…`,
      done: run.progress?.done ?? 0,
      total: run.progress?.total,
      serverRunId: run.id,
    };
  }, [serverJobs]);

  const needsReauth = server
    ? !!server.user?.needsReauth || (serverScope !== null && SCOPES.some((sc) => !serverScope.split(' ').includes(sc)))
    : missingScopes().length > 0;

  const value: Store = {
    ready,
    library,
    index,
    tags,
    features,
    saved,
    history,
    backups,
    friends,
    settings,
    task: task ?? serverTask,
    error,
    notice,
    needsReauth,
    playerTick,
    artistName,
    sync,
    enrich,
    cancel,
    createPlaylist,
    createSimplePlaylist,
    refreshSaved,
    forgetSaved,
    updateSavedRule,
    likeTracks,
    followArtists,
    addToPlaylist,
    rewritePlaylist,
    createBackup,
    restoreFromBackup,
    savePlaylistEdit,
    editRequest,
    openEditor: (id) => setEditRequest(id ? { id, nonce: Date.now() } : null),
    importHistory,
    pullWorker,
    clearHistory,
    addFriend,
    removeFriend,
    playUris,
    playContext,
    queueUri,
    bumpPlayer,
    updateSettings,
    report: (e) => !isAbort(e) && setError(message(e)),
    say: setNotice,
    dismiss: () => {
      setError(null);
      setNotice(null);
    },
    resetAll,
    logout,
    server,
    automations,
    updateAutomations,
    serverJobs,
    runServerJob,
    setLivingSchedule,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore hors StoreProvider');
  return s;
}
