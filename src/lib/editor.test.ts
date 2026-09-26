import { describe, expect, it } from 'vitest';
import { applyManualEdits, decodeEntities, dedupeItems, moveItem, moveKeys, summarize, UndoStack, type EditorItem } from './editor';
import { defaultRule, generate } from './generator';
import { emptyHistory, mergePlays, type RawPlay } from './history';
import { buildIndex, listeningByTrack } from './indexer';
import type { Library, Track } from './types';

const item = (uri: string, kind: EditorItem['kind'] = 'track'): EditorItem => ({ key: `k-${uri}-${Math.random()}`, uri, name: uri, artists: '', durationMs: 1000, kind });
const uris = (list: EditorItem[]) => list.map((i) => i.uri);

describe('éditeur de playlist', () => {
  it('déplace un élément', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('déplace une sélection en gardant son ordre', () => {
    const list = ['a', 'b', 'c', 'd'].map((u) => item(u));
    const keys = new Set([list[1].key, list[3].key]);
    expect(uris(moveKeys(list, keys, 'top'))).toEqual(['b', 'd', 'a', 'c']);
    expect(uris(moveKeys(list, keys, 'bottom'))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('dédoublonne sans toucher aux fichiers locaux', () => {
    const list = [item('a'), item('b'), item('a'), item('spotify:local:x', 'local'), item('spotify:local:x', 'local')];
    expect(uris(dedupeItems(list))).toEqual(['a', 'b', 'spotify:local:x', 'spotify:local:x']);
  });

  it('résume les modifications', () => {
    expect(summarize(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ added: 0, removed: 0, reordered: false });
    expect(summarize(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual({ added: 0, removed: 0, reordered: true });
    expect(summarize(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual({ added: 1, removed: 1, reordered: false });
    expect(summarize(['a', 'a'], ['a'])).toEqual({ added: 0, removed: 1, reordered: false });
  });

  it('transforme les retouches en épinglés / exclus', () => {
    let r = applyManualEdits(defaultRule(), ['a', 'b', 'c'], ['a', 'c', 'd']);
    expect(r.pinned).toEqual(['d']);
    expect(r.excluded).toEqual(['b']);
    // Remettre un titre exclu le réépingle ; retirer un épinglé le désépingle.
    r = applyManualEdits(r, ['a', 'c', 'd'], ['a', 'b', 'c']);
    expect(r.pinned).toEqual(['b']);
    expect(r.excluded).toEqual(['d']);
  });

  it('pile d’annulation bornée', () => {
    const u = new UndoStack<number>(2);
    u.push(1);
    u.push(2);
    u.push(3);
    expect(u.pop()).toBe(3);
    expect(u.pop()).toBe(2);
    expect(u.pop()).toBeUndefined();
  });

  it('décode les entités HTML des descriptions', () => {
    expect(decodeEntities('L&#x27;été &amp; les &quot;tubes&quot; &#233;')).toBe('L\'été & les "tubes" é');
    expect(decodeEntities('&inconnu;')).toBe('&inconnu;');
  });
});

// ---------- Générateur : épinglés, exclus, critères d'historique ----------

function fixture() {
  const tracks: Record<string, Track> = {};
  for (let i = 0; i < 30; i++) {
    tracks[`t${i}`] = {
      id: `t${i}`, uri: `spotify:track:t${i}`, name: `Song ${i}`, artists: [{ id: `a${i % 10}`, name: `Artist ${i % 10}` }],
      album: { id: 'al', name: 'Al', releaseDate: '2010-01-01' }, durationMs: 200_000, explicit: false, playlists: [], topRanks: {}, likedAt: '2024-01-01',
    };
  }
  const lib: Library = { user: { id: 'me', name: 'Me' }, tracks, artists: {}, playlists: [], syncedAt: '' };
  const now = Date.now();
  const DAY = 86_400_000;
  const plays: RawPlay[] = [];
  const play = (id: string, ts: number, over: Partial<RawPlay> = {}) =>
    plays.push({ ts, ms: 200_000, uri: `spotify:track:${id}`, name: tracks[id].name, artist: tracks[id].artists[0].name, album: 'Al', flags: 0, ...over });
  // t0 : 12 écoutes il y a 1 an (favori perdu de vue). t1 : 5 écoutes récentes, dont 4 skips.
  for (let k = 0; k < 12; k++) play('t0', now - 400 * DAY + k * DAY);
  for (let k = 0; k < 5; k++) play('t1', now - 10 * DAY + k * DAY, k < 4 ? { ms: 5000, flags: 1 } : {});
  // t2 : écouté sans URI (export basique), doit être rattaché par nom.
  plays.push({ ts: now - 5 * DAY, ms: 200_000, name: 'Song 2', artist: 'Artist 2', album: '', flags: 0 });
  const history = mergePlays(emptyHistory(), plays);
  return { lib, history, index: buildIndex(lib, {}, {}, history) };
}

describe('générateur : retouches et historique', () => {
  const { lib, history, index } = fixture();

  it('rattache l’historique aux titres, y compris sans URI', () => {
    const l = listeningByTrack(lib, history);
    expect(l.get('t0')?.plays).toBe(12);
    expect(l.get('t1')?.skipRate).toBe(0.8);
    expect(l.get('t2')?.plays).toBe(1);
    expect(index.hasHistory).toBe(true);
  });

  it('inclut toujours les épinglés et jamais les exclus', () => {
    const rule = { ...defaultRule(), maxTracks: 5, maxPerArtist: 0, pinned: ['t29', 't28'], excluded: ['t3', 't28'] };
    for (let seed = 0; seed < 20; seed++) {
      const ids = generate(index, { ...rule, seed }).tracks.map((t) => t.track.id);
      expect(ids).toHaveLength(5);
      expect(ids).toContain('t29');
      expect(ids).not.toContain('t28'); // exclu l'emporte sur épinglé
      expect(ids).not.toContain('t3');
    }
  });

  it('filtre selon l’historique', () => {
    const ids = (patch: object) => generate(index, { ...defaultRule(), maxTracks: 100, maxPerArtist: 0, ...patch }).tracks.map((t) => t.track.id).sort();
    expect(ids({ minPlays: 10, notPlayedForDays: 180 })).toEqual(['t0']);
    expect(ids({ playedWithinDays: 30 })).toEqual(['t1', 't2']);
    expect(ids({ playedWithinDays: 30, maxSkipRate: 0.5 })).toEqual(['t2']);
    expect(ids({ discoveredWithinDays: 30 })).toEqual(['t1', 't2']);
  });

  it('l’historique renforce l’affinité', () => {
    expect(index.byId.get('t0')!.affinity).toBeGreaterThan(index.byId.get('t5')!.affinity);
  });
});
