import { useEffect, useMemo, useRef, useState } from 'react';
import { dedupeItems, decodeEntities, moveItem, moveKeys, newKey, summarize, UndoStack, type EditorItem } from '../lib/editor';
import type { EnrichedTrack } from '../lib/indexer';
import { isAbort } from '../lib/http';
import { mulberry32, shuffle, sortTracks } from '../lib/ordering';
import * as sp from '../lib/spotify';
import type { SortMode } from '../lib/types';
import { PlaylistConflictError, useStore } from '../store';
import { AsyncButton, SortOptions, totalDuration } from './ui';

interface Loaded {
  name: string;
  description: string;
  snapshotId: string;
  items: EditorItem[];
}

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const fromEntry = (e: sp.PlaylistEntry): EditorItem => ({ ...e, key: newKey() });
const fromRaw = (t: sp.RawTrack): EditorItem => ({
  key: newKey(),
  uri: t.uri,
  id: t.id ?? undefined,
  name: t.name,
  artists: t.artists.map((a) => a.name).join(', '),
  image: t.album.images?.[t.album.images.length - 1]?.url,
  durationMs: t.duration_ms,
  kind: 'track',
});
const fromEnriched = (t: EnrichedTrack): EditorItem => ({
  key: newKey(),
  uri: t.track.uri,
  id: t.track.id,
  name: t.track.name,
  artists: t.track.artists.map((a) => a.name).join(', '),
  image: t.track.album.image,
  durationMs: t.track.durationMs,
  kind: 'track',
});

/** Éditeur manuel d'une playlist : ordre (glisser-déposer), ajouts, retraits, nom, description. */
export default function PlaylistEditor({ playlistId, onClose }: { playlistId: string; onClose: () => void }) {
  const store = useStore();
  const living = store.saved.find((s) => s.spotifyId === playlistId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItemsState] = useState<EditorItem[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode | ''>('');
  const undo = useRef(new UndoStack<EditorItem[]>());
  const [, force] = useState(0);

  const load = async () => {
    setLoadError(null);
    setLoaded(null);
    try {
      const [meta, entries] = await Promise.all([sp.getPlaylistMeta(playlistId), sp.getPlaylistEntries(playlistId)]);
      const l: Loaded = {
        name: meta.name,
        description: decodeEntities(meta.description ?? ''),
        snapshotId: meta.snapshot_id,
        items: entries.map(fromEntry),
      };
      setLoaded(l);
      setItemsState(l.items);
      setName(l.name);
      setDescription(l.description);
      setSelected(new Set());
      undo.current.clear();
      setConflict(false);
    } catch (e) {
      if (!isAbort(e)) setLoadError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, [playlistId]);

  /** Toute modification passe par ici pour alimenter l'annulation. */
  const setItems = (next: EditorItem[]) => {
    undo.current.push(items);
    setItemsState(next);
    force((n) => n + 1);
  };
  const doUndo = () => {
    const prev = undo.current.pop();
    if (prev) {
      setItemsState(prev);
      force((n) => n + 1);
    }
  };

  // Ctrl/Cmd+Z pour annuler (hors champs de saisie).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        doUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const summary = useMemo(() => (loaded ? summarize(loaded.items.map((i) => i.uri), items.map((i) => i.uri)) : null), [loaded, items]);
  const itemsChanged = !!summary && (summary.added > 0 || summary.removed > 0 || summary.reordered);
  const detailsChanged = !!loaded && (name !== loaded.name || description !== loaded.description);
  const dirty = itemsChanged || detailsChanged;
  const hasLocal = items.some((i) => i.kind === 'local');
  const dupes = items.length - dedupeItems(items).length;

  const save = async (forceWrite = false) => {
    if (!loaded) return;
    setSaving(true);
    try {
      await store.savePlaylistEdit({
        id: playlistId,
        name: name.trim() || loaded.name,
        description: description.trim(),
        uris: items.map((i) => i.uri),
        before: { name: loaded.name, description: loaded.description, uris: loaded.items.map((i) => i.uri), snapshotId: loaded.snapshotId },
        force: forceWrite,
      });
      await load(); // repart de l'état réel côté Spotify (nouveau snapshot)
    } catch (e) {
      if (e instanceof PlaylistConflictError) setConflict(true);
      else store.report(e);
    } finally {
      setSaving(false);
    }
  };

  const removeKeys = (keys: Set<string>) => {
    setItems(items.filter((i) => !keys.has(i.key)));
    setSelected(new Set());
  };

  const applySort = (mode: SortMode) => {
    // Seuls les titres connus de la bibliothèque ont les infos nécessaires ; les autres restent à la fin.
    const known = items.filter((i) => i.id && store.index?.byId.has(i.id));
    const unknown = items.filter((i) => !(i.id && store.index?.byId.has(i.id)));
    // sortTracks travaille par titre : on trie la première occurrence, les doublons éventuels vont à la suite.
    const firstById = new Map<string, EditorItem>();
    for (const i of known) if (!firstById.has(i.id!)) firstById.set(i.id!, i);
    const sorted = sortTracks([...firstById.keys()].map((id) => store.index!.byId.get(id)!), mode, Date.now()).map((t) => firstById.get(t.track.id)!);
    const used = new Set(sorted.map((i) => i.key));
    const leftovers = known.filter((i) => !used.has(i.key));
    setItems([...sorted, ...leftovers, ...unknown]);
    setSortMode('');
  };

  const back = () => {
    if (dirty && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    onClose();
  };

  if (loadError) {
    return (
      <div className="empty">
        <h2>Impossible d’ouvrir cette playlist</h2>
        <p className="error-text">{loadError}</p>
        <div className="row">
          <button className="ghost" onClick={onClose}>
            ← Retour
          </button>
          <button className="primary" onClick={load}>
            Réessayer
          </button>
        </div>
      </div>
    );
  }
  if (!loaded) return <p className="muted">Chargement de la playlist…</p>;

  const selKeys = selected;
  const allSelected = items.length > 0 && items.every((i) => selKeys.has(i.key));

  return (
    <div className="editor">
      <div className="toolbar">
        <button className="ghost small" onClick={back}>
          ← Mes playlists
        </button>
        {confirmLeave && (
          <span className="warn small row">
            Modifications non enregistrées.
            <button className="danger small" onClick={onClose}>
              Quitter sans enregistrer
            </button>
            <button className="ghost small" onClick={() => setConfirmLeave(false)}>
              Rester
            </button>
          </span>
        )}
        <span className="spacer" />
        <a className="button ghost small" href={sp.playlistUrl(playlistId)} target="_blank" rel="noreferrer">
          Ouvrir dans Spotify ↗
        </a>
      </div>

      <section className="panel editor-head">
        <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-label="Nom de la playlist" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={2} placeholder="Description (optionnelle)" aria-label="Description" />
        {living && <LivingInfo id={playlistId} />}
      </section>

      <AddTracks existing={new Set(items.map((i) => i.uri))} onAdd={(it) => setItems([...items, it])} />

      <section className="panel">
        <div className="bulk">
          <label className="check">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.key)))} />
            {selKeys.size ? `${selKeys.size} sélectionné(s)` : `${items.length} titres · ${totalDurationOf(items)}`}
          </label>
          {selKeys.size > 0 ? (
            <>
              <button className="ghost small" onClick={() => removeKeys(selKeys)}>
                Retirer
              </button>
              <button className="ghost small" onClick={() => setItems(moveKeys(items, selKeys, 'top'))}>
                En haut
              </button>
              <button className="ghost small" onClick={() => setItems(moveKeys(items, selKeys, 'bottom'))}>
                En bas
              </button>
            </>
          ) : (
            <>
              <select value={sortMode} onChange={(e) => e.target.value && applySort(e.target.value as SortMode)} aria-label="Trier">
                <option value="">Trier…</option>
                <SortOptions exclude={['shuffle']} />
              </select>
              <button className="ghost small" onClick={() => setItems(shuffle(items, mulberry32(Date.now())))}>
                Mélanger
              </button>
              <button className="ghost small" onClick={() => setItems([...items].reverse())}>
                Inverser
              </button>
              {dupes > 0 && (
                <button className="ghost small" onClick={() => setItems(dedupeItems(items))}>
                  Retirer {dupes} doublon(s)
                </button>
              )}
            </>
          )}
          <span className="spacer" />
          <button className="ghost small" onClick={doUndo} disabled={undo.current.size === 0} title="Ctrl/⌘ + Z">
            ↶ Annuler
          </button>
        </div>

        <ol className="edit-list">
          {items.map((it, i) => (
            <li
              key={it.key}
              className={['edit-row', drag?.over === i && drag.from !== i ? (drag.from < i ? 'drop-after' : 'drop-before') : '', selKeys.has(it.key) ? 'selected' : ''].join(' ')}
              draggable
              tabIndex={0}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                setDrag({ from: i, over: i });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (drag && drag.over !== i) setDrag({ ...drag, over: i });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) setItems(moveItem(items, drag.from, i));
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.altKey && e.key === 'ArrowUp' && i > 0) {
                  e.preventDefault();
                  setItems(moveItem(items, i, i - 1));
                } else if (e.altKey && e.key === 'ArrowDown' && i < items.length - 1) {
                  e.preventDefault();
                  setItems(moveItem(items, i, i + 1));
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  removeKeys(new Set([it.key]));
                }
              }}
            >
              <span className="grip" aria-hidden>
                ⋮⋮
              </span>
              <input
                type="checkbox"
                checked={selKeys.has(it.key)}
                aria-label={`Sélectionner ${it.name}`}
                onChange={(e) => {
                  const next = new Set(selKeys);
                  if (e.target.checked) next.add(it.key);
                  else next.delete(it.key);
                  setSelected(next);
                }}
              />
              <button className="idx play" onClick={() => store.playUris(items.filter((x) => x.kind !== 'local').map((x) => x.uri), items.slice(0, i).filter((x) => x.kind !== 'local').length)} aria-label={`Lire à partir de ${it.name}`}>
                <span className="n">{i + 1}</span>
                <span className="p">▶</span>
              </button>
              {it.image ? <img src={it.image} alt="" loading="lazy" /> : <span className="noimg" />}
              <span className="tl-main">
                <span className="tl-title">{it.name}</span>
                <span className="tl-sub">
                  {it.artists}
                  {it.kind === 'local' && ' · fichier local'}
                  {it.kind === 'episode' && ' · épisode'}
                </span>
              </span>
              <span className="tl-dur">{fmt(it.durationMs)}</span>
              <span className="tr-actions">
                <button className="ghost small icon" disabled={i === 0} onClick={() => setItems(moveItem(items, i, i - 1))} aria-label="Monter">
                  ↑
                </button>
                <button className="ghost small icon" disabled={i === items.length - 1} onClick={() => setItems(moveItem(items, i, i + 1))} aria-label="Descendre">
                  ↓
                </button>
                <button className="ghost small icon" onClick={() => removeKeys(new Set([it.key]))} aria-label={`Retirer ${it.name}`}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
        {items.length === 0 && <p className="empty-inline">Playlist vide. Ajoute des titres avec la recherche ci-dessus.</p>}
        <p className="muted small">Glisse-dépose pour réordonner, ou Alt + ↑/↓ sur une ligne sélectionnée au clavier ; Suppr pour retirer.</p>
      </section>

      <div className="save-bar">
        <span className="small">
          {dirty ? (
            <>
              Modifications :{summary && summary.added > 0 && ` +${summary.added}`}
              {summary && summary.removed > 0 && ` −${summary.removed}`}
              {summary?.reordered && ' · ordre modifié'}
              {detailsChanged && ' · nom/description'}
            </>
          ) : (
            <span className="muted">Aucune modification</span>
          )}
        </span>
        {hasLocal && itemsChanged && <span className="warn small">Cette playlist contient des fichiers locaux, que l’API Spotify ne sait pas réécrire : ils seraient perdus. Modifie-la dans l’app Spotify.</span>}
        {conflict && (
          <span className="warn small row">
            Modifiée ailleurs depuis l’ouverture.
            <AsyncButton className="danger small" onClick={() => save(true)}>
              Écraser quand même
            </AsyncButton>
            <button className="ghost small" onClick={load}>
              Recharger
            </button>
          </span>
        )}
        <span className="spacer" />
        <button
          className="ghost small"
          disabled={!dirty}
          onClick={() => {
            setItems(loaded.items);
            setName(loaded.name);
            setDescription(loaded.description);
          }}
        >
          Tout annuler
        </button>
        <button className="primary" disabled={!dirty || saving || (hasLocal && itemsChanged)} onClick={() => save()}>
          {saving ? 'Enregistrement…' : 'Enregistrer sur Spotify'}
        </button>
      </div>
    </div>
  );
}

const totalDurationOf = (items: EditorItem[]) =>
  totalDuration(items.map((i) => ({ track: { durationMs: i.durationMs } }) as EnrichedTrack));

/** Recherche dans la bibliothèque (instantanée) puis sur Spotify. */
function AddTracks({ existing, onAdd }: { existing: Set<string>; onAdd: (it: EditorItem) => void }) {
  const { index, report } = useStore();
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<sp.RawTrack[] | null>(null);
  const [busy, setBusy] = useState(false);
  const query = q.trim().toLowerCase();

  const local = useMemo(() => {
    if (query.length < 2 || !index) return [];
    return index.tracks
      .filter((t) => t.track.name.toLowerCase().includes(query) || t.track.artists.some((a) => a.name.toLowerCase().includes(query)))
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, 8);
  }, [query, index]);

  useEffect(() => setRemote(null), [query]);

  const searchSpotify = async () => {
    setBusy(true);
    try {
      setRemote((await sp.searchTracks(q.trim(), 10)).filter((t) => t.id));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel add-tracks">
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && searchSpotify()} placeholder="Ajouter un titre : cherche dans ta bibliothèque, Entrée pour chercher sur Spotify" aria-label="Rechercher un titre à ajouter" />
        <button className="ghost" onClick={searchSpotify} disabled={!q.trim() || busy}>
          {busy ? '…' : 'Sur Spotify'}
        </button>
      </div>
      {(local.length > 0 || remote) && (
        <ul className="rows">
          {local.map((t) => (
            <AddRow key={`l${t.track.id}`} title={t.track.name} subtitle={`${t.track.artists.map((a) => a.name).join(', ')} · dans ta bibliothèque`} image={t.track.album.image} already={existing.has(t.track.uri)} onAdd={() => onAdd(fromEnriched(t))} />
          ))}
          {remote?.map((t) => (
            <AddRow key={`r${t.id}`} title={t.name} subtitle={`${t.artists.map((a) => a.name).join(', ')} · ${t.album.name}`} image={t.album.images?.[t.album.images.length - 1]?.url} already={existing.has(t.uri)} onAdd={() => onAdd(fromRaw(t))} />
          ))}
          {remote?.length === 0 && <li className="muted small">Aucun résultat sur Spotify.</li>}
        </ul>
      )}
    </section>
  );
}

function AddRow({ title, subtitle, image, already, onAdd }: { title: string; subtitle: string; image?: string; already: boolean; onAdd: () => void }) {
  return (
    <li className="trackrow">
      {image ? <img src={image} alt="" loading="lazy" /> : <span className="noimg" />}
      <span className="tl-main">
        <span className="tl-title">{title}</span>
        <span className="tl-sub">{subtitle}</span>
      </span>
      {already && <span className="tag subtle">déjà dedans</span>}
      <button className="ghost small" onClick={onAdd}>
        + Ajouter
      </button>
    </li>
  );
}

/** Rappel du fonctionnement des retouches sur une playlist vivante. */
function LivingInfo({ id }: { id: string }) {
  const store = useStore();
  const s = store.saved.find((x) => x.spotifyId === id)!;
  const pinned = s.rule.pinned?.length ?? 0;
  const excluded = s.rule.excluded?.length ?? 0;
  return (
    <p className="living-info small">
      <strong>Playlist vivante.</strong> Les titres que tu ajoutes seront <em>épinglés</em> (toujours gardés), ceux que tu retires seront{' '}
      <em>exclus</em> (jamais remis) lors des prochaines actualisations. L’ordre, lui, est recalculé à chaque actualisation.
      {(pinned > 0 || excluded > 0) && (
        <>
          {' '}
          Actuellement : {pinned} épinglé(s), {excluded} exclu(s).{' '}
          <button className="ghost small" onClick={() => store.updateSavedRule(id, { ...s.rule, pinned: [], excluded: [] })}>
            Oublier ces retouches
          </button>
        </>
      )}
    </p>
  );
}
