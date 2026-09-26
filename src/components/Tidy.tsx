import { useEffect, useMemo, useState } from 'react';
import { FAMILY_BY_ID } from '../lib/genres';
import type { EnrichedTrack } from '../lib/indexer';
import { MOOD_BY_ID } from '../lib/moods';
import { SORT_LABELS, sortTracks } from '../lib/ordering';
import { artistUrl, playlistUrl, trackUrl } from '../lib/spotify';
import {
  dedupeIds,
  diffWithBackup,
  followSuggestions,
  inPlaylistsNotLiked,
  likedOrphans,
  mergePlaylists,
  playlistHealth,
  playlistOverlaps,
  splitBy,
} from '../lib/tools';
import type { Library, SortMode } from '../lib/types';
import { useStore } from '../store';
import { AsyncButton, PlaylistPicker, SubTabs, TrackRow, useSelection } from './ui';

type View = 'notliked' | 'orphans' | 'health' | 'follow' | 'backups';

export default function Tidy() {
  const { library, index } = useStore();
  const [view, setView] = useState<View>('notliked');
  const notLiked = useMemo(() => (index ? inPlaylistsNotLiked(index) : []), [index]);
  const orphans = useMemo(() => (index ? likedOrphans(index) : []), [index]);
  const follows = useMemo(() => (library && index ? followSuggestions(library, index) : []), [library, index]);

  if (!library?.playlistItems) {
    return (
      <div className="empty">
        <h2>Une resynchronisation est nécessaire</h2>
        <p className="muted">Les outils de rangement ont besoin de l’ordre exact de tes playlists, récupéré à la synchro.</p>
      </div>
    );
  }

  return (
    <div className="tidy">
      <SubTabs
        tabs={[
          { id: 'notliked', label: 'Dans mes playlists, pas likés', badge: notLiked.length },
          { id: 'orphans', label: 'Likés sans playlist', badge: orphans.length },
          { id: 'health', label: 'Santé des playlists' },
          { id: 'follow', label: 'Artistes à suivre', badge: follows.length },
          { id: 'backups', label: 'Sauvegardes' },
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'notliked' && <NotLiked tracks={notLiked} />}
      {view === 'orphans' && <Orphans tracks={orphans} />}
      {view === 'health' && <Health />}
      {view === 'follow' && <Follow rows={follows} />}
      {view === 'backups' && <Backups />}
    </div>
  );
}

const playlistNames = (lib: Library, ids: string[]) =>
  ids.map((id) => lib.playlists.find((p) => p.id === id)?.name).filter(Boolean).join(', ');

// ---------- Dans une playlist mais pas liké ----------

function NotLiked({ tracks }: { tracks: EnrichedTrack[] }) {
  const store = useStore();
  const lib = store.library!;
  const [filter, setFilter] = useState('');
  const shown = filter ? tracks.filter((t) => t.track.playlists.includes(filter)) : tracks;
  const sel = useSelection(shown.map((t) => t.track.id));
  const target = sel.selected.size ? shown.filter((t) => sel.has(t.track.id)) : shown;

  return (
    <section className="panel">
      <header>
        <h3>{shown.length} titres rangés dans tes playlists mais absents de tes Titres likés</h3>
      </header>
      <div className="bulk">
        <label className="check">
          <input type="checkbox" checked={sel.all} onChange={sel.toggleAll} /> {sel.selected.size ? `${sel.selected.size} sélectionné(s)` : 'Tout sélectionner'}
        </label>
        <PlaylistPicker value={filter} onChange={(v) => { setFilter(v); sel.clear(); }} placeholder="Toutes les playlists" />
        <span className="spacer" />
        <AsyncButton
          className="primary small"
          disabled={!target.length}
          onClick={async () => {
            await store.likeTracks(target.map((t) => t.track.id));
            store.say(`${target.length} titre(s) ajouté(s) à tes Titres likés.`);
            sel.clear();
          }}
        >
          ❤ Liker {sel.selected.size ? 'la sélection' : `les ${target.length}`}
        </AsyncButton>
      </div>
      <ul className="rows">
        {shown.slice(0, 300).map((t) => (
          <TrackRow
            key={t.track.id}
            image={t.track.album.image}
            title={t.track.name}
            subtitle={`${t.track.artists.map((a) => a.name).join(', ')} · dans ${playlistNames(lib, t.track.playlists)}`}
            href={trackUrl(t.track.id)}
            selected={sel.has(t.track.id)}
            onSelect={(v) => sel.set(t.track.id, v)}
          >
            <AsyncButton onClick={() => store.likeTracks([t.track.id])}>❤</AsyncButton>
          </TrackRow>
        ))}
      </ul>
      {shown.length > 300 && <p className="muted small">… et {shown.length - 300} autres (l’action groupée les inclut).</p>}
    </section>
  );
}

// ---------- Trieur d'orphelins ----------

function Orphans({ tracks }: { tracks: EnrichedTrack[] }) {
  const store = useStore();
  const lib = store.library!;
  const index = store.index!;
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState('');
  const queue = tracks.filter((t) => !skipped.has(t.track.id));
  const current = queue[0];

  // Profil de chaque playlist : familles et artistes, pour suggérer où ranger.
  const profiles = useMemo(() => {
    return lib.playlists
      .filter((p) => (p.owned || p.collaborative) && lib.playlistItems?.[p.id]?.length)
      .map((p) => {
        const fam = new Map<string, number>();
        const artists = new Set<string>();
        const ids = lib.playlistItems![p.id];
        for (const id of ids) {
          const t = index.byId.get(id);
          if (!t) continue;
          if (t.families[0]) fam.set(t.families[0], (fam.get(t.families[0]) ?? 0) + 1 / ids.length);
          t.track.artists.forEach((a) => artists.add(a.id));
        }
        return { id: p.id, name: p.name, fam, artists };
      });
  }, [lib, index]);

  const suggestions = useMemo(() => {
    if (!current) return [];
    return profiles
      .map((p) => ({
        ...p,
        score: (current.track.artists.some((a) => p.artists.has(a.id)) ? 1 : 0) + (current.families[0] ? p.fam.get(current.families[0]) ?? 0 : 0),
      }))
      .filter((p) => p.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [current, profiles]);

  const file = async (playlistId: string) => {
    await store.addToPlaylist(playlistId, [current.track.id]);
    store.say(`« ${current.track.name} » rangé dans « ${lib.playlists.find((p) => p.id === playlistId)?.name} ».`);
  };
  const skip = () => setSkipped(new Set(skipped).add(current.track.id));

  // Raccourcis clavier : 1–6 pour les suggestions, S ou → pour passer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const n = Number(e.key);
      if (n >= 1 && n <= suggestions.length) void file(suggestions[n - 1].id).catch(store.report);
      else if (e.key === 's' || e.key === 'ArrowRight') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!current) {
    return (
      <div className="empty">
        <h2>Tout est rangé 🎉</h2>
        <p className="muted">{skipped.size ? `${skipped.size} titre(s) passé(s) pendant cette session.` : 'Chaque titre liké est dans au moins une playlist.'}</p>
      </div>
    );
  }

  return (
    <section className="panel sorter">
      <p className="muted small">
        {queue.length} titre(s) liké(s) dans aucune playlist. Range-les un par un : touches <kbd>1</kbd>–<kbd>{Math.max(1, suggestions.length)}</kbd> pour
        les suggestions, <kbd>S</kbd> pour passer.
      </p>
      <div className="sorter-card">
        {current.track.album.image ? <img src={current.track.album.image} alt="" /> : <span className="noimg big" />}
        <div className="sorter-info">
          <a href={trackUrl(current.track.id)} target="_blank" rel="noreferrer" className="sorter-title">
            {current.track.name}
          </a>
          <span className="tl-sub">
            {current.track.artists.map((a) => a.name).join(', ')} · {current.year ?? '—'} · liké le {new Date(current.track.likedAt!).toLocaleDateString('fr-FR')}
          </span>
          <span className="tl-tags left">
            {current.families.map((f) => (
              <span key={f} className="tag subtle">
                {FAMILY_BY_ID[f]?.label ?? f}
              </span>
            ))}
            {current.moods.slice(0, 2).map((m) => (
              <span key={m} className="tag">
                {MOOD_BY_ID[m].emoji} {MOOD_BY_ID[m].label}
              </span>
            ))}
          </span>
          <span className="row">
            <AsyncButton onClick={() => store.playUris([current.track.uri])}>▶ Écouter</AsyncButton>
            <button className="ghost small" onClick={skip}>
              Passer (S)
            </button>
          </span>
        </div>
      </div>
      <div className="sorter-targets">
        {suggestions.map((s, i) => (
          <AsyncButton key={s.id} className="ghost target" onClick={() => file(s.id)}>
            <kbd>{i + 1}</kbd> {s.name}
          </AsyncButton>
        ))}
        <span className="row">
          <PlaylistPicker value={picker} onChange={setPicker} placeholder="Autre playlist…" />
          <AsyncButton disabled={!picker} onClick={() => file(picker)}>
            Ranger
          </AsyncButton>
        </span>
      </div>
    </section>
  );
}

// ---------- Santé et outils ----------

function Health() {
  const store = useStore();
  const lib = store.library!;
  const index = store.index!;
  const health = useMemo(() => playlistHealth(lib), [lib]);
  const overlaps = useMemo(() => playlistOverlaps(lib), [lib]);
  const nameOf = (id: string) => lib.playlists.find((p) => p.id === id)?.name ?? id;
  const [mergeSel, setMergeSel] = useState<string[]>([]);
  const [splitId, setSplitId] = useState('');
  const [splitBy_, setSplitBy] = useState<'family' | 'decade' | 'mood'>('family');
  const [sortId, setSortId] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('harmonic');

  const tracksOf = (id: string) => (lib.playlistItems?.[id] ?? []).map((t) => index.byId.get(t)).filter((t): t is EnrichedTrack => !!t);
  const groups = useMemo(() => {
    if (!splitId) return [];
    const key = (t: EnrichedTrack) =>
      splitBy_ === 'family' ? t.families[0] && (FAMILY_BY_ID[t.families[0]]?.label ?? t.families[0]) : splitBy_ === 'decade' ? t.year && `Années ${String(Math.floor(t.year / 10) * 10).slice(-2)}` : t.moods[0] && MOOD_BY_ID[t.moods[0]].label;
    return splitBy(dedupeTracks(tracksOf(splitId)), (t) => key(t) || undefined);
  }, [splitId, splitBy_, lib, index]);

  const withDupes = health.filter((h) => h.duplicates > 0);

  return (
    <div className="grid wide-first">
      <section className="panel">
        <header>
          <h3>Doublons dans une même playlist</h3>
        </header>
        {withDupes.length === 0 ? (
          <p className="muted small">Aucune playlist ne contient deux fois le même titre. 👌</p>
        ) : (
          <ul className="rows">
            {withDupes.map((h) => (
              <TrackRow key={h.id} image={null} title={h.name} subtitle={`${h.size} titres dont ${h.duplicates} en double`} href={playlistUrl(h.id)}>
                <AsyncButton onClick={() => store.rewritePlaylist(h.id, dedupeIds(lib.playlistItems![h.id]), `« ${h.name} » dédoublonnée`)}>Dédoublonner</AsyncButton>
              </TrackRow>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <header>
          <h3>Playlists qui se recouvrent</h3>
          <span className="muted small">la plus petite est contenue à ≥ 50 % dans l’autre</span>
        </header>
        {overlaps.length === 0 ? (
          <p className="muted small">Aucun recouvrement important.</p>
        ) : (
          <ul className="rows">
            {overlaps.slice(0, 15).map((o) => (
              <TrackRow key={o.a + o.b} image={null} title={`${nameOf(o.a)}  ⟷  ${nameOf(o.b)}`} subtitle={`${o.shared} titres en commun · ${Math.round(o.containment * 100)} % de « ${nameOf(o.a)} »`}>
                <AsyncButton
                  onClick={async () => {
                    const name = `${nameOf(o.b)} + ${nameOf(o.a)}`;
                    await store.createSimplePlaylist(name, 'Fusion de deux playlists — Sillon', mergePlaylists(lib, [o.b, o.a]).map((id) => `spotify:track:${id}`));
                    store.say(`« ${name} » créée. Les originales ne sont pas modifiées.`);
                  }}
                >
                  Fusionner
                </AsyncButton>
              </TrackRow>
            ))}
          </ul>
        )}
      </section>

      <section className="panel tool">
        <header>
          <h3>Fusionner des playlists</h3>
        </header>
        <div className="chips">
          {lib.playlists
            .filter((p) => p.synced)
            .map((p) => (
              <button key={p.id} className={mergeSel.includes(p.id) ? 'chip on' : 'chip'} onClick={() => setMergeSel(mergeSel.includes(p.id) ? mergeSel.filter((x) => x !== p.id) : [...mergeSel, p.id])}>
                {p.name}
              </button>
            ))}
        </div>
        <AsyncButton
          className="primary small"
          disabled={mergeSel.length < 2}
          onClick={async () => {
            const ids = mergePlaylists(lib, mergeSel);
            const name = mergeSel.map(nameOf).join(' + ').slice(0, 90);
            await store.createSimplePlaylist(name, 'Fusion sans doublons — Sillon', ids.map((id) => `spotify:track:${id}`));
            store.say(`« ${name} » créée (${ids.length} titres, sans doublons).`);
            setMergeSel([]);
          }}
        >
          Créer la fusion ({mergePlaylists(lib, mergeSel).length} titres)
        </AsyncButton>
      </section>

      <section className="panel tool">
        <header>
          <h3>Découper une playlist</h3>
        </header>
        <div className="row wrap">
          <PlaylistPicker value={splitId} onChange={setSplitId} />
          <select value={splitBy_} onChange={(e) => setSplitBy(e.target.value as typeof splitBy_)}>
            <option value="family">par genre</option>
            <option value="decade">par décennie</option>
            <option value="mood">par mood</option>
          </select>
        </div>
        {groups.length > 0 && (
          <>
            <p className="small muted">{groups.map((g) => `${g.key} (${g.tracks.length})`).join(' · ')}</p>
            <AsyncButton
              className="primary small"
              onClick={async () => {
                for (const g of groups) {
                  await store.createSimplePlaylist(`${nameOf(splitId)} · ${g.key}`, 'Découpée par Sillon', g.tracks.map((t) => t.track.uri));
                }
                store.say(`${groups.length} playlists créées. L’originale n’est pas modifiée.`);
              }}
            >
              Créer {groups.length} playlists
            </AsyncButton>
          </>
        )}
      </section>

      <section className="panel tool">
        <header>
          <h3>Réordonner une playlist</h3>
          <span className="muted small">modifie la playlist sur place, après sauvegarde</span>
        </header>
        <div className="row wrap">
          <PlaylistPicker value={sortId} onChange={setSortId} />
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
            {Object.entries(SORT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <AsyncButton
            className="primary small"
            disabled={!sortId}
            onClick={() => store.rewritePlaylist(sortId, sortTracks(dedupeTracks(tracksOf(sortId)), sortMode, Date.now()).map((t) => t.track.id), `« ${nameOf(sortId)} » réordonnée`)}
          >
            Réordonner
          </AsyncButton>
        </div>
      </section>
    </div>
  );
}

function dedupeTracks(list: EnrichedTrack[]): EnrichedTrack[] {
  const seen = new Set<string>();
  return list.filter((t) => !seen.has(t.track.id) && seen.add(t.track.id));
}

// ---------- Artistes à suivre ----------

function Follow({ rows }: { rows: { id: string; name: string; count: number }[] }) {
  const store = useStore();
  if (!rows.length) return <div className="empty"><p className="muted">Tu suis déjà tous les artistes très présents dans ta bibliothèque.</p></div>;
  return (
    <section className="panel">
      <header>
        <h3>{rows.length} artistes très présents chez toi que tu ne suis pas</h3>
        <AsyncButton className="primary small" onClick={() => store.followArtists(rows.map((r) => r.id)).then(() => store.say(`Tu suis maintenant ${rows.length} artistes.`))}>
          Tout suivre
        </AsyncButton>
      </header>
      <p className="muted small">Suivre un artiste nourrit ton radar de sorties et les recommandations de Spotify.</p>
      <ul className="rows">
        {rows.map((r) => (
          <TrackRow key={r.id} image={null} title={r.name} subtitle={`${r.count} titres dans ta bibliothèque`} href={artistUrl(r.id)}>
            <AsyncButton onClick={() => store.followArtists([r.id])}>Suivre</AsyncButton>
          </TrackRow>
        ))}
      </ul>
    </section>
  );
}

// ---------- Sauvegardes ----------

function Backups() {
  const store = useStore();
  const lib = store.library!;
  const [selected, setSelected] = useState(store.backups[0]?.id ?? '');
  const backup = store.backups.find((b) => b.id === selected);
  const livingIds = useMemo(() => new Set(store.saved.map((s) => s.spotifyId)), [store.saved]);
  const diffs = useMemo(() => (backup ? diffWithBackup(lib, backup, livingIds) : []), [lib, backup, livingIds]);
  const trackLabel = (id: string) => {
    const t = lib.tracks[id];
    return t ? `${t.name} — ${t.artists[0]?.name}` : id;
  };

  const exportBackup = () => {
    if (!backup) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `sillon-sauvegarde-${backup.createdAt.slice(0, 10)}.json` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel">
      <header>
        <h3>Sauvegardes de tes playlists</h3>
        <AsyncButton className="primary small" onClick={store.createBackup}>
          Sauvegarder maintenant
        </AsyncButton>
      </header>
      <p className="muted small">
        Une sauvegarde est prise à chaque synchro (si quelque chose a changé) et avant chaque modification faite par Sillon.
        Les {store.backups.length} dernières sont gardées localement.
      </p>
      {store.backups.length === 0 ? (
        <p className="muted">Aucune sauvegarde pour l’instant.</p>
      ) : (
        <>
          <div className="row wrap">
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {store.backups.map((b) => (
                <option key={b.id} value={b.id}>
                  {new Date(b.createdAt).toLocaleString('fr-FR')} · {b.label ?? `${b.playlists.length} playlists`}
                </option>
              ))}
            </select>
            <button className="ghost small" onClick={exportBackup}>
              Exporter (JSON)
            </button>
          </div>
          <h4 className="diff-title">Changements depuis cette sauvegarde</h4>
          {diffs.length === 0 ? (
            <p className="muted small">Aucun changement : tes playlists sont identiques à cette sauvegarde (d’après la dernière synchro).</p>
          ) : (
            <ul className="diffs">
              {diffs.map((d) => (
                <li key={d.id} className="diff">
                  <div className="diff-head">
                    <strong>{d.name}</strong>
                    <span className="muted small">
                      {d.unsynced ? 'playlist vivante (contenu actuel non comparé)' : d.deleted ? `supprimée (${d.removed.length} titres)` : `+${d.added.length} / −${d.removed.length}`}
                    </span>
                    <span className="spacer" />
                    <AsyncButton onClick={() => store.restoreFromBackup(selected, d.id)}>{d.deleted ? 'Recréer' : 'Restaurer cette version'}</AsyncButton>
                  </div>
                  {!d.deleted && !d.unsynced && (
                    <details>
                      <summary className="small">Voir le détail</summary>
                      <ul className="small">
                        {d.added.map((id) => (
                          <li key={`a${id}`} className="added">+ {trackLabel(id)}</li>
                        ))}
                        {d.removed.map((id) => (
                          <li key={`r${id}`} className="removed">− {trackLabel(id)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
