import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { logout as clearTokens } from './lib/auth';
import { kvClear, kvGet, kvSet } from './lib/db';
import { fetchArtistTags, fetchAudioFeatures } from './lib/enrich';
import { generate } from './lib/generator';
import { isAbort } from './lib/http';
import { artistsByImportance, buildIndex, type EnrichedTrack, type LibraryIndex } from './lib/indexer';
import * as sp from './lib/spotify';
import { syncLibrary } from './lib/sync';
import type { FeatureStore, Library, Rule, SavedPlaylist, Settings, TagStore } from './lib/types';

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
  settings: Settings;
  task: TaskState | null;
  error: string | null;
  notice: string | null;
  artistName: (id: string) => string;
  sync: () => Promise<void>;
  enrich: () => Promise<void>;
  cancel: () => void;
  createPlaylist: (p: { name: string; description: string; isPublic: boolean; tracks: EnrichedTrack[]; rule: Rule; pool?: string[] }) => Promise<SavedPlaylist>;
  refreshSaved: (s: SavedPlaylist) => Promise<void>;
  forgetSaved: (id: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  dismiss: () => void;
  resetAll: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<Store | null>(null);

const DEFAULT_SETTINGS: Settings = { lastfmKey: '', playlistPrefix: '', publicByDefault: false };
const K_SETTINGS = 'sillon.settings';

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(K_SETTINGS) || '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function StoreProvider({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const [ready, setReady] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [tags, setTags] = useState<TagStore>({});
  const [features, setFeatures] = useState<FeatureStore>({});
  const [saved, setSaved] = useState<SavedPlaylist[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [task, setTask] = useState<TaskState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([
      kvGet<Library>('library'),
      kvGet<TagStore>('tags'),
      kvGet<FeatureStore>('features'),
      kvGet<SavedPlaylist[]>('saved'),
    ]).then(([l, t, f, s]) => {
      setLibrary(l ?? null);
      setTags(t ?? {});
      setFeatures(f ?? {});
      setSaved(s ?? []);
      setReady(true);
    });
  }, []);

  const index = useMemo(() => (library ? buildIndex(library, tags, features) : null), [library, tags, features]);
  const artistName = useCallback((id: string) => library?.artists[id]?.name ?? id, [library]);

  // Mise à jour fonctionnelle : la création en lot enchaîne plusieurs écritures dans la même closure.
  const updateSaved = (fn: (prev: SavedPlaylist[]) => SavedPlaylist[]) =>
    setSaved((prev) => {
      const next = fn(prev);
      void kvSet('saved', next);
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
      if (!isAbort(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setTask(null);
      }
    }
  };

  const sync = () =>
    run('sync', async (signal) => {
      const lib = await syncLibrary(
        { excludePlaylistIds: new Set(saved.map((s) => s.spotifyId)) },
        (p) => setTask({ kind: 'sync', ...p }),
        signal,
      );
      setLibrary(lib);
      await kvSet('library', lib);
      setNotice(`Bibliothèque synchronisée : ${Object.keys(lib.tracks).length} titres. Lance l’enrichissement pour les genres et moods.`);
    });

  const enrich = () =>
    run('enrich', async (signal) => {
      if (!library) return;
      // On travaille sur des copies mutables et on publie vers React par à-coups,
      // pour ne pas reconstruire l'index à chaque requête.
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
        await fetchAudioFeatures(
          Object.keys(library.tracks),
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

  const refreshSaved = async (s: SavedPlaylist) => {
    if (!index) return;
    // Nouvelle graine : une playlist « vivante » se renouvelle à chaque actualisation.
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

  const forgetSaved = (id: string) => updateSaved((prev) => prev.filter((s) => s.spotifyId !== id));

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
    settings,
    task,
    error,
    notice,
    artistName,
    sync,
    enrich,
    cancel,
    createPlaylist,
    refreshSaved,
    forgetSaved,
    updateSettings,
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
