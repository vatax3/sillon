// Tâches exécutées par le serveur. Elles réutilisent tel quel le code métier de l'app (src/lib) :
// mêmes règles de génération, mêmes recommandations, même radar que dans l'interface.
import fs from 'node:fs';
import path from 'node:path';
import { withDefaults, emptyAutoState, type AutoPlaylist, type Automations, type AutoState, type JobKind } from '../src/lib/automations';
import { fetchArtistTags, fetchAudioFeatures } from '../src/lib/enrich';
import { livingRefresh } from '../src/lib/generator';
import { songKey } from '../src/lib/dedupe';
import { emptyHistory, mergePlays, playsFromApi, type HistoryStore, type RawPlay } from '../src/lib/history';
import { mostPlayedIds, rankedUris, timeMachine, topTracksWhere } from '../src/lib/historyStats';
import { HttpError } from '../src/lib/http';
import { artistsByImportance, buildIndex } from '../src/lib/indexer';
import { radarArtists, radarTracks, releaseRadar } from '../src/lib/radar';
import { knownSets, recommend, seedsFor } from '../src/lib/recommend';
import { encode } from '../src/lib/serialize';
import * as sp from '../src/lib/spotify';
import { syncLibrary } from '../src/lib/sync';
import { sameSnapshot, snapshot } from '../src/lib/tools';
import type { FeatureStore, Library, PlaylistBackup, SavedPlaylist, Settings, TagStore } from '../src/lib/types';
import { config } from './config';
import { ALL_DOCS, getDoc, getDocRaw, putDoc, updateDoc } from './db';
import { notify } from './notify';

export interface TaskContext {
  userId: string;
  target?: string;
  progress: (label: string, done: number, total?: number) => void;
  signal: AbortSignal;
}

/** Résultat affiché dans le journal des tâches. */
type TaskResult = string;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const automations = (userId: string) => withDefaults(getDoc<Partial<Automations>>(userId, 'automations'));
const autoState = (userId: string) => ({ ...emptyAutoState(), ...getDoc<Partial<AutoState>>(userId, 'autostate') });

function requireLibrary(userId: string): Library {
  const lib = getDoc<Library>(userId, 'library');
  if (!lib) throw new Error('Bibliothèque pas encore synchronisée');
  return lib;
}

function loadIndex(userId: string) {
  const library = requireLibrary(userId);
  const history = getDoc<HistoryStore>(userId, 'history') ?? null;
  const index = buildIndex(library, getDoc<TagStore>(userId, 'tags') ?? {}, getDoc<FeatureStore>(userId, 'features') ?? {}, history);
  return { library, history, index };
}

/** Playlists gérées automatiquement : exclues de la synchro pour ne pas polluer l'analyse. */
function managedPlaylistIds(userId: string): Set<string> {
  const a = automations(userId);
  const ids = (getDoc<SavedPlaylist[]>(userId, 'saved') ?? []).map((s) => s.spotifyId);
  for (const p of [a.discoveries, a.radar, a.timeMachine, a.monthlyTop]) if (p.playlistId) ids.push(p.playlistId);
  return new Set(ids);
}

/** Écoutes → historique, dans une seule écriture synchrone (pas de perte si une autre tâche écrit). */
export function mergeHistory(userId: string, plays: RawPlay[], files: string[] = []): { added: number; total: number } {
  let added = 0;
  const next = updateDoc<HistoryStore>(userId, 'history', (h) => {
    const base = h ?? emptyHistory();
    const merged = mergePlays(base, plays, files);
    added = merged.ts.length - base.ts.length;
    return merged;
  });
  return { added, total: next.ts.length };
}

/**
 * Récupère (ou recrée si elle a été supprimée) la playlist Spotify d'une playlist automatique,
 * et mémorise son id dans la configuration.
 */
async function ensureAutoPlaylist(userId: string, key: 'discoveries' | 'radar' | 'timeMachine' | 'monthlyTop', description: string): Promise<string> {
  const conf = automations(userId)[key] as AutoPlaylist;
  if (conf.playlistId) {
    try {
      const meta = await sp.getPlaylistMeta(conf.playlistId);
      await sp.updatePlaylistDetails(conf.playlistId, meta.name, description);
      return conf.playlistId;
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 403)) throw e;
    }
  }
  const settings = getDoc<Settings>(userId, 'settings');
  const created = await sp.createPlaylist(`${settings?.playlistPrefix ?? ''}${conf.name}`.slice(0, 100), description, false);
  updateDoc<Partial<Automations>>(userId, 'automations', (a) => {
    const full = withDefaults(a);
    return { ...full, [key]: { ...full[key], playlistId: created.id } };
  });
  return created.id;
}

// ---------- Tâches ----------

async function record({ userId, signal }: TaskContext): Promise<TaskResult> {
  const rows = await sp.getRecentlyPlayed(signal);
  const { added, total } = mergeHistory(userId, playsFromApi(rows));
  updateDoc<Partial<AutoState>>(userId, 'autostate', (s) => ({ ...emptyAutoState(), ...s, historyCursor: Date.now() }));
  return added ? `${added} nouvelle(s) écoute(s) · ${total.toLocaleString('fr-FR')} au total` : 'Aucune nouvelle écoute';
}

async function sync(ctx: TaskContext): Promise<TaskResult> {
  const { userId, signal } = ctx;
  const lib = await syncLibrary({ excludePlaylistIds: managedPlaylistIds(userId) }, (p) => ctx.progress(p.label, p.done, p.total), signal);
  putDoc(userId, 'library', lib);
  // Sauvegarde des playlists si quelque chose a changé depuis la dernière.
  const keep = automations(userId).backups.keep;
  updateDoc<PlaylistBackup[]>(userId, 'backups', (b) => {
    const list = b ?? [];
    const snap = snapshot(lib);
    return list[0] && sameSnapshot(list[0], snap) ? list : [snap, ...list].slice(0, Math.max(keep, 5));
  });
  mergeHistory(userId, playsFromApi(await sp.getRecentlyPlayed(signal)));
  let msg = `${Object.keys(lib.tracks).length.toLocaleString('fr-FR')} titres, ${lib.playlists.length} playlists`;
  if (automations(userId).librarySync.enrich) msg += ` · ${await enrich(ctx)}`;
  return msg;
}

async function enrich(ctx: TaskContext): Promise<TaskResult> {
  const { userId, signal } = ctx;
  const lib = requireLibrary(userId);
  const history = getDoc<HistoryStore>(userId, 'history');
  const settings = getDoc<Settings>(userId, 'settings');
  const features: FeatureStore = getDoc<FeatureStore>(userId, 'features') ?? {};
  const tags: TagStore = getDoc<TagStore>(userId, 'tags') ?? {};
  // On ne compte que les réussites (ReccoBeats ne connaît pas tous les titres, MusicBrainz pas tous les artistes).
  const known = () => ({ f: Object.values(features).filter(Boolean).length, t: Object.values(tags).filter((x) => x.tags.length).length });
  const before = known();
  let lastFlush = Date.now();
  // Écritures périodiques : l'enrichissement peut durer longtemps et reprend où il s'est arrêté.
  const flush = (force = false) => {
    if (!force && Date.now() - lastFlush < 30_000) return;
    lastFlush = Date.now();
    putDoc(userId, 'features', features);
    putDoc(userId, 'tags', tags);
  };
  try {
    const ids = [...new Set([...Object.keys(lib.tracks), ...(history ? mostPlayedIds(history, 3000) : [])])];
    await fetchAudioFeatures(ids, features, (patch, p) => {
      Object.assign(features, patch);
      ctx.progress(p.label, p.done, p.total);
      flush();
    }, signal);
    flush(true);
    const artists = artistsByImportance(lib).map((id) => lib.artists[id]).filter(Boolean);
    await fetchArtistTags(artists, tags, { lastfmKey: settings?.lastfmKey || config.lastfmKey || undefined }, (id, value, p) => {
      tags[id] = value;
      ctx.progress(p.label, p.done, p.total);
      flush();
    }, signal);
  } finally {
    flush(true);
  }
  const after = known();
  return `+${after.f - before.f} audio-features, +${after.t - before.t} artistes avec genres`;
}

async function living({ userId, target }: TaskContext): Promise<TaskResult> {
  const saved = (getDoc<SavedPlaylist[]>(userId, 'saved') ?? []).find((s) => s.spotifyId === target);
  if (!saved) throw new Error('Playlist vivante introuvable (oubliée ?)');
  const { index } = loadIndex(userId);
  const { rule, uris } = livingRefresh(index, saved);
  await sp.setPlaylistItems(saved.spotifyId, uris);
  updateDoc<SavedPlaylist[]>(userId, 'saved', (list) =>
    (list ?? []).map((s) => (s.spotifyId === saved.spotifyId ? { ...s, rule, trackCount: uris.length, updatedAt: new Date().toISOString() } : s)),
  );
  await notify(userId, 'playlist', `« ${saved.name} » actualisée`, `${uris.length} titres`, sp.playlistUrl(saved.spotifyId));
  return `« ${saved.name} » : ${uris.length} titres`;
}

async function discoveries(ctx: TaskContext): Promise<TaskResult> {
  const { userId, signal } = ctx;
  const conf = automations(userId).discoveries;
  const { library, history } = loadIndex(userId);
  const known = knownSets(library, history);
  const state = autoState(userId);
  // Ne jamais reproposer ce qui l'a déjà été les semaines précédentes.
  for (const id of state.recommended) known.ids.add(id);
  for (const k of state.recommendedNames) known.tracks.add(k);
  const seeds = seedsFor(library, history, conf.seed);
  if (!seeds.length) throw new Error('Pas assez de données pour choisir des artistes de départ');
  const recos = await recommend({
    seeds,
    knownArtists: known.artists,
    knownTracks: known.tracks,
    knownIds: known.ids,
    unknownArtistsOnly: conf.unknownOnly,
    size: conf.size,
    perArtist: 2,
    onProgress: (label, done, total) => ctx.progress(label, done, total),
    signal,
  });
  if (!recos.length) throw new Error('Aucune recommandation trouvée cette fois-ci');
  const date = new Date().toLocaleDateString('fr-FR', { timeZone: config.timezone });
  const id = await ensureAutoPlaylist(userId, 'discoveries', `${recos.length} titres choisis pour toi d’après ${seeds.slice(0, 3).map((s) => s.name).join(', ')}… — Sillon, ${date}`);
  await sp.setPlaylistItems(id, recos.map((r) => r.spotify.uri));
  updateDoc<Partial<AutoState>>(userId, 'autostate', (s) => {
    const st = { ...emptyAutoState(), ...s };
    return {
      ...st,
      recommended: [...recos.map((r) => r.spotify.id), ...st.recommended].slice(0, 2000),
      recommendedNames: [...recos.map((r) => songKey(r.title, r.artist)), ...st.recommendedNames].slice(0, 2000),
    };
  });
  await notify(userId, 'playlist', conf.name, `${recos.length} découvertes : ${recos.slice(0, 5).map((r) => `${r.artist} – ${r.title}`).join(', ')}…`, sp.playlistUrl(id));
  return `${recos.length} titres`;
}

async function radar(ctx: TaskContext): Promise<TaskResult> {
  const { userId, signal } = ctx;
  const conf = automations(userId).radar;
  const { library, index } = loadIndex(userId);
  const releases = await releaseRadar(radarArtists(library, index), conf.days, (d, t) => ctx.progress('Sorties de tes artistes', d, t), signal);
  const uris = await radarTracks(releases, conf.albumTracks, signal);
  const date = new Date().toLocaleDateString('fr-FR', { timeZone: config.timezone });
  const id = await ensureAutoPlaylist(userId, 'radar', `${releases.length} sorties des ${conf.days} derniers jours de tes artistes — Sillon, ${date}`);
  await sp.setPlaylistItems(id, uris);
  // Notification uniquement pour les sorties jamais signalées.
  const state = autoState(userId);
  const seen = new Set(state.radarSeen);
  const fresh = releases.filter((r) => !seen.has(r.album.id));
  updateDoc<Partial<AutoState>>(userId, 'autostate', (s) => {
    const st = { ...emptyAutoState(), ...s };
    return { ...st, radarSeen: [...fresh.map((r) => r.album.id), ...st.radarSeen].slice(0, 3000) };
  });
  if (fresh.length) {
    const lines = fresh.slice(0, 8).map((r) => `• ${r.album.artists.map((a) => a.name).join(', ')} — ${r.album.name}${r.album.album_type === 'album' ? ' (album)' : ''}`);
    await notify(userId, 'releases', `${fresh.length} nouvelle(s) sortie(s)`, lines.join('\n') + (fresh.length > 8 ? `\n… et ${fresh.length - 8} autres` : ''), sp.playlistUrl(id));
  }
  return `${releases.length} sorties (${fresh.length} nouvelles), ${uris.length} titres`;
}

async function timeMachineTask({ userId }: TaskContext): Promise<TaskResult> {
  const history = getDoc<HistoryStore>(userId, 'history');
  if (!history?.ts.length) throw new Error('Il faut un historique d’écoute (import ou relève continue)');
  const now = new Date();
  const years = timeMachine(history, now);
  const pick = years.find((y) => y.year === now.getFullYear() - 1) ?? years[0];
  if (!pick) throw new Error('Pas encore d’historique sur les années passées');
  const uris = rankedUris(history, pick.tracks);
  const label = `${MONTHS[now.getMonth()]} ${pick.year}`;
  const id = await ensureAutoPlaylist(userId, 'timeMachine', `Ce que tu écoutais en ${label} — Sillon`);
  await sp.setPlaylistItems(id, uris);
  await notify(userId, 'playlist', `Il y a un an : ${label}`, `${uris.length} titres`, sp.playlistUrl(id));
  return `${label} : ${uris.length} titres`;
}

async function monthlyTop({ userId }: TaskContext): Promise<TaskResult> {
  const conf = automations(userId).monthlyTop;
  const history = getDoc<HistoryStore>(userId, 'history');
  if (!history?.ts.length) throw new Error('Il faut un historique d’écoute (import ou relève continue)');
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = topTracksWhere(history, { from: from.getTime(), to: to.getTime() }, undefined, conf.size);
  const uris = rankedUris(history, rows);
  if (!uris.length) throw new Error('Aucune écoute le mois dernier');
  const label = `${MONTHS[from.getMonth()]} ${from.getFullYear()}`;
  const id = await ensureAutoPlaylist(userId, 'monthlyTop', `Mes titres les plus écoutés en ${label} — Sillon`);
  await sp.setPlaylistItems(id, uris);
  await notify(userId, 'playlist', `Ton top de ${label}`, `${uris.length} titres`, sp.playlistUrl(id));
  return `${label} : ${uris.length} titres`;
}

/** Sauvegarde : instantané des playlists + export JSON complet sur disque (avec rétention). */
async function backup({ userId }: TaskContext): Promise<TaskResult> {
  const keep = automations(userId).backups.keep;
  const lib = getDoc<Library>(userId, 'library');
  if (lib) {
    updateDoc<PlaylistBackup[]>(userId, 'backups', (b) => {
      const list = b ?? [];
      const snap = snapshot(lib);
      return list[0] && sameSnapshot(list[0], snap) ? list : [snap, ...list].slice(0, Math.max(keep, 5));
    });
  }
  const dir = path.join(config.dataDir, 'exports', userId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sillon-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, exportUser(userId));
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('sillon-') && f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
  const size = (fs.statSync(file).size / 1_048_576).toFixed(1);
  return `Export ${path.basename(file)} (${size} Mo), ${Math.min(files.length, keep)} gardé(s)`;
}

/** Tous les documents de l'utilisateur, dans un seul fichier JSON (réimportable). */
export function exportUser(userId: string): string {
  const docs: Record<string, unknown> = {};
  for (const key of ALL_DOCS) {
    const raw = getDocRaw(userId, key);
    if (raw) docs[key] = JSON.parse(raw.value);
  }
  return encode({ app: 'sillon', format: 1, exportedAt: new Date().toISOString(), user: userId, docs });
}

export const TASKS: Record<Exclude<JobKind, 'import'>, (ctx: TaskContext) => Promise<TaskResult>> = {
  record,
  sync,
  enrich,
  living,
  discoveries,
  radar,
  timeMachine: timeMachineTask,
  monthlyTop,
  backup,
};
