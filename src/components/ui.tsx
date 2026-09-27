import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { togglePreview, usePreview } from '../lib/preview';
import { useStore } from '../store';
import type { EnrichedTrack } from '../lib/indexer';
import { MOOD_BY_ID } from '../lib/moods';
import { camelotLabel, SORT_GROUPS, SORT_LABELS, toCamelot } from '../lib/ordering';
import { trackUrl } from '../lib/spotify';
import type { Bar } from '../lib/stats';
import type { Range, SortMode } from '../lib/types';

// ---------- Options d'ordre (à placer dans un <select>) ----------

export function SortOptions({ exclude = [] }: { exclude?: SortMode[] }) {
  return (
    <>
      {SORT_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.modes
            .filter((m) => !exclude.includes(m))
            .map((m) => (
              <option key={m} value={m}>
                {SORT_LABELS[m]}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

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
  const step = bars.length > 14 ? Math.ceil(bars.length / 12) : 1;
  const short = (label: string) => (bars.length > 12 && /^\d{4}$/.test(label) ? `’${label.slice(2)}` : label);
  return (
    <figure className="columns-fig">
      <div className="columns" role="img" aria-label={bars.map((b) => `${b.label} : ${b.value} ${unit}`).join(', ')}>
        {bars.map((b, i) => (
          <div className="col" key={b.key} title={`${b.label} : ${b.value.toLocaleString('fr-FR')} ${unit}`}>
            <span className="col-value">{b.value === top ? b.value.toLocaleString('fr-FR') : ''}</span>
            <span className="col-fill" style={{ height: `calc((100% - 16px) * ${Math.max(0.02, b.value / top)})` }} />
            <span className="col-label">{i % step === 0 ? short(b.label) : ''}</span>
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
  onPlay,
  showDjInfo,
}: {
  tracks: EnrichedTrack[];
  onRemove?: (id: string) => void;
  /** Lance la lecture de la liste à partir de ce titre. */
  onPlay?: (index: number) => void;
  showDjInfo?: boolean;
}) {
  return (
    <ol className="tracklist">
      {tracks.map((t, i) => {
        const f = t.features;
        return (
          <li key={t.track.id}>
            {onPlay ? (
              <button className="idx play" onClick={() => onPlay(i)} aria-label={`Lire à partir de ${t.track.name}`}>
                <span className="n">{i + 1}</span>
                <span className="p">▶</span>
              </button>
            ) : (
              <span className="idx">{i + 1}</span>
            )}
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

// ---------- Sous-onglets ----------

export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <nav className="subtabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'subtab active' : 'subtab'} onClick={() => onChange(t.id)}>
          {t.label}
          {!!t.badge && <span className="count">{t.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

// ---------- Ligne de titre générique (recos, historique, radar…) ----------

export function PreviewButton({ url }: { url?: string }) {
  const playing = usePreview();
  if (!url) return null;
  const on = playing === url;
  return (
    <button className={on ? 'ghost small icon on' : 'ghost small icon'} onClick={() => togglePreview(url)} aria-label={on ? 'Arrêter l’extrait' : 'Écouter un extrait de 30 s'} title="Extrait 30 s">
      {on ? '■' : '▶'}
    </button>
  );
}

export function TrackRow({
  image,
  title,
  subtitle,
  href,
  meta,
  children,
  selected,
  onSelect,
}: {
  /** null = ligne sans vignette (playlist, artiste). */
  image?: string | null;
  title: string;
  subtitle?: string;
  href?: string;
  meta?: ReactNode;
  children?: ReactNode;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
}) {
  return (
    <li className="trackrow">
      {onSelect && <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Sélectionner ${title}`} />}
      {image ? <img src={image} alt="" loading="lazy" /> : image === null ? null : <span className="noimg" />}
      <span className="tl-main">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="tl-title">
            {title}
          </a>
        ) : (
          <span className="tl-title">{title}</span>
        )}
        {subtitle && <span className="tl-sub">{subtitle}</span>}
      </span>
      {meta && <span className="tr-meta">{meta}</span>}
      {children && <span className="tr-actions">{children}</span>}
    </li>
  );
}

/** Sélection multiple réutilisable pour les listes avec actions groupées. */
export function useSelection(ids: string[]) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const all = ids.length > 0 && ids.every((id) => sel.has(id));
  return {
    selected: sel,
    has: (id: string) => sel.has(id),
    set: (id: string, v: boolean) => {
      const next = new Set(sel);
      if (v) next.add(id);
      else next.delete(id);
      setSel(next);
    },
    all,
    toggleAll: () => setSel(all ? new Set() : new Set(ids)),
    clear: () => setSel(new Set()),
  };
}

/** Bouton qui gère son propre état « en cours » et remonte les erreurs au store. */
export function AsyncButton({
  onClick,
  children,
  className = 'ghost small',
  disabled,
  title,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const { report } = useStore();
  return (
    <button
      className={className}
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (e) {
          report(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : children}
    </button>
  );
}

// ---------- Carte thermique heure × jour ----------

const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

export function Heatmap({ data }: { data: number[][] }) {
  const max = Math.max(...data.flat(), 1);
  return (
    <div className="heatmap-wrap">
      <div className="heatmap" role="table" aria-label="Minutes d'écoute par jour et par heure">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="hm-hour">
            {h % 3 === 0 ? `${h}h` : ''}
          </span>
        ))}
        {data.map((row, d) => (
          <Fragment key={d}>
            <span className="hm-day">{DAYS[d]}</span>
            {row.map((v, h) => (
              <span
                key={h}
                className="hm-cell"
                title={`${DAYS[d]} ${h}h–${h + 1}h : ${Math.round(v).toLocaleString('fr-FR')} min`}
                style={{ '--i': v / max } as React.CSSProperties}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="hm-legend small muted">
        moins <span className="hm-cell" style={{ '--i': 0.05 } as React.CSSProperties} />
        <span className="hm-cell" style={{ '--i': 0.35 } as React.CSSProperties} />
        <span className="hm-cell" style={{ '--i': 0.7 } as React.CSSProperties} />
        <span className="hm-cell" style={{ '--i': 1 } as React.CSSProperties} /> plus
      </div>
    </div>
  );
}

/** Sélecteur de playlist possédée (pour « ajouter à… »). */
export function PlaylistPicker({ value, onChange, placeholder = 'Choisir une playlist…' }: { value: string; onChange: (id: string) => void; placeholder?: string }) {
  const { library } = useStore();
  const owned = (library?.playlists ?? []).filter((p) => p.owned || p.collaborative);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Playlist">
      <option value="">{placeholder}</option>
      {owned.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.trackCount})
        </option>
      ))}
    </select>
  );
}
