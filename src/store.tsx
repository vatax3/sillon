import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { logout as clearTokens, missingScopes } from './lib/auth';
import { kvClear, kvGet, kvSet } from './lib/db';
import { fetchArtistTags, fetchAudioFeatures } from './lib/enrich';
import { generate } from './lib/generator';
import { emptyHistory, mergePlays, playsFromApi, readExportFiles, type HistoryStore, type RawPlay } from './lib/history';
import { mostPlayedIds } from './lib/historyStats';
import { isAbort } from './lib/http';
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
  createSimplePlaylist: (name: string, description: string, uris: string[]) => Promise<string>;
  refreshSaved: (s: SavedPlaylist) => Promise<void>;
  forgetSaved: (id: string) => void;
  likeTracks: (trackIds: string[]) => Promise<void>;
  followArtists: (artistIds: string[]) => Promise<void>;
  addToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  rewritePlaylist: (playlistId: string, trackIds: string[], reason: string) => Promise<void>;
  createBackup: () => Promise<void>;
  restoreFromBackup: (backupId: string, playlistId: string) => Promise<void>;
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
}

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

export function StoreProvider({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
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
  const abortRef = useRef<AbortController | null>(null);
  // Références à jour pour les actions asynchrones enchaînées (évite les closures périmées).
  const libRef = useRef<Library | null>(null);
  const historyRef = useRef<HistoryStore | null>(null);

  const setLibrary = (lib: Library | null) => {
    libRef.current = lib;
    setLibraryState(lib);
  };
  const commitLibrary = (lib: Library) => {
    setLibrary(lib);
    void kvSet('library', lib);
  };
  const commitHistory = (h: HistoryStore | null) => {
    historyRef.current = h;
    setHistory(h);
    void kvSet('history', h);
  };

  useEffect(() => {
    Promise.all([
      kvGet<Library>('library'),
      kvGet<TagStore>('tags'),
      kvGet<FeatureStore>('features'),
      kvGet<SavedPlaylist[]>('saved'),
      kvGet<HistoryStore>('history'),
      kvGet<PlaylistBackup[]>('backups'),
      kvGet<TasteCard[]>('friends'),
    ]).then(([l, t, f, s, h, b, fr]) => {
      setLibrary(l ?? null);
      setTags(t ?? {});
      setFeatures(f ?? {});
      setSaved(s ?? []);
      historyRef.current = h ?? null;
      setHistory(h ?? null);
      setBackups(b ?? []);
      setFriends(fr ?? []);
      setReady(true);
    });
  }, []);

  const index = useMemo(() => (library ? buildIndex(library, tags, features) : null), [library, tags, features]);
  const artistName = useCallback((id: string) => library?.artists[id]?.name ?? id, [library]);

  const updateSaved = (fn: (prev: SavedPlaylist[]) => SavedPlaylist[]) =>
    setSaved((prev) => {
      const next = fn(prev);
      void kvSet('saved', next);
      return next;
    });

  const pushBackup = (b: PlaylistBackup) =>
    setBackups((prev) => {
      if (prev[0] && sameSnapshot(prev[0], b)) return prev;
      const next = [b, ...prev].slice(0, MAX_BACKUPS);
      void kvSet('backups', next);
      return next;
    });

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
    if (!settings.workerUrl || !settings.workerKey) return 0;
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
    run('sync', async (signal) => {
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
    run('enrich', async (signal) => {
      if (!library) return;
      const f: FeatureStore = { ...features };
      const t: TagStore = { ...tags };
      let lastFlush = 0;
      const flush = (force = false) => {
        if (!force && Date.now() - lastFlush < 2000) return;
        lastFlush = Date.now();
        setFeatures({ ...f });
        setTags({ ...t });
        void kvSet('features', f);
        void kvSet('tags', t);
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

  const createSimplePlaylist = async (name: string, description: string, uris: string[]) => {
    const created = await sp.createPlaylist(`${settings.playlistPrefix}${name}`.slice(0, 100), description.slice(0, 300), settings.publicByDefault);
    await sp.setPlaylistItems(created.id, uris);
    return created.id;
  };

  const refreshSaved = async (s: SavedPlaylist) => {
    if (!index) return;
    const rule = { ...s.rule, seed: Math.floor(Math.random() * 1e9) };
    const { tracks } = generate(index, rule, s.pool ? new Set(s.pool) : undefined);
    await sp.setPlaylistItems(s.spotifyId, tracks.map((t) => t.track.uri));
    updateSaved((prev) =>
      prev.map((x) =>
        x.spotifyId === s.spotifyId ? { ...x, rule, updatedAt: new Date().toISOString(), trackCount: tracks.length } : x,
      ),
    );
    setNotice(`« ${s.name} » actualisée (${tracks.length} titres).`);
  };

  // Actualisation automatique des playlists vivantes à l'ouverture.
  const autoRefreshed = useRef(false);
  useEffect(() => {
    if (!ready || !index || autoRefreshed.current || !settings.autoRefreshDays) return;
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

  // ---- Actions sur la bibliothèque (mise à jour locale optimiste après succès de l'API) ----

  const patchLibrary = (fn: (lib: Library) => void) => {
    const current = libRef.current;
    if (!current) return;
    const next: Library = structuredClone(current);
    fn(next);
    commitLibrary(next);
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

  const addToPlaylist = async (playlistId: string, trackIds: string[]) => {
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
      void kvSet('backups', next);
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
    } else {
      await createSimplePlaylist(`${p.name} (restaurée)`, `Restaurée par Sillon depuis la sauvegarde du ${new Date(b!.createdAt).toLocaleString('fr-FR')}`, p.trackIds.map((t) => `spotify:track:${t}`));
      setNotice(`« ${p.name} » recréée (${p.trackIds.length} titres). Resynchronise pour la voir.`);
    }
  };

  // ---- Historique ----

  const importHistory = async (files: FileList | File[]) => {
    const { plays, names, skipped } = await readExportFiles(files);
    const added = mergeIntoHistory(plays, names);
    setNotice(`${added.toLocaleString('fr-FR')} écoutes importées depuis ${names.length} fichier(s).`);
    return { added, skipped };
  };

  const clearHistory = async () => commitHistory(null);

  // ---- Amis ----

  const addFriend = (card: TasteCard) =>
    setFriends((prev) => {
      const next = [card, ...prev.filter((f) => f.name !== card.name)];
      void kvSet('friends', next);
      return next;
    });
  const removeFriend = (name: string, createdAt: string) =>
    setFriends((prev) => {
      const next = prev.filter((f) => !(f.name === name && f.createdAt === createdAt));
      void kvSet('friends', next);
      return next;
    });

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
    localStorage.setItem(K_SETTINGS, JSON.stringify(next));
  };

  const resetAll = async () => {
    cancel();
    await kvClear();
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
    clearTokens();
    onLogout();
  };

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
    task,
    error,
    notice,
    needsReauth: missingScopes().length > 0,
    playerTick,
    artistName,
    sync,
    enrich,
    cancel,
    createPlaylist,
    createSimplePlaylist,
    refreshSaved,
    forgetSaved,
    likeTracks,
    followArtists,
    addToPlaylist,
    rewritePlaylist,
    createBackup,
    restoreFromBackup,
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
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore hors StoreProvider');
  return s;
}
