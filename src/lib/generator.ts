import { FAMILY_BY_ID } from './genres';
import type { EnrichedTrack, LibraryIndex } from './indexer';
import { MOOD_BY_ID } from './moods';
import { SELECTING_SORTS, sortTracks, SORT_LABELS } from './ordering';
import type { AudioFeatures, Range, Rule, SavedPlaylist } from './types';

export const defaultRule = (): Rule => ({
  families: [],
  genres: [],
  moods: [],
  artistsInclude: [],
  artistsExclude: [],
  sources: [],
  explicit: 'any',
  maxTracks: 50,
  maxPerArtist: 0,
  sort: 'shuffle',
  seed: Math.floor(Math.random() * 1e9),
});

const DAY = 86_400_000;
const FEATURE_KEYS = ['energy', 'valence', 'danceability', 'acousticness', 'tempo'] as const;

export function usesFeatures(rule: Rule): boolean {
  return FEATURE_KEYS.some((k) => rule[k]) || rule.sort === 'harmonic' || rule.sort === 'energy_arc';
}

const inRange = (v: number, r?: Range) => !r || (v >= r[0] && v <= r[1]);

export function usesHistory(rule: Rule): boolean {
  return !!(rule.minPlays || rule.notPlayedForDays || rule.playedWithinDays || rule.maxSkipRate !== undefined || rule.discoveredWithinDays);
}

export interface FilterReport {
  matched: EnrichedTrack[];
  /** Titres écartés uniquement parce qu'il leur manque des audio-features. */
  missingFeatures: number;
}

export function filterTracks(index: LibraryIndex, rule: Rule, pool?: Set<string>, now = Date.now()): FilterReport {
  const featureFilter = FEATURE_KEYS.some((k) => rule[k]);
  const include = new Set(rule.artistsInclude);
  const exclude = new Set(rule.artistsExclude);
  const banned = new Set(rule.excluded ?? []);
  const historyFilter = usesHistory(rule);
  let missingFeatures = 0;

  const matched = index.tracks.filter((t) => {
    const tr = t.track;
    if (pool && !pool.has(tr.id)) return false;
    if (banned.has(tr.id)) return false;
    if (rule.sources.length && !rule.sources.some((s) => t.sources.includes(s))) return false;
    if (include.size && !tr.artists.some((a) => include.has(a.id))) return false;
    if (tr.artists.some((a) => exclude.has(a.id))) return false;
    if (rule.families.length && !rule.families.some((f) => t.families.includes(f))) return false;
    if (rule.genres.length && !rule.genres.some((g) => t.genres.includes(g))) return false;
    if (rule.moods.length && !rule.moods.some((m) => t.moods.includes(m))) return false;
    if (rule.yearMin && (!t.year || t.year < rule.yearMin)) return false;
    if (rule.yearMax && (!t.year || t.year > rule.yearMax)) return false;
    if (rule.addedWithinDays || rule.addedBeforeDays) {
      if (!tr.likedAt) return false;
      const age = (now - Date.parse(tr.likedAt)) / DAY;
      if (rule.addedWithinDays && age > rule.addedWithinDays) return false;
      if (rule.addedBeforeDays && age < rule.addedBeforeDays) return false;
    }
    if (rule.excludeHeavyRotation && t.heavyRotation) return false;
    if (rule.maxDurationMin && tr.durationMs > rule.maxDurationMin * 60_000) return false;
    if (rule.explicit === 'exclude' && tr.explicit) return false;
    if (rule.explicit === 'only' && !tr.explicit) return false;
    if (historyFilter) {
      const l = t.listen;
      const daysSince = (ts: number) => (now - ts) / DAY;
      if (rule.minPlays && (l?.plays ?? 0) < rule.minPlays) return false;
      if (rule.notPlayedForDays && l && daysSince(l.last) < rule.notPlayedForDays) return false;
      if (rule.playedWithinDays && (!l || daysSince(l.last) > rule.playedWithinDays)) return false;
      if (rule.maxSkipRate !== undefined && l?.skipRate !== undefined && l.skipRate > rule.maxSkipRate) return false;
      if (rule.discoveredWithinDays && (!l || daysSince(l.first) > rule.discoveredWithinDays)) return false;
    }
    if (featureFilter) {
      if (!t.features) {
        missingFeatures++;
        return false;
      }
      for (const k of FEATURE_KEYS) {
        if (!inRange(t.features[k as keyof AudioFeatures], rule[k])) return false;
      }
    }
    return true;
  });
  return { matched, missingFeatures };
}

/** Applique le plafond par artiste en respectant l'ordre de priorité donné. */
export function capPerArtist(tracks: EnrichedTrack[], max: number, limit: number): EnrichedTrack[] {
  const counts = new Map<string, number>();
  const out: EnrichedTrack[] = [];
  for (const t of tracks) {
    if (out.length >= limit) break;
    const a = t.track.artists[0]?.id ?? '';
    const c = counts.get(a) ?? 0;
    if (max > 0 && c >= max) continue;
    counts.set(a, c + 1);
    out.push(t);
  }
  return out;
}

export interface GeneratedPlaylist {
  tracks: EnrichedTrack[];
  matchedCount: number;
  missingFeatures: number;
}

/** `pool` restreint la génération à un sous-ensemble de titres (ex. une ambiance détectée). */
export function generate(index: LibraryIndex, rule: Rule, pool?: Set<string>): GeneratedPlaylist {
  const banned = new Set(rule.excluded ?? []);
  // Les titres épinglés à la main passent avant tout, quels que soient les critères.
  const pinned = (rule.pinned ?? []).filter((id) => !banned.has(id)).map((id) => index.byId.get(id)).filter((t): t is EnrichedTrack => !!t);
  const pinnedIds = new Set(pinned.map((t) => t.track.id));
  const filtered = filterTracks(index, rule, pool);
  const matched = filtered.matched.filter((t) => !pinnedIds.has(t.track.id));
  const room = Math.max(0, rule.maxTracks - pinned.length);
  // Sélection d'abord (aléatoire ou par affinité), mise en ordre ensuite :
  // sinon « énergie croissante » + limite 50 ne garderait que les 50 titres les plus calmes.
  const selectionOrder = sortTracks(matched, rule.sort === 'affinity' ? 'affinity' : 'shuffle', rule.seed);
  // Pour les tris chronologiques ou par écoutes, on veut les plus récents/anciens/écoutés de tout le filtre.
  const picked = SELECTING_SORTS.includes(rule.sort)
    ? capPerArtist(sortTracks(matched, rule.sort, rule.seed), rule.maxPerArtist, room)
    : capPerArtist(selectionOrder, rule.maxPerArtist, room);
  const tracks = sortTracks([...pinned, ...picked], rule.sort, rule.seed);
  return { tracks, matchedCount: matched.length + pinned.length, missingFeatures: filtered.missingFeatures };
}

/**
 * Nouveau tirage d'une playlist vivante : génère selon la recette (nouvelle graine), en gardant
 * les titres épinglés absents de la bibliothèque (ajoutés depuis la recherche Spotify).
 */
export function livingRefresh(index: LibraryIndex, saved: SavedPlaylist, seed = Math.floor(Math.random() * 1e9)): { rule: Rule; uris: string[] } {
  const rule = { ...saved.rule, seed };
  const { tracks } = generate(index, rule, saved.pool ? new Set(saved.pool) : undefined);
  const banned = new Set(rule.excluded ?? []);
  const extra = (rule.pinned ?? []).filter((id) => !index.byId.has(id) && !banned.has(id)).map((id) => `spotify:track:${id}`);
  return { rule, uris: [...tracks.map((t) => t.track.uri), ...extra] };
}

// ---------- Nom et description automatiques ----------

export function describeRule(rule: Rule, artistName: (id: string) => string): { name: string; description: string } {
  const parts: string[] = [];
  if (rule.moods.length) parts.push(rule.moods.map((m) => MOOD_BY_ID[m].label).join(' / '));
  if (rule.families.length) parts.push(rule.families.map((f) => FAMILY_BY_ID[f]?.label ?? f).join(' / '));
  if (rule.genres.length) parts.push(rule.genres.slice(0, 3).join(', '));
  if (rule.artistsInclude.length) parts.push(rule.artistsInclude.slice(0, 3).map(artistName).join(', '));
  if (rule.yearMin || rule.yearMax) {
    if (rule.yearMin && rule.yearMax && Math.floor(rule.yearMin / 10) === Math.floor(rule.yearMax / 10) && rule.yearMax - rule.yearMin === 9) {
      parts.push(`Années ${String(rule.yearMin).slice(2)}`);
    } else parts.push(`${rule.yearMin ?? '…'}–${rule.yearMax ?? '…'}`);
  }
  if (rule.addedWithinDays) parts.push(`ajouts des ${rule.addedWithinDays} derniers jours`);
  if (rule.excludeHeavyRotation) parts.push('pépites oubliées');
  if (rule.tempo) parts.push(`${rule.tempo[0]}–${rule.tempo[1]} BPM`);
  const pct = (r: Range) => `${Math.round(r[0] * 100)}–${Math.round(r[1] * 100)}%`;
  if (rule.energy) parts.push(`énergie ${pct(rule.energy)}`);
  if (rule.valence) parts.push(`positivité ${pct(rule.valence)}`);
  if (rule.minPlays) parts.push(`écoutés ${rule.minPlays}+ fois`);
  if (rule.notPlayedForDays) parts.push(`pas écoutés depuis ${rule.notPlayedForDays} j`);
  if (rule.playedWithinDays) parts.push(`écoutés ces ${rule.playedWithinDays} j`);
  if (rule.discoveredWithinDays) parts.push(`découverts ces ${rule.discoveredWithinDays} j`);
  const name = parts.length ? parts.slice(0, 3).join(' · ') : 'Mix de ma bibliothèque';
  const description = `${[...parts, SORT_LABELS[rule.sort].toLowerCase()].join(' · ')} — généré par Sillon le ${new Date().toLocaleDateString('fr-FR')}`;
  return { name, description: description.slice(0, 300) };
}
