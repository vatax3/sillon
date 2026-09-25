import { useMemo, useState } from 'react';
import type { EnrichedTrack } from '../lib/indexer';
import { MOOD_BY_ID } from '../lib/moods';
import { camelotLabel, toCamelot } from '../lib/ordering';
import { trackUrl } from '../lib/spotify';
import type { Bar } from '../lib/stats';
import type { Range } from '../lib/types';

// ---------- Barres horizontales (une seule série → une seule teinte, valeur au bout) ----------

export function BarChart({
  bars,
  format = (v) => v.toLocaleString('fr-FR'),
  max,
  onSelect,
  emptyText = 'Pas encore de données.',
}: {
  bars: Bar[];
  format?: (v: number) => string;
  max?: number;
  onSelect?: (b: Bar) => void;
  emptyText?: string;
}) {
  if (!bars.length) return <p className="muted small">{emptyText}</p>;
  const top = max ?? Math.max(...bars.map((b) => b.value));
  return (
    <ul className="bars">
      {bars.map((b) => {
        const content = (
          <>
            <span className="bar-label">{b.label}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${Math.max(1.5, (b.value / top) * 100)}%` }} />
              <span className="bar-value">{format(b.value)}</span>
            </span>
          </>
        );
        return (
          <li key={b.key} title={`${b.label} : ${format(b.value)}`}>
            {onSelect ? (
              <button className="bar-row clickable" onClick={() => onSelect(b)}>
                {content}
              </button>
            ) : (
              <div className="bar-row">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Colonnes verticales compactes pour les séries temporelles (valeurs au survol + table accessible). */
export function Columns({ bars, unit }: { bars: Bar[]; unit: string }) {
  if (!bars.length) return <p className="muted small">Pas encore de données.</p>;
  const top = Math.max(...bars.map((b) => b.value));
  return (
    <figure className="columns-fig">
      <div className="columns" role="img" aria-label={bars.map((b) => `${b.label} : ${b.value} ${unit}`).join(', ')}>
        {bars.map((b) => (
          <div className="col" key={b.key} title={`${b.label} : ${b.value.toLocaleString('fr-FR')} ${unit}`}>
            <span className="col-value">{b.value === top ? b.value.toLocaleString('fr-FR') : ''}</span>
            <span className="col-fill" style={{ height: `calc((100% - 16px) * ${Math.max(0.02, b.value / top)})` }} />
            <span className="col-label">{bars.length > 12 ? `’${b.label.slice(2)}` : b.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

// ---------- Sélection multiple avec recherche ----------

export interface Option {
  value: string;
  label: string;
  count?: number;
}

export function ChipSelect({
  options,
  selected,
  onChange,
  placeholder,
  maxSuggestions = 12,
  searchable = true,
}: {
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  maxSuggestions?: number;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const q = query.trim().toLowerCase();
  const suggestions = options
    .filter((o) => !selected.includes(o.value) && (!q || o.label.toLowerCase().includes(q)))
    .slice(0, searchable ? maxSuggestions : options.length);

  return (
    <div className="chipselect">
      {selected.length > 0 && (
        <div className="chips">
          {selected.map((v) => (
            <button key={v} className="chip on" onClick={() => toggle(v)} aria-label={`Retirer ${byValue.get(v)?.label ?? v}`}>
              {byValue.get(v)?.label ?? v} <span aria-hidden>✕</span>
            </button>
          ))}
        </div>
      )}
      {searchable && (
        <input className="chip-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} />
      )}
      <div className="chips">
        {suggestions.map((o) => (
          <button key={o.value} className="chip" onClick={() => toggle(o.value)}>
            {o.label}
            {o.count !== undefined && <span className="chip-count">{o.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Plage (deux curseurs) ----------

export function RangeField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format = (v) => `${Math.round(v * 100)}%`,
  hint,
}: {
  label: string;
  value?: Range;
  onChange: (r?: Range) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: string;
}) {
  const active = !!value;
  const [lo, hi] = value ?? [min, max];
  return (
    <div className={active ? 'range on' : 'range'}>
      <label className="range-head">
        <input type="checkbox" checked={active} onChange={(e) => onChange(e.target.checked ? [min, max] : undefined)} />
        <span>{label}</span>
        <span className="range-value">{active ? `${format(lo)} – ${format(hi)}` : 'peu importe'}</span>
      </label>
      {hint && <span className="muted small">{hint}</span>}
      {active && (
        <div className="range-sliders">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={lo}
            aria-label={`${label} minimum`}
            onChange={(e) => onChange([Math.min(Number(e.target.value), hi), hi])}
          />
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={hi}
            aria-label={`${label} maximum`}
            onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])}
          />
        </div>
      )}
    </div>
  );
}

// ---------- Liste de titres ----------

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const totalDuration = (tracks: EnrichedTrack[]) => {
  const min = Math.round(tracks.reduce((s, t) => s + t.track.durationMs, 0) / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`;
};

export function TrackList({
  tracks,
  onRemove,
  showDjInfo,
}: {
  tracks: EnrichedTrack[];
  onRemove?: (id: string) => void;
  showDjInfo?: boolean;
}) {
  return (
    <ol className="tracklist">
      {tracks.map((t, i) => {
        const f = t.features;
        return (
          <li key={t.track.id}>
            <span className="idx">{i + 1}</span>
            {t.track.album.image ? <img src={t.track.album.image} alt="" loading="lazy" /> : <span className="noimg" />}
            <span className="tl-main">
              <a href={trackUrl(t.track.id)} target="_blank" rel="noreferrer" className="tl-title">
                {t.track.name}
              </a>
              <span className="tl-sub">
                {t.track.artists.map((a) => a.name).join(', ')}
                {t.year ? ` · ${t.year}` : ''}
              </span>
            </span>
            <span className="tl-tags">
              {t.moods.slice(0, 2).map((m) => (
                <span key={m} className="tag" title={t.moodSource === 'tags' ? 'estimé via les tags' : 'd’après l’audio'}>
                  {MOOD_BY_ID[m].emoji} {MOOD_BY_ID[m].label}
                </span>
              ))}
              {t.genres[0] && <span className="tag subtle">{t.genres[0]}</span>}
            </span>
            {showDjInfo && (
              <span className="tl-dj" title="Tonalité Camelot · tempo · énergie">
                {f ? `${camelotLabel(toCamelot(f.key, f.mode))} · ${Math.round(f.tempo)} · ${Math.round(f.energy * 100)}%` : '—'}
              </span>
            )}
            <span className="tl-dur">{fmtDuration(t.track.durationMs)}</span>
            {onRemove && (
              <button className="ghost small icon" onClick={() => onRemove(t.track.id)} aria-label={`Retirer ${t.track.name}`}>
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
