import { useMemo, useState } from 'react';
import { describeRule, generate } from '../lib/generator';
import { buildSuggestions, KIND_LABELS, type Suggestion, type SuggestionKind } from '../lib/suggestions';
import type { Rule } from '../lib/types';
import { useStore } from '../store';
import PlaylistPreview from './PlaylistPreview';

const KIND_ORDER: SuggestionKind[] = ['ambiance', 'mood', 'rediscover', 'genre', 'era', 'artist'];

export default function Suggestions({ onCustomize }: { onCustomize: (r: Rule) => void }) {
  const store = useStore();
  const index = store.index!;
  const [seed, setSeed] = useState(42);
  const suggestions = useMemo(() => buildSuggestions(index, store.artistName, seed), [index, store.artistName, seed]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rerolls, setRerolls] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number; errors: string[] } | null>(null);

  const withSeed = (s: Suggestion): Rule => ({ ...s.rule, seed: s.rule.seed + (rerolls[s.id] ?? 0) });
  const open = suggestions.find((s) => s.id === openId);

  const createPicked = async () => {
    const list = suggestions.filter((s) => picked.has(s.id));
    const errors: string[] = [];
    setBatch({ done: 0, total: list.length, errors });
    for (const [i, s] of list.entries()) {
      try {
        const rule = withSeed(s);
        const { tracks } = generate(index, rule, s.trackIds ? new Set(s.trackIds) : undefined);
        const title = s.title.replace(/^\p{Extended_Pictographic}️?\s*/u, '');
        await store.createPlaylist({
          name: title,
          description: `${s.subtitle} — ${describeRule(rule, store.artistName).description}`.slice(0, 300),
          isPublic: store.settings.publicByDefault,
          tracks,
          rule,
          pool: s.trackIds,
        });
      } catch (e) {
        errors.push(`${s.title} : ${e instanceof Error ? e.message : e}`);
      }
      setBatch({ done: i + 1, total: list.length, errors });
    }
    setPicked(new Set());
  };

  if (!suggestions.length) {
    return (
      <div className="empty">
        <h2>Pas encore assez de matière</h2>
        <p className="muted">Lance l’enrichissement (genres & moods) depuis la barre du haut : les suggestions en dépendent.</p>
      </div>
    );
  }

  return (
    <div className="suggestions">
      <div className="toolbar">
        <p className="muted">
          {suggestions.length} playlists possibles à partir de ta bibliothèque. Clique pour prévisualiser, coche pour créer en lot.
        </p>
        <span className="spacer" />
        <button className="ghost" onClick={() => setSeed((s) => s + 1)} title="Relance la détection d’ambiances">
          🎲 Nouvelles ambiances
        </button>
        <button className="primary" disabled={!picked.size || (batch !== null && batch.done < batch.total)} onClick={createPicked}>
          Créer {picked.size || ''} playlist{picked.size > 1 ? 's' : ''}
        </button>
      </div>
      {batch && (
        <p className={batch.errors.length ? 'warn small' : 'success small'}>
          {batch.done < batch.total ? `Création ${batch.done}/${batch.total}…` : `${batch.total - batch.errors.length} playlist(s) créée(s).`}
          {batch.errors.map((e) => (
            <span key={e} className="block">
              {e}
            </span>
          ))}
        </p>
      )}

      {KIND_ORDER.map((kind) => {
        const list = suggestions.filter((s) => s.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} className="sugg-group">
            <h3>
              {KIND_LABELS[kind]}
              {kind === 'ambiance' && <span className="muted small"> — groupes de titres qui sonnent pareil, trouvés par clustering</span>}
            </h3>
            <div className="cards">
              {list.map((s) => (
                <div key={s.id} className={`card ${openId === s.id ? 'active' : ''}`}>
                  <label className="card-check" title="Sélectionner pour la création en lot">
                    <input
                      type="checkbox"
                      checked={picked.has(s.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(s.id);
                        else next.delete(s.id);
                        setPicked(next);
                      }}
                    />
                  </label>
                  <button className="card-body" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                    <strong>{s.title}</strong>
                    <span className="muted small">{s.subtitle}</span>
                    <span className="card-size">{s.size} titres dispo</span>
                  </button>
                </div>
              ))}
            </div>
            {open && open.kind === kind && (
              <div className="sugg-preview">
                <div className="toolbar">
                  <h3>{open.title}</h3>
                  <span className="spacer" />
                  {!open.trackIds && (
                    <button className="ghost" onClick={() => onCustomize(withSeed(open))}>
                      Personnaliser dans le Créateur →
                    </button>
                  )}
                </div>
                <PlaylistPreview
                  rule={withSeed(open)}
                  pool={open.trackIds}
                  defaultName={open.title.replace(/^\p{Extended_Pictographic}️?\s*/u, '')}
                  onReroll={() => setRerolls({ ...rerolls, [open.id]: (rerolls[open.id] ?? 0) + 1 })}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
