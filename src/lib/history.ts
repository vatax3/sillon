// Historique d'écoute. Trois sources, fusionnées et dédoublonnées :
// 1. l'export « Historique de streaming étendu » (Streaming_History_Audio_*.json) : complet et détaillé ;
// 2. l'export « Données du compte » (StreamingHistory_music_*.json) : 1 an, sans URI ni skips ;
// 3. les 50 dernières écoutes de l'API (à chaque synchro) et le worker optionnel qui les relève en continu.
//
// Un historique complet dépasse souvent 300 000 écoutes : stockage en colonnes (typed arrays)
// avec un dictionnaire de titres, pour rester compact dans IndexedDB et rapide à agréger.
import { normalizeName } from './enrich';

export interface HistoryTrack {
  /** Id Spotify du titre quand on le connaît, sinon clé « n:artiste|titre ». */
  key: string;
  name: string;
  artist: string;
  album: string;
}

export const FLAG_SKIPPED = 1;
export const FLAG_SHUFFLE = 2;
/** Durée d'écoute inconnue (source API/worker) : on la considère complète. */
export const FLAG_NO_DURATION = 4;

export interface HistoryStore {
  tracks: HistoryTrack[];
  /** Horodatage de fin d'écoute (ms epoch), trié. */
  ts: Float64Array;
  ms: Uint32Array;
  track: Uint32Array;
  flags: Uint8Array;
  importedFiles: string[];
  updatedAt: string;
}

export interface RawPlay {
  ts: number;
  ms: number;
  uri?: string;
  name: string;
  artist: string;
  album: string;
  flags: number;
}

export const emptyHistory = (): HistoryStore => ({
  tracks: [],
  ts: new Float64Array(0),
  ms: new Uint32Array(0),
  track: new Uint32Array(0),
  flags: new Uint8Array(0),
  importedFiles: [],
  updatedAt: new Date(0).toISOString(),
});

export const spotifyIdFromUri = (uri?: string | null) => uri?.match(/^spotify:track:([A-Za-z0-9]+)$/)?.[1];
export const nameKey = (artist: string, name: string) => `n:${normalizeName(artist)}|${normalizeName(name)}`;

// ---------- Parsing des exports ----------

interface ExtendedRow {
  ts: string;
  ms_played: number;
  master_metadata_track_name: string | null;
  master_metadata_album_artist_name: string | null;
  master_metadata_album_album_name: string | null;
  spotify_track_uri: string | null;
  reason_end?: string | null;
  shuffle?: boolean | null;
  skipped?: boolean | null;
}

interface BasicRow {
  endTime: string;
  artistName: string;
  trackName: string;
  msPlayed: number;
}

/** Détecte le format et convertit ; ignore podcasts et lignes sans titre. */
export function parseExport(json: unknown): RawPlay[] {
  if (!Array.isArray(json) || json.length === 0) return [];
  const first = json[0] as Record<string, unknown>;
  if ('ms_played' in first) {
    return (json as ExtendedRow[])
      .filter((r) => r.master_metadata_track_name && r.master_metadata_album_artist_name)
      .map((r) => {
        let flags = 0;
        if (r.skipped || r.reason_end === 'fwdbtn') flags |= FLAG_SKIPPED;
        if (r.shuffle) flags |= FLAG_SHUFFLE;
        return {
          ts: Date.parse(r.ts),
          ms: r.ms_played,
          uri: r.spotify_track_uri ?? undefined,
          name: r.master_metadata_track_name!,
          artist: r.master_metadata_album_artist_name!,
          album: r.master_metadata_album_album_name ?? '',
          flags,
        };
      });
  }
  if ('msPlayed' in first && 'trackName' in first) {
    return (json as BasicRow[])
      .filter((r) => r.trackName && r.artistName && r.trackName !== 'Unknown Track')
      .map((r) => ({
        // « 2024-01-31 18:22 », en UTC.
        ts: Date.parse(`${r.endTime.replace(' ', 'T')}:00Z`),
        ms: r.msPlayed,
        name: r.trackName,
        artist: r.artistName,
        album: '',
        // Pas d'info de skip dans ce format : moins de 30 s d'écoute compte comme un skip.
        flags: r.msPlayed < 30_000 ? FLAG_SKIPPED : 0,
      }));
  }
  throw new Error('Format de fichier non reconnu (attendu : export d’historique Spotify en JSON).');
}

// ---------- Fusion ----------

/** Même source : seules les lignes identiques (fichier réimporté) sont des doublons. */
const SAME_SOURCE_WINDOW = 2_000;

export function mergePlays(store: HistoryStore, incoming: RawPlay[], fileNames: string[] = []): HistoryStore {
  const tracks = [...store.tracks];
  const byKey = new Map(tracks.map((t, i) => [t.key, i]));
  // Permet de rattacher une écoute sans URI (export basique) à un titre dont on connaît l'URI.
  const nameToKey = new Map<string, string>();
  for (const t of tracks) if (!t.key.startsWith('n:')) nameToKey.set(nameKey(t.artist, t.name), t.key);
  for (const p of incoming) {
    const id = spotifyIdFromUri(p.uri);
    if (id) nameToKey.set(nameKey(p.artist, p.name), id);
  }

  const indexOf = (p: RawPlay): number => {
    const key = spotifyIdFromUri(p.uri) ?? nameToKey.get(nameKey(p.artist, p.name)) ?? nameKey(p.artist, p.name);
    let i = byKey.get(key);
    if (i === undefined) {
      i = tracks.length;
      tracks.push({ key, name: p.name, artist: p.artist, album: p.album });
      byKey.set(key, i);
    } else if (!tracks[i].album && p.album) {
      tracks[i] = { ...tracks[i], album: p.album };
    }
    return i;
  };

  type Row = { ts: number; ms: number; track: number; flags: number };
  const rows: Row[] = [];
  for (let i = 0; i < store.ts.length; i++) {
    rows.push({ ts: store.ts[i], ms: store.ms[i], track: store.track[i], flags: store.flags[i] });
  }
  for (const p of incoming) {
    if (!Number.isFinite(p.ts)) continue;
    rows.push({ ts: p.ts, ms: Math.max(0, Math.min(p.ms, 0xffffffff)), track: indexOf(p), flags: p.flags });
  }
  rows.sort((a, b) => a.ts - b.ts);

  // Dédoublonnage : on garde la ligne la plus informative (avec durée réelle).
  const lastSeen = new Map<number, number>(); // track -> position dans `kept`
  const kept: Row[] = [];
  for (const r of rows) {
    const j = lastSeen.get(r.track);
    // Entre sources différentes (API vs export), l'horodatage peut être le début ou la fin de l'écoute :
    // on tolère toute la durée du titre. Au sein d'une même source, une réécoute reste une réécoute.
    const crossSource = j !== undefined && (kept[j].flags & FLAG_NO_DURATION) !== (r.flags & FLAG_NO_DURATION);
    const window = crossSource ? (kept[j!].flags & FLAG_NO_DURATION ? kept[j!].ms : r.ms) + 30_000 : SAME_SOURCE_WINDOW;
    if (j !== undefined && r.ts - kept[j].ts < window) {
      if (kept[j].flags & FLAG_NO_DURATION && !(r.flags & FLAG_NO_DURATION)) kept[j] = r;
      continue;
    }
    lastSeen.set(r.track, kept.length);
    kept.push(r);
  }

  return {
    tracks,
    ts: Float64Array.from(kept, (r) => r.ts),
    ms: Uint32Array.from(kept, (r) => r.ms),
    track: Uint32Array.from(kept, (r) => r.track),
    flags: Uint8Array.from(kept, (r) => r.flags),
    importedFiles: [...new Set([...store.importedFiles, ...fileNames])],
    updatedAt: new Date().toISOString(),
  };
}

/** Écoutes récentes de l'API (ou du worker) → RawPlay, durée inconnue. */
export function playsFromApi(
  rows: { played_at: string; track: { uri: string; name: string; duration_ms: number; artists?: { name: string }[]; album?: { name: string } } | null }[],
): RawPlay[] {
  // Les podcasts (épisodes) n'ont pas d'artiste : on ne garde que les titres musicaux.
  return rows.filter((r): r is typeof r & { track: NonNullable<(typeof r)['track']> } => !!r.track?.uri.startsWith('spotify:track:')).map((r) => ({
    ts: Date.parse(r.played_at),
    ms: r.track.duration_ms,
    uri: r.track.uri,
    name: r.track.name,
    artist: r.track.artists?.[0]?.name ?? '',
    album: r.track.album?.name ?? '',
    flags: FLAG_NO_DURATION,
  }));
}

export async function readExportFiles(files: FileList | File[]): Promise<{ plays: RawPlay[]; names: string[]; skipped: string[] }> {
  const plays: RawPlay[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  for (const f of Array.from(files)) {
    if (!f.name.endsWith('.json')) {
      skipped.push(f.name);
      continue;
    }
    try {
      const parsed = parseExport(JSON.parse(await f.text()));
      if (!parsed.length) {
        skipped.push(f.name);
        continue;
      }
      plays.push(...parsed);
      names.push(f.name);
    } catch {
      skipped.push(f.name);
    }
  }
  return { plays, names, skipped };
}
