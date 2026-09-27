import { describe, expect, it } from 'vitest';
import { cleanTag, familyOfTag, profileFromTags } from './genres';
import { capPerArtist, defaultRule, describeRule, generate } from './generator';
import { buildIndex } from './indexer';
import { moodsFromFeatures } from './moods';
import { camelotLabel, energyArc, harmonicOrder, keyCompatibility, SORT_GROUPS, SORT_LABELS, sortTracks, tempoDistance, toCamelot } from './ordering';
import { canonicalTitle, computeStats } from './stats';
import { buildSuggestions, kmeans } from './suggestions';
import type { AudioFeatures, FeatureStore, Library, TagStore, Track } from './types';

// ---------- Fixtures ----------

const feat = (p: Partial<AudioFeatures>): AudioFeatures => ({
  acousticness: 0.2, danceability: 0.5, energy: 0.5, instrumentalness: 0, liveness: 0.1,
  loudness: -8, speechiness: 0.05, tempo: 120, valence: 0.5, key: 0, mode: 1, ...p,
});

function makeLibrary(n: number) {
  const tracks: Record<string, Track> = {};
  const features: FeatureStore = {};
  const artists: Library['artists'] = {};
  const tags: TagStore = {};
  const styles = [
    { tags: ['alternative rock', 'rock', 'seen live'], f: { energy: 0.85, valence: 0.35, tempo: 140, danceability: 0.4 } },
    { tags: ['hip hop', 'rap', 'french'], f: { energy: 0.65, valence: 0.55, speechiness: 0.35, danceability: 0.8 } },
    { tags: ['ambient', 'electronic', 'chill'], f: { energy: 0.15, valence: 0.25, instrumentalness: 0.9, acousticness: 0.6, tempo: 80 } },
  ];
  for (let i = 0; i < n; i++) {
    const s = styles[i % 3];
    const artistId = `a${i % 12}`;
    artists[artistId] ??= { id: artistId, name: `Artist ${i % 12}`, topRanks: {}, followed: false };
    tags[artistId] ??= { tags: styles[(i % 12) % 3].tags, source: 'lastfm', fetchedAt: '' };
    const id = `t${i}`;
    tracks[id] = {
      id, uri: `spotify:track:${id}`, name: `Song ${i}`,
      artists: [{ id: artistId, name: `Artist ${i % 12}` }],
      album: { id: `al${i}`, name: 'Album', releaseDate: `${1970 + (i % 50)}-01-01` },
      durationMs: 200_000, explicit: i % 7 === 0, playlists: [], topRanks: i < 5 ? { short_term: i + 1 } : {},
      likedAt: new Date(Date.now() - i * 86_400_000 * 5).toISOString(),
    };
    features[id] = feat({ ...s.f, key: i % 12, mode: i % 2, energy: Math.min(1, s.f.energy + ((i % 5) - 2) * 0.02) });
  }
  const lib: Library = { user: { id: 'me', name: 'Me' }, tracks, artists, playlists: [], syncedAt: '' };
  return { lib, index: buildIndex(lib, tags, features) };
}

// ---------- Genres ----------

describe('genres', () => {
  it('filtre les tags bruités', () => {
    expect(cleanTag('seen live')).toBeNull();
    expect(cleanTag('British')).toBeNull();
    expect(cleanTag('80s')).toBeNull();
    expect(cleanTag('female vocalists')).toBeNull();
    expect(cleanTag('Shoegaze')).toBe('shoegaze');
  });

  it('range les tags dans la bonne famille', () => {
    expect(familyOfTag('black metal')).toBe('metal');
    expect(familyOfTag('alternative rock')).toBe('indie');
    expect(familyOfTag('hard rock')).toBe('rock');
    expect(familyOfTag('trap')).toBe('hiphop');
    expect(familyOfTag('french house')).toBe('electronic');
    expect(familyOfTag('r&b')).toBe('rnb');
    expect(familyOfTag('chanson française')).toBe('chanson');
    expect(familyOfTag('indie pop')).toBe('indie');
    expect(familyOfTag('k-pop')).toBe('pop');
    expect(familyOfTag('dancehall')).toBe('reggae'); // « dance » ne doit pas matcher « dancehall »
    expect(familyOfTag('trapeze')).toBeNull();
  });

  it('extrait genres, familles et indices de mood', () => {
    const p = profileFromTags(['electronic', 'ambient', 'chill', 'seen live', 'british']);
    expect(p.genres).toEqual(['electronic', 'ambient']);
    expect(p.families).toContain('electronic');
    expect(p.moodHints).toEqual(['chill']);
  });
});

// ---------- Moods ----------

describe('moods', () => {
  it('reconnaît des profils typiques', () => {
    expect(moodsFromFeatures(feat({ energy: 0.2, valence: 0.3, acousticness: 0.8, tempo: 85 }))).toContain('chill');
    expect(moodsFromFeatures(feat({ energy: 0.92, tempo: 150, valence: 0.15 }))[0]).toBe('intense');
    expect(moodsFromFeatures(feat({ danceability: 0.88, energy: 0.8, valence: 0.8, tempo: 124 }))).toContain('party');
    expect(moodsFromFeatures(feat({ instrumentalness: 0.9, speechiness: 0.03, energy: 0.35 }))).toContain('focus');
    expect(moodsFromFeatures(feat({ valence: 0.1, energy: 0.3 }))).toContain('melancholy');
  });
});

// ---------- Ordonnancement ----------

describe('camelot', () => {
  it('convertit tonalité + mode', () => {
    expect(camelotLabel(toCamelot(0, 1))).toBe('8B'); // Do majeur
    expect(camelotLabel(toCamelot(9, 0))).toBe('8A'); // La mineur
    expect(camelotLabel(toCamelot(11, 1))).toBe('1B'); // Si majeur
    expect(camelotLabel(toCamelot(4, 0))).toBe('9A'); // Mi mineur
    expect(camelotLabel(toCamelot(8, 0))).toBe('1A'); // Sol# mineur
    expect(toCamelot(-1, 1)).toBeNull();
  });

  it('note la compatibilité harmonique', () => {
    const c = (n: number, l: 'A' | 'B') => ({ n, letter: l });
    expect(keyCompatibility(c(8, 'B'), c(8, 'B'))).toBe(1);
    expect(keyCompatibility(c(12, 'A'), c(1, 'A'))).toBe(0.9); // la roue boucle
    expect(keyCompatibility(c(8, 'A'), c(8, 'B'))).toBe(0.85);
    expect(keyCompatibility(c(3, 'A'), c(9, 'B'))).toBe(0);
  });

  it('gère le half/double time', () => {
    expect(tempoDistance(85, 170)).toBeCloseTo(0);
    expect(tempoDistance(120, 121)).toBeLessThan(0.1);
    expect(tempoDistance(90, 140)).toBe(1);
  });

  it('ordonne sans perdre ni dupliquer de titres', () => {
    const { index } = makeLibrary(60);
    for (const fn of [harmonicOrder, energyArc]) {
      const out = fn(index.tracks);
      expect(out).toHaveLength(60);
      expect(new Set(out.map((t) => t.track.id)).size).toBe(60);
    }
    const arc = energyArc(index.tracks).map((t) => t.features!.energy);
    const peak = arc.indexOf(Math.max(...arc));
    expect(peak).toBeGreaterThan(arc.length * 0.4);
    expect(peak).toBeLessThan(arc.length * 0.9);
  });

  it('trie par artiste, puis par discographie', () => {
    const { index } = makeLibrary(60);
    const out = sortTracks(index.tracks, 'artist', 1);
    const names = out.map((t) => t.track.artists[0].name);
    // Tri naturel : « Artist 2 » avant « Artist 10 ».
    expect(names.indexOf('Artist 2')).toBeLessThan(names.indexOf('Artist 10'));
    expect([...names].sort(new Intl.Collator('fr', { numeric: true }).compare)).toEqual(names);
    const dates = out.filter((t) => t.track.artists[0].name === 'Artist 3').map((t) => t.track.album.releaseDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('regroupe chaque artiste en un seul bloc', () => {
    const { index } = makeLibrary(60);
    const ids = sortTracks(index.tracks, 'artist_blocks', 7).map((t) => t.track.artists[0].id);
    const blocks = ids.filter((id, i) => id !== ids[i - 1]);
    expect(new Set(blocks).size).toBe(blocks.length);
    expect(ids).toHaveLength(60);
  });

  it('liste chaque mode d’ordre dans un groupe', () => {
    expect(SORT_GROUPS.flatMap((g) => g.modes).sort()).toEqual(Object.keys(SORT_LABELS).sort());
  });
});

// ---------- Générateur ----------

describe('generator', () => {
  const { lib, index } = makeLibrary(90);

  it('filtre par famille et mood', () => {
    const r = generate(index, { ...defaultRule(), families: ['ambient'], maxPerArtist: 0, maxTracks: 500 });
    expect(r.tracks.length).toBeGreaterThan(0);
    expect(r.tracks.every((t) => t.families.includes('ambient'))).toBe(true);
    const chill = generate(index, { ...defaultRule(), moods: ['chill'], maxPerArtist: 0, maxTracks: 500 });
    expect(chill.tracks.every((t) => t.moods.includes('chill'))).toBe(true);
  });

  it('respecte la limite et le plafond par artiste', () => {
    const r = generate(index, { ...defaultRule(), maxTracks: 20, maxPerArtist: 2 });
    expect(r.tracks.length).toBeLessThanOrEqual(20);
    const counts = new Map<string, number>();
    r.tracks.forEach((t) => counts.set(t.track.artists[0].id, (counts.get(t.track.artists[0].id) ?? 0) + 1));
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it('applique les plages audio et les années', () => {
    const r = generate(index, { ...defaultRule(), energy: [0.7, 1], yearMin: 1980, yearMax: 1999, maxTracks: 500, maxPerArtist: 0 });
    expect(r.tracks.every((t) => t.features!.energy >= 0.7 && t.year! >= 1980 && t.year! <= 1999)).toBe(true);
  });

  it('exclut les titres en rotation', () => {
    const r = generate(index, { ...defaultRule(), excludeHeavyRotation: true, maxTracks: 500, maxPerArtist: 0 });
    expect(r.tracks.some((t) => t.heavyRotation)).toBe(false);
    expect(r.matchedCount).toBe(85);
  });

  it('est reproductible avec la même graine', () => {
    const rule = { ...defaultRule(), seed: 7 };
    expect(generate(index, rule).tracks.map((t) => t.track.id)).toEqual(generate(index, rule).tracks.map((t) => t.track.id));
  });

  it('prend les plus récents de tout le filtre en tri par ajout', () => {
    const r = generate(index, { ...defaultRule(), sort: 'added_desc', maxTracks: 3, maxPerArtist: 0 });
    expect(r.tracks.map((t) => t.track.id)).toEqual(['t0', 't1', 't2']);
  });

  it('capPerArtist garde l’ordre', () => {
    const out = capPerArtist(index.tracks, 1, 100);
    expect(out.length).toBe(12);
  });

  it('nomme la playlist', () => {
    const d = describeRule({ ...defaultRule(), moods: ['chill'], yearMin: 1990, yearMax: 1999 }, (id) => lib.artists[id].name);
    expect(d.name).toBe('Chill · Années 90');
  });
});

// ---------- Suggestions & stats ----------

describe('suggestions & stats', () => {
  it('k-means sépare des groupes évidents', () => {
    const pts = [...Array(30)].map((_, i) => (i < 15 ? [0, 0] : [1, 1]).map((x) => x + (i % 3) * 0.01));
    const a = kmeans(pts, 2, 1);
    expect(new Set(a.slice(0, 15)).size).toBe(1);
    expect(new Set(a.slice(15)).size).toBe(1);
    expect(a[0]).not.toBe(a[15]);
  });

  it('propose ambiances, moods et redécouvertes', () => {
    const { lib, index } = makeLibrary(300);
    const s = buildSuggestions(index, (id) => lib.artists[id].name);
    const kinds = new Set(s.map((x) => x.kind));
    expect(kinds.has('ambiance')).toBe(true);
    expect(kinds.has('mood')).toBe(true);
    expect(kinds.has('genre')).toBe(true);
    expect(s.every((x) => x.size >= 15)).toBe(true);
  });

  it('détecte les doublons de versions', () => {
    expect(canonicalTitle('Karma Police (Remastered 2017)')).toBe(canonicalTitle('Karma Police - Live'));
    const { lib, index } = makeLibrary(10);
    const t = lib.tracks.t0;
    lib.tracks.dup = { ...t, id: 'dup', name: `${t.name} - Remastered` };
    const stats = computeStats(lib, buildIndex(lib, {}, {}));
    expect(stats.duplicates).toHaveLength(1);
    expect(computeStats(lib, index).totalTracks).toBe(10);
  });
});
