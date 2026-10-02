// Outils de rangement : ce qui traîne dans les playlists sans être liké, les likés orphelins,
// la santé des playlists (doublons, recouvrements), les sauvegardes et leurs différences.
import { dedupeUris, trackRef } from './dedupe';
import type { EnrichedTrack, LibraryIndex } from './indexer';
import type { Library, PlaylistBackup } from './types';

/** Titres présents dans au moins une de tes playlists mais absents des Titres likés. */
export function inPlaylistsNotLiked(index: LibraryIndex): EnrichedTrack[] {
  return index.tracks
    .filter((t) => t.track.playlists.length > 0 && !t.track.likedAt)
    .sort((a, b) => b.track.playlists.length - a.track.playlists.length || b.affinity - a.affinity);
}

/** Titres likés rangés dans aucune de tes playlists. */
export function likedOrphans(index: LibraryIndex): EnrichedTrack[] {
  return index.tracks
    .filter((t) => t.track.likedAt && t.track.playlists.length === 0)
    .sort((a, b) => (b.track.likedAt ?? '').localeCompare(a.track.likedAt ?? ''));
}

export interface PlaylistHealth {
  id: string;
  name: string;
  size: number;
  /** Nombre d'entrées en trop (un titre présent 3 fois compte pour 2), versions d'un même morceau comprises. */
  duplicates: number;
  /** Dont : autres versions d'un morceau déjà présent (remaster, single / album…). */
  versions: number;
}

/** Contenu d'une playlist sans doublons : même titre, ou autre version d'un morceau déjà présent. */
export function dedupePlaylist(lib: Library, ids: string[]): string[] {
  return dedupeUris(ids, (id) => (lib.tracks[id] ? trackRef(lib.tracks[id]) : undefined));
}

export function playlistHealth(lib: Library): PlaylistHealth[] {
  const items = lib.playlistItems ?? {};
  return lib.playlists
    .filter((p) => p.synced && items[p.id])
    .map((p) => {
      const ids = items[p.id];
      const unique = new Set(ids).size;
      const clean = dedupePlaylist(lib, ids).length;
      return { id: p.id, name: p.name, size: ids.length, duplicates: ids.length - clean, versions: unique - clean };
    });
}

export interface Overlap {
  a: string;
  b: string;
  shared: number;
  /** Part de la plus petite playlist contenue dans l'autre. */
  containment: number;
}

/** Paires de playlists qui se recouvrent fortement (candidates à la fusion). */
export function playlistOverlaps(lib: Library, minContainment = 0.5, minShared = 5): Overlap[] {
  const sets = lib.playlists
    .filter((p) => p.synced && lib.playlistItems?.[p.id]?.length)
    .map((p) => ({ id: p.id, set: new Set(lib.playlistItems![p.id]) }));
  const out: Overlap[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const [small, big] = sets[i].set.size <= sets[j].set.size ? [sets[i], sets[j]] : [sets[j], sets[i]];
      let shared = 0;
      for (const id of small.set) if (big.set.has(id)) shared++;
      const containment = shared / small.set.size;
      if (shared >= minShared && containment >= minContainment) {
        out.push({ a: small.id, b: big.id, shared, containment });
      }
    }
  }
  return out.sort((x, y) => y.containment - x.containment);
}

/** Union ordonnée de plusieurs playlists, sans doublons (ni deux versions d'un même morceau). */
export function mergePlaylists(lib: Library, ids: string[]): string[] {
  return dedupePlaylist(lib, ids.flatMap((id) => lib.playlistItems?.[id] ?? []));
}

/** Découpe une liste de titres selon une clé (famille, décennie…) ; les groupes trop petits sont écartés. */
export function splitBy(
  tracks: EnrichedTrack[],
  keyOf: (t: EnrichedTrack) => string | undefined,
  minSize = 5,
): { key: string; tracks: EnrichedTrack[] }[] {
  const groups = new Map<string, EnrichedTrack[]>();
  for (const t of tracks) {
    const k = keyOf(t);
    if (!k) continue;
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.length >= minSize)
    .map(([key, g]) => ({ key, tracks: g }))
    .sort((a, b) => b.tracks.length - a.tracks.length);
}

/** Artistes très présents chez toi que tu ne suis pas encore. */
export function followSuggestions(lib: Library, index: LibraryIndex, minTracks = 5): { id: string; name: string; count: number }[] {
  return [...index.artistCounts.entries()]
    .filter(([id, n]) => n >= minTracks && lib.artists[id] && !lib.artists[id].followed)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, name: lib.artists[id].name, count }));
}

// ---------- Sauvegardes ----------

export function snapshot(lib: Library): PlaylistBackup {
  return {
    id: `b${Date.now()}`,
    createdAt: new Date().toISOString(),
    playlists: lib.playlists
      .filter((p) => p.owned && lib.playlistItems?.[p.id])
      .map((p) => ({ id: p.id, name: p.name, trackIds: lib.playlistItems![p.id] })),
  };
}

export function sameSnapshot(a: PlaylistBackup, b: PlaylistBackup): boolean {
  if (a.playlists.length !== b.playlists.length) return false;
  const bm = new Map(b.playlists.map((p) => [p.id, p]));
  return a.playlists.every((p) => {
    const q = bm.get(p.id);
    return q && q.name === p.name && q.trackIds.join() === p.trackIds.join();
  });
}

export interface PlaylistDiff {
  id: string;
  name: string;
  added: string[];
  removed: string[];
  /** Playlist présente dans la sauvegarde mais plus dans la bibliothèque. */
  deleted: boolean;
  /** Playlist existante mais hors synchro (ex. playlist vivante) : pas de comparaison possible. */
  unsynced?: boolean;
}

/** Différences entre une sauvegarde et l'état actuel. */
export function diffWithBackup(lib: Library, backup: PlaylistBackup, existingElsewhere: Set<string> = new Set()): PlaylistDiff[] {
  const out: PlaylistDiff[] = [];
  for (const p of backup.playlists) {
    const current = lib.playlistItems?.[p.id];
    const exists = lib.playlists.some((x) => x.id === p.id);
    if (!exists && existingElsewhere.has(p.id)) {
      out.push({ id: p.id, name: p.name, added: [], removed: [], deleted: false, unsynced: true });
      continue;
    }
    if (!exists) {
      out.push({ id: p.id, name: p.name, added: [], removed: p.trackIds, deleted: true });
      continue;
    }
    if (!current) continue;
    const before = new Set(p.trackIds);
    const after = new Set(current);
    const added = current.filter((id) => !before.has(id));
    const removed = p.trackIds.filter((id) => !after.has(id));
    if (added.length || removed.length) out.push({ id: p.id, name: p.name, added, removed, deleted: false });
  }
  return out;
}
