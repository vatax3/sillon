import { useMemo, useState } from 'react';
import { FAMILY_BY_ID } from '../lib/genres';
import { defaultRule } from '../lib/generator';
import { MOODS } from '../lib/moods';
import type { Rule, SortMode, Source } from '../lib/types';
import { useStore } from '../store';
import PlaylistPreview from './PlaylistPreview';
import { ChipSelect, RangeField, SortOptions, type Option } from './ui';

const PRESETS: { label: string; rule: Partial<Rule> }[] = [
  { label: '🏃 Running', rule: { energy: [0.7, 1], tempo: [140, 190], sort: 'harmonic', maxTracks: 60 } },
  { label: '🎉 Soirée', rule: { moods: ['party'], sort: 'energy_arc', maxTracks: 80 } },
  { label: '🧠 Deep focus', rule: { moods: ['focus'], sort: 'shuffle', maxPerArtist: 4 } },
  { label: '🍷 Dîner', rule: { acousticness: [0.3, 1], energy: [0, 0.55], explicit: 'exclude', sort: 'shuffle' } },
  { label: '🌅 Réveil en douceur', rule: { valence: [0.4, 1], energy: [0.15, 0.7], sort: 'energy_asc', maxTracks: 30 } },
  { label: '🚗 Road trip', rule: { valence: [0.5, 1], energy: [0.5, 0.95], sort: 'affinity', maxTracks: 100 } },
  { label: '😴 Pour s’endormir', rule: { energy: [0, 0.35], explicit: 'exclude', sort: 'shuffle', maxTracks: 40 } },
  { label: '💎 Pépites oubliées', rule: { sources: ['liked'], addedBeforeDays: 365, excludeHeavyRotation: true } },
];

// Presets qui s'appuient sur l'historique importé.
const HISTORY_PRESETS: { label: string; rule: Partial<Rule> }[] = [
  { label: '🕰️ Favoris perdus de vue', rule: { minPlays: 10, notPlayedForDays: 180, sort: 'affinity', maxTracks: 50 } },
  { label: '🔁 En boucle en ce moment', rule: { minPlays: 3, playedWithinDays: 30, sort: 'affinity', maxTracks: 40 } },
  { label: '🌱 Découvertes de l’année', rule: { discoveredWithinDays: 365, minPlays: 5, sort: 'affinity', maxTracks: 60 } },
  { label: '🚫 Sans les titres que je skippe', rule: { maxSkipRate: 0.3, minPlays: 3, sort: 'shuffle', maxTracks: 60 } },
];

const LAST_PLAYED = [
  { value: '', label: 'Peu importe' },
  { value: 'w30', label: 'Écoutés ces 30 derniers jours' },
  { value: 'w90', label: 'Écoutés ces 3 derniers mois' },
  { value: 'n180', label: 'Pas écoutés depuis 6 mois' },
  { value: 'n365', label: 'Pas écoutés depuis 1 an' },
];

const lastPlayedValue = (r: Rule) => (r.playedWithinDays ? `w${r.playedWithinDays}` : r.notPlayedForDays ? `n${r.notPlayedForDays}` : '');

const SOURCES: { id: Source; label: string }[] = [
  { id: 'liked', label: 'Titres likés' },
  { id: 'playlists', label: 'Mes playlists' },
  { id: 'top', label: 'Mes tops' },
  { id: 'recent', label: 'Écoutés récemment' },
];

const ADDED_OPTIONS = [
  { value: '', label: 'Peu importe' },
  { value: 'w30', label: 'Likés ces 30 derniers jours' },
  { value: 'w90', label: 'Likés ces 3 derniers mois' },
  { value: 'w365', label: 'Likés cette année' },
  { value: 'b365', label: 'Likés il y a plus d’un an' },
  { value: 'b1095', label: 'Likés il y a plus de 3 ans' },
];

const addedValue = (r: Rule) =>
  r.addedWithinDays ? `w${r.addedWithinDays}` : r.addedBeforeDays ? `b${r.addedBeforeDays}` : '';

function countOptions(counts: Map<string, number>, label: (k: string) => string): Option[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: label(value), count }));
}

export default function Builder({ initialRule }: { initialRule: Rule | null }) {
  const store = useStore();
  const index = store.index!;
  const [rule, setRule] = useState<Rule>(initialRule ?? defaultRule());
  const [presetName, setPresetName] = useState<string | undefined>();
  const set = (patch: Partial<Rule>) => {
    setRule((r) => ({ ...r, ...patch }));
    // Modifier les critères d'un preset (hors nouveau tirage) invalide son nom.
    if (!('seed' in patch && Object.keys(patch).length === 1)) setPresetName(undefined);
  };

  const options = useMemo(() => {
    const fam = new Map<string, number>();
    const gen = new Map<string, number>();
    const moods = new Map<string, number>();
    for (const t of index.tracks) {
      t.families.forEach((f) => fam.set(f, (fam.get(f) ?? 0) + 1));
      t.genres.forEach((g) => gen.set(g, (gen.get(g) ?? 0) + 1));
      t.moods.forEach((m) => moods.set(m, (moods.get(m) ?? 0) + 1));
    }
    const years = index.tracks.map((t) => t.year).filter((y): y is number => !!y);
    return {
      families: countOptions(fam, (k) => FAMILY_BY_ID[k]?.label ?? k),
      genres: countOptions(gen, (k) => k),
      moods: MOODS.map((m) => ({ value: m.id, label: `${m.emoji} ${m.label}`, count: moods.get(m.id) ?? 0 })),
      artists: countOptions(index.artistCounts, store.artistName),
      yearMin: years.length ? Math.min(...years) : 1950,
      yearMax: years.length ? Math.max(...years) : new Date().getFullYear(),
    };
  }, [index, store.artistName]);

  const coverageWarning = index.coverage.features < 0.3;

  return (
    <div className="builder">
      <aside className="rules">
        <div className="presets">
          {[...PRESETS, ...(index.hasHistory ? HISTORY_PRESETS : [])].map((p) => (
            <button key={p.label} className="chip" onClick={() => {
                setRule({ ...defaultRule(), ...p.rule });
                setPresetName(p.label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Section title="Mise en forme">
          <label className="field">
            <span>Ordre</span>
            <select value={rule.sort} onChange={(e) => set({ sort: e.target.value as SortMode })}>
              <SortOptions exclude={index.hasHistory || rule.sort === 'plays_desc' ? [] : ['plays_desc']} />
            </select>
          </label>
          <div className="row">
            <label className="field">
              <span>Nombre de titres</span>
              <input type="number" min={5} max={500} value={rule.maxTracks} onChange={(e) => set({ maxTracks: Math.max(1, Number(e.target.value) || 50) })} />
            </label>
            <label className="field">
              <span>Max par artiste</span>
              <input type="number" min={0} max={50} value={rule.maxPerArtist || ''} placeholder="illimité" onChange={(e) => set({ maxPerArtist: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
          </div>
        </Section>

        <Section title="Genres">
          <ChipSelect
            options={options.families}
            selected={rule.families}
            onChange={(families) => set({ families })}
            searchable={false}
          />
          <details>
            <summary className="small">Genres précis ({options.genres.length})</summary>
            <ChipSelect options={options.genres} selected={rule.genres} onChange={(genres) => set({ genres })} placeholder="Chercher un genre (shoegaze, french house…)" />
          </details>
        </Section>

        <Section title="Moods">
          {coverageWarning && <p className="warn small">Peu d’audio-features chargées : les moods sont estimés via les tags. Lance l’enrichissement pour de meilleurs résultats.</p>}
          <ChipSelect
            options={options.moods}
            selected={rule.moods}
            onChange={(m) => set({ moods: m as Rule['moods'] })}
            searchable={false}
          />
        </Section>

        <Section title="Artistes">
          <ChipSelect options={options.artists} selected={rule.artistsInclude} onChange={(artistsInclude) => set({ artistsInclude })} placeholder="Uniquement ces artistes…" maxSuggestions={8} />
          <details>
            <summary className="small">Exclure des artistes {rule.artistsExclude.length ? `(${rule.artistsExclude.length})` : ''}</summary>
            <ChipSelect options={options.artists} selected={rule.artistsExclude} onChange={(artistsExclude) => set({ artistsExclude })} placeholder="Artiste à exclure…" maxSuggestions={8} />
          </details>
        </Section>

        <Section title="Époque & historique">
          <RangeField
            label="Année de sortie"
            min={options.yearMin}
            max={options.yearMax}
            step={1}
            format={String}
            value={rule.yearMin || rule.yearMax ? [rule.yearMin ?? options.yearMin, rule.yearMax ?? options.yearMax] : undefined}
            onChange={(r) => set({ yearMin: r?.[0], yearMax: r?.[1] })}
          />
          <label className="field">
            <span>Date d’ajout</span>
            <select
              value={addedValue(rule)}
              onChange={(e) => {
                const v = e.target.value;
                set({
                  addedWithinDays: v.startsWith('w') ? Number(v.slice(1)) : undefined,
                  addedBeforeDays: v.startsWith('b') ? Number(v.slice(1)) : undefined,
                });
              }}
            >
              {ADDED_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rule.excludeHeavyRotation} onChange={(e) => set({ excludeHeavyRotation: e.target.checked })} />
            Exclure ce que j’écoute déjà en boucle (tops, écoutes récentes)
          </label>
          <div className="checks">
            <span className="muted small">Puiser dans :</span>
            {SOURCES.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={rule.sources.length === 0 || rule.sources.includes(s.id)}
                  onChange={(e) => {
                    const all = SOURCES.map((x) => x.id);
                    const current = rule.sources.length ? rule.sources : all;
                    const next = e.target.checked ? [...current, s.id] : current.filter((x) => x !== s.id);
                    set({ sources: next.length === all.length ? [] : next });
                  }}
                />
                {s.label}
              </label>
            ))}
          </div>
        </Section>

        <Section title="Historique d’écoute">
          {!index.hasHistory ? (
            <p className="muted small">Importe ton historique (onglet Écoutes) pour filtrer selon ce que tu écoutes vraiment : titres les plus écoutés, pas écoutés depuis longtemps, souvent skippés…</p>
          ) : (
            <>
              <label className="field">
                <span>Écouté au moins</span>
                <select value={rule.minPlays ?? 0} onChange={(e) => set({ minPlays: Number(e.target.value) || undefined })}>
                  <option value={0}>peu importe</option>
                  {[1, 3, 5, 10, 20, 50].map((n) => (
                    <option key={n} value={n}>
                      {n} fois
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Dernière écoute</span>
                <select
                  value={lastPlayedValue(rule)}
                  onChange={(e) => {
                    const v = e.target.value;
                    set({ playedWithinDays: v.startsWith('w') ? Number(v.slice(1)) : undefined, notPlayedForDays: v.startsWith('n') ? Number(v.slice(1)) : undefined });
                  }}
                >
                  {LAST_PLAYED.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row">
                <label className="field">
                  <span>Skippés au plus</span>
                  <select value={rule.maxSkipRate ?? ''} onChange={(e) => set({ maxSkipRate: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">peu importe</option>
                    <option value={0.1}>10 % du temps</option>
                    <option value={0.3}>30 % du temps</option>
                    <option value={0.5}>50 % du temps</option>
                  </select>
                </label>
                <label className="field">
                  <span>Découverts</span>
                  <select value={rule.discoveredWithinDays ?? 0} onChange={(e) => set({ discoveredWithinDays: Number(e.target.value) || undefined })}>
                    <option value={0}>peu importe</option>
                    <option value={30}>ce mois-ci</option>
                    <option value={90}>ces 3 mois</option>
                    <option value={365}>cette année</option>
                  </select>
                </label>
              </div>
            </>
          )}
        </Section>

        <Section title="Son" collapsible>
          <RangeField label="Énergie" min={0} max={1} step={0.05} value={rule.energy} onChange={(energy) => set({ energy })} />
          <RangeField label="Positivité" min={0} max={1} step={0.05} value={rule.valence} onChange={(valence) => set({ valence })} hint="0 = triste/sombre, 100 = joyeux" />
          <RangeField label="Dansabilité" min={0} max={1} step={0.05} value={rule.danceability} onChange={(danceability) => set({ danceability })} />
          <RangeField label="Acoustique" min={0} max={1} step={0.05} value={rule.acousticness} onChange={(acousticness) => set({ acousticness })} />
          <RangeField label="Tempo" min={50} max={200} step={1} format={(v) => `${v} BPM`} value={rule.tempo} onChange={(tempo) => set({ tempo })} />
          <label className="field">
            <span>Contenu explicite</span>
            <select value={rule.explicit} onChange={(e) => set({ explicit: e.target.value as Rule['explicit'] })}>
              <option value="any">Peu importe</option>
              <option value="exclude">Exclure</option>
              <option value="only">Uniquement</option>
            </select>
          </label>
          <label className="field">
            <span>Durée max d’un titre (min)</span>
            <input type="number" min={1} max={30} value={rule.maxDurationMin ?? ''} placeholder="illimitée" onChange={(e) => set({ maxDurationMin: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
        </Section>

        <button
          className="ghost wide"
          onClick={() => {
            setRule(defaultRule());
            setPresetName(undefined);
          }}
        >
          Réinitialiser les critères
        </button>
      </aside>

      <PlaylistPreview rule={rule} defaultName={presetName} onReroll={() => set({ seed: Math.floor(Math.random() * 1e9) })} />
    </div>
  );
}

function Section({ title, children, collapsible }: { title: string; children: React.ReactNode; collapsible?: boolean }) {
  if (collapsible) {
    return (
      <details className="rule-section" open>
        <summary>
          <h4>{title}</h4>
        </summary>
        {children}
      </details>
    );
  }
  return (
    <div className="rule-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}
