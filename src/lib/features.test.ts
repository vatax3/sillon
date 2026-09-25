import { describe, expect, it } from 'vitest';
import { emptyHistory, FLAG_NO_DURATION, FLAG_SKIPPED, mergePlays, parseExport, type RawPlay } from './history';
import { availablePeriods, computeHistoryStats, loyalArtists, moodByMoment, timeMachine, topTracksWhere, yearsSummary } from './historyStats';
import { buildIndex } from './indexer';
import { blend, buildTasteCard, compatibility, parseTasteCard, type TasteCard } from './social';
import { dedupeIds, diffWithBackup, followSuggestions, inPlaylistsNotLiked, likedOrphans, mergePlaylists, playlistHealth, playlistOverlaps, snapshot } from './tools';
import type { Library, Track } from './types';

const DAY = 86_400_000;

// ---------- Historique ----------

describe('import d’historique', () => {
  it('lit l’export étendu (skips, shuffle, podcasts ignorés)', () => {
    const plays = parseExport([
      { ts: '2024-03-01T10:00:00Z', ms_played: 200000, master_metadata_track_name: 'Creep', master_metadata_album_artist_name: 'Radiohead', master_metadata_album_album_name: 'Pablo Honey', spotify_track_uri: 'spotify:track:abc', reason_end: 'trackdone', shuffle: true, skipped: false },
      { ts: '2024-03-01T10:05:00Z', ms_played: 5000, master_metadata_track_name: 'Airbag', master_metadata_album_artist_name: 'Radiohead', master_metadata_album_album_name: 'OK Computer', spotify_track_uri: 'spotify:track:def', reason_end: 'fwdbtn', shuffle: false, skipped: null },
      { ts: '2024-03-01T11:00:00Z', ms_played: 900000, master_metadata_track_name: null, master_metadata_album_artist_name: null, master_metadata_album_album_name: null, spotify_track_uri: null, episode_name: 'Un podcast' },
    ]);
    expect(plays).toHaveLength(2);
    expect(plays[0].flags & 2).toBeTruthy();
    expect(plays[1].flags & FLAG_SKIPPED).toBeTruthy();
    expect(plays[0].uri).toBe('spotify:track:abc');
  });

  it('lit l’export basique (UTC, pas d’URI)', () => {
    const plays = parseExport([{ endTime: '2024-01-31 18:22', artistName: 'PNL', trackName: 'Au DD', msPlayed: 180000 }]);
    expect(plays[0].ts).toBe(Date.parse('2024-01-31T18:22:00Z'));
    expect(plays[0].uri).toBeUndefined();
  });

  it('refuse un fichier inconnu', () => {
    expect(() => parseExport([{ foo: 1 }])).toThrow();
  });

  const p = (ts: number, over: Partial<RawPlay> = {}): RawPlay => ({ ts, ms: 200_000, uri: 'spotify:track:abc', name: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', flags: 0, ...over });

  it('dédoublonne les réimports et fusionne API + export', () => {
    let h = mergePlays(emptyHistory(), [p(1000), p(500_000)], ['a.json']);
    h = mergePlays(h, [p(1000), p(500_000)], ['a.json']); // même fichier réimporté
    expect(h.ts.length).toBe(2);
    // La même écoute vue par l'API (horodatée au début) : absorbée, la version détaillée est gardée.
    h = mergePlays(h, [p(1000 - 190_000, { flags: FLAG_NO_DURATION })]);
    expect(h.ts.length).toBe(2);
    expect([...h.flags].every((f) => !(f & FLAG_NO_DURATION))).toBe(true);
    expect(h.importedFiles).toEqual(['a.json']);
  });

  it('garde les vraies réécoutes d’une même source', () => {
    const h = mergePlays(emptyHistory(), [p(0), p(20_000, { ms: 20_000 }), p(220_000)]);
    expect(h.ts.length).toBe(3);
  });

  it('rattache une écoute sans URI au titre connu', () => {
    const h = mergePlays(emptyHistory(), [p(0), p(10 * DAY, { uri: undefined, name: 'Creep', artist: 'Radiohead' })]);
    expect(h.tracks).toHaveLength(1);
    expect(h.tracks[0].key).toBe('abc');
  });
});

// ---------- Stats d'historique ----------

function syntheticHistory() {
  const plays: RawPlay[] = [];
  const base = new Date(2023, 0, 2, 9).getTime(); // lundi 2 janvier 2023, 9h
  // 20 jours d'affilée : Creep tous les jours (obsession), Airbag skippé souvent.
  for (let d = 0; d < 20; d++) {
    plays.push({ ts: base + d * DAY, ms: 230_000, uri: 'spotify:track:creep', name: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', flags: 0 });
    plays.push({ ts: base + d * DAY + 300_000, ms: d % 4 === 0 ? 200_000 : 8_000, uri: 'spotify:track:airbag', name: 'Airbag', artist: 'Radiohead', album: 'OK Computer', flags: d % 4 === 0 ? 0 : FLAG_SKIPPED });
  }
  for (let i = 0; i < 6; i++) plays.push({ ts: base + i * DAY + 4 * 3_600_000, ms: 200_000, uri: `spotify:track:x${i}`, name: `Extra ${i}`, artist: 'Radiohead', album: 'Extras', flags: 0 });
  // Un autre artiste en mars, et des écoutes les années suivantes (fidélité).
  for (let d = 0; d < 10; d++) plays.push({ ts: new Date(2023, 2, 1 + d, 21).getTime(), ms: 180_000, uri: 'spotify:track:dd', name: 'Au DD', artist: 'PNL', album: 'Deux frères', flags: 0 });
  for (const y of [2024, 2025]) plays.push({ ts: new Date(y, 0, 5, 9).getTime(), ms: 230_000, uri: 'spotify:track:creep', name: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', flags: 0 });
  return mergePlays(emptyHistory(), plays);
}

describe('stats d’historique', () => {
  const h = syntheticHistory();
  const all = { from: 0, to: Infinity };
  const s = computeHistoryStats(h, all);

  it('agrège temps, écoutes, séries', () => {
    expect(s.streams).toBe(20 + 5 + 6 + 10 + 2); // les 15 skips < 30 s ne comptent pas
    expect(s.uniqueArtists).toBe(2);
    expect(s.longestStreak.days).toBe(20);
    expect(s.topArtists[0].key).toBe('Radiohead');
    expect(s.topTracks[0].streams).toBe(22);
  });

  it('place les écoutes dans la bonne case horaire (lundi 9h)', () => {
    expect(s.heatmap[0][9]).toBeGreaterThan(0);
  });

  it('détecte skips, obsessions et époques', () => {
    const airbag = s.skippedTracks.find((r) => h.tracks[r.key as number].name === 'Airbag');
    expect(airbag?.rate).toBe(0.75);
    expect(s.obsessions[0]?.count).toBeGreaterThanOrEqual(14);
    expect(s.eras.map((e) => e.artist)).toEqual(['Radiohead', 'PNL', 'Radiohead']);
  });

  it('filtre par période', () => {
    const y2023 = availablePeriods(h).find((p) => p.id === 'y2023')!;
    expect(computeHistoryStats(h, y2023).streams).toBe(41);
  });

  it('résumés annuels, fidélité, machine à remonter le temps', () => {
    const years = yearsSummary(h);
    expect(years.map((y) => y.year)).toEqual([2025, 2024, 2023]);
    expect(years[2].topArtist).toBe('Radiohead');
    expect(years[2].newArtists).toBe(2);
    expect(loyalArtists(h)[0]).toMatchObject({ artist: 'Radiohead', years: 3 });
    const tm = timeMachine(h, new Date(2024, 0, 15));
    expect(tm[0].year).toBe(2023);
    expect(topTracksWhere(h, all, (d) => d.getHours() >= 19)[0].streams).toBe(10);
  });

  it('humeur × moment pondérée par le temps d’écoute', () => {
    const f = { acousticness: 0, danceability: 0.5, energy: 0.9, instrumentalness: 0, liveness: 0, loudness: -5, speechiness: 0, tempo: 120, valence: 0.2, key: 0, mode: 1 };
    const m = moodByMoment(h, { creep: f }, all);
    expect(m.byHour[9].energy).toBeCloseTo(0.9);
    expect(m.coverage).toBeGreaterThan(0.5);
  });
});

// ---------- Rangement ----------

function lib(): Library {
  const mk = (id: string, artist: string, extra: Partial<Track> = {}): Track => ({
    id, uri: `spotify:track:${id}`, name: `Song ${id}`, artists: [{ id: artist, name: artist.toUpperCase() }],
    album: { id: `al-${id}`, name: 'Album', releaseDate: '2010-01-01' }, durationMs: 200_000, explicit: false, playlists: [], topRanks: {}, ...extra,
  });
  const tracks: Record<string, Track> = {
    a: mk('a', 'x', { likedAt: '2024-01-01', playlists: ['p1'] }),
    b: mk('b', 'x', { playlists: ['p1', 'p2'] }),
    c: mk('c', 'x', { likedAt: '2024-02-01' }),
    d: mk('d', 'y', { playlists: ['p2'] }),
    e: mk('e', 'x', { likedAt: '2024-03-01', playlists: ['p2'] }),
    f: mk('f', 'x', { likedAt: '2024-03-02' }),
    g: mk('g', 'x', { likedAt: '2024-03-03' }),
  };
  return {
    user: { id: 'me', name: 'Moi' },
    tracks,
    artists: { x: { id: 'x', name: 'X', topRanks: {}, followed: false }, y: { id: 'y', name: 'Y', topRanks: {}, followed: true } },
    playlists: [
      { id: 'p1', name: 'Une', owned: true, collaborative: false, trackCount: 3, synced: true },
      { id: 'p2', name: 'Deux', owned: true, collaborative: false, trackCount: 4, synced: true },
    ],
    playlistItems: { p1: ['a', 'b', 'a'], p2: ['b', 'd', 'e', 'a'] },
    syncedAt: '',
  };
}

describe('outils de rangement', () => {
  const l = lib();
  const index = buildIndex(l, {}, {});

  it('trouve les titres de playlists non likés et les likés orphelins', () => {
    expect(inPlaylistsNotLiked(index).map((t) => t.track.id)).toEqual(['b', 'd']);
    expect(likedOrphans(index).map((t) => t.track.id)).toEqual(['g', 'f', 'c']);
  });

  it('compte les doublons et les recouvrements', () => {
    const h = playlistHealth(l);
    expect(h.find((x) => x.id === 'p1')).toMatchObject({ duplicates: 1, duplicateIds: ['a'] });
    const o = playlistOverlaps(l, 0.5, 2);
    expect(o[0]).toMatchObject({ a: 'p1', b: 'p2', shared: 2, containment: 1 });
  });

  it('fusionne sans doublons et dédoublonne en gardant l’ordre', () => {
    expect(mergePlaylists(l, ['p1', 'p2'])).toEqual(['a', 'b', 'd', 'e']);
    expect(dedupeIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('suggère les artistes à suivre', () => {
    expect(followSuggestions(l, index, 3).map((a) => a.id)).toEqual(['x']);
  });

  it('calcule les différences avec une sauvegarde', () => {
    const backup = snapshot(l);
    const changed = structuredClone(l);
    changed.playlistItems!.p2 = ['b', 'd', 'c'];
    changed.playlists = changed.playlists.filter((p) => p.id !== 'p1');
    const diff = diffWithBackup(changed, backup);
    expect(diff.find((d) => d.id === 'p1')?.deleted).toBe(true);
    expect(diff.find((d) => d.id === 'p2')).toMatchObject({ added: ['c'], removed: ['e', 'a'] });
  });
});

// ---------- Social ----------

describe('social', () => {
  const card = (name: string, artists: string[], families: Record<string, number>, tracks: string[]): TasteCard => ({
    app: 'sillon', v: 1, name, createdAt: '2026-01-01', families, decades: { '2010': 1 }, genres: [],
    artists: artists.map((a, i) => ({ name: a, w: 1 - i * 0.1 })),
    tracks: tracks.map((t, i) => ({ uri: `spotify:track:${t}`, name: t, artist: artists[i % artists.length], w: 1 - i * 0.01 })),
    stats: { tracks: 100, artists: 10 },
  });

  it('construit une carte valide depuis la bibliothèque', () => {
    const l = lib();
    const c = buildTasteCard(l, buildIndex(l, {}, {}), null);
    expect(parseTasteCard(JSON.parse(JSON.stringify(c))).name).toBe('Moi');
    expect(() => parseTasteCard({ foo: 1 })).toThrow();
  });

  it('note la compatibilité de façon cohérente', () => {
    const me = card('A', ['Radiohead', 'Blur', 'PNL'], { rock: 0.7, hiphop: 0.3 }, ['1', '2', '3', '4']);
    const twin = card('B', ['Radiohead', 'Blur', 'PNL'], { rock: 0.7, hiphop: 0.3 }, ['1', '2', '3', '4']);
    const other = card('C', ['Mozart', 'Bach'], { classical: 1 }, ['9', '8']);
    expect(compatibility(me, twin).score).toBe(100);
    expect(compatibility(me, other).score).toBeLessThan(25);
    expect(compatibility(me, other).toDiscover).toEqual(['Mozart', 'Bach']);
    expect(compatibility(me, twin).score).toBe(compatibility(twin, me).score);
  });

  it('mélange un Blend sans doublon, avec les titres communs', () => {
    const me = card('A', ['a1', 'a2', 'a3', 'a4', 'a5'], { rock: 1 }, ['s1', 's2', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const them = card('B', ['b1', 'b2', 'b3', 'b4', 'b5'], { pop: 1 }, ['s1', 's2', 't1', 't2', 't3', 't4', 't5', 't6']);
    const b = blend(me, them, 10);
    expect(b).toHaveLength(10);
    expect(new Set(b.map((t) => t.uri)).size).toBe(10);
    expect(b.filter((t) => t.from === 'both')).toHaveLength(2);
    expect(b.some((t) => t.from === 'me') && b.some((t) => t.from === 'them')).toBe(true);
  });
});
