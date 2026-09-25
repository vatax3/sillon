import { FAMILY_BY_ID } from './genres';
import type { EnrichedTrack, LibraryIndex } from './indexer';
import { MOOD_BY_ID } from './moods';
import { sortTracks, SORT_LABELS } from './ordering';
import type { AudioFeatures, Range, Rule } from './types';

export const defaultRule = (): Rule => ({
  families: [],
  genres: [],
  moods: [],
  artistsInclude: [],
  artistsExclude: [],
  sources: [],
  explicit: 'any',
  maxTracks: 50,
  maxPerArtist: 3,
  sort: 'shuffle',
  seed: Math.floor(Math.random() * 1e9),
});

const DAY = 86_400_000;
const FEATURE_KEYS = ['energy', 'valence', 'danceability', 'acousticness', 'tempo'] as const;

export function usesFeatures(rule: Rule): boolean {
  return FEATURE_KEYS.some((k) => rule[k]) || rule.sort === 'harmonic' || rule.sort === 'energy_arc';
}

const inRange = (v: number, r?: Range) => !r || (v >= r[0] && v <= r[1]);

export interface FilterReport {
  matched: EnrichedTrack[];
  /** Titres écartés uniquement parce qu'il leur manque des audio-features. */
  missingFeatures: number;
}

export function filterTracks(index: LibraryIndex, rule: Rule, pool?: Set<string>, now = Date.now()): FilterReport {
  const featureFilter = FEATURE_KEYS.some((k) => rule[k]);
  const include = new Set(rule.artistsInclude);
  const exclude = new Set(rule.artistsExclude);
  let missingFeatures = 0;

  const matched = index.tracks.filter((t) => {
    const tr = t.track;
    if (pool && !pool.has(tr.id)) return false;
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
  const { matched, missingFeatures } = filterTracks(index, rule, pool);
  // Sélection d'abord (aléatoire ou par affinité), mise en ordre ensuite :
  // sinon « énergie croissante » + limite 50 ne garderait que les 50 titres les plus calmes.
  const selectionOrder = sortTracks(matched, rule.sort === 'affinity' ? 'affinity' : 'shuffle', rule.seed);
  const selected = capPerArtist(selectionOrder, rule.maxPerArtist, rule.maxTracks);
  const chronological = ['added_desc', 'release_asc', 'release_desc'].includes(rule.sort);
  // Pour les tris chronologiques, on veut les plus récents/anciens de tout le filtre.
  const tracks = chronological
    ? capPerArtist(sortTracks(matched, rule.sort, rule.seed), rule.maxPerArtist, rule.maxTracks)
    : sortTracks(selected, rule.sort, rule.seed);
  return { tracks, matchedCount: matched.length, missingFeatures };
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
  const name = parts.length ? parts.slice(0, 3).join(' · ') : 'Mix de ma bibliothèque';
  const description = `${[...parts, SORT_LABELS[rule.sort].toLowerCase()].join(' · ')} — généré par Sillon le ${new Date().toLocaleDateString('fr-FR')}`;
  return { name, description: description.slice(0, 300) };
}
