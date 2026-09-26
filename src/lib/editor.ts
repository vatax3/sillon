// Logique de l'éditeur de playlists, sans UI : déplacements, dédoublonnage, historique d'annulation,
// et traduction des retouches manuelles en titres épinglés / exclus pour les playlists vivantes.
import type { Rule } from './types';

export interface EditorItem {
  /** Clé unique de la ligne (un même titre peut apparaître deux fois). */
  key: string;
  uri: string;
  /** Id Spotify pour les titres ; absent pour les fichiers locaux. */
  id?: string;
  name: string;
  artists: string;
  image?: string;
  durationMs: number;
  kind: 'track' | 'episode' | 'local';
}

let seq = 0;
export const newKey = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Déplace l'élément d'index `from` pour qu'il se retrouve à l'index `to` (dans la liste finale). */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}

/** Déplace un ensemble de lignes en haut ou en bas, en gardant leur ordre relatif. */
export function moveKeys(items: EditorItem[], keys: Set<string>, where: 'top' | 'bottom'): EditorItem[] {
  const picked = items.filter((i) => keys.has(i.key));
  const rest = items.filter((i) => !keys.has(i.key));
  return where === 'top' ? [...picked, ...rest] : [...rest, ...picked];
}

/** Retire les doublons (même URI), en gardant la première occurrence. Les fichiers locaux sont conservés. */
export function dedupeItems(items: EditorItem[]): EditorItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (i.kind === 'local') return true;
    if (seen.has(i.uri)) return false;
    seen.add(i.uri);
    return true;
  });
}

export interface EditSummary {
  added: number;
  removed: number;
  reordered: boolean;
}

export function summarize(before: string[], after: string[]): EditSummary {
  const count = (list: string[]) => list.reduce((m, u) => m.set(u, (m.get(u) ?? 0) + 1), new Map<string, number>());
  const b = count(before);
  const a = count(after);
  let added = 0;
  let removed = 0;
  for (const [u, n] of a) added += Math.max(0, n - (b.get(u) ?? 0));
  for (const [u, n] of b) removed += Math.max(0, n - (a.get(u) ?? 0));
  // Réordonné si, une fois les ajouts/retraits ignorés, la séquence commune diffère.
  // On garde, pour chaque titre, autant d'occurrences qu'il en reste des deux côtés.
  const common = (list: string[]) => {
    const left = new Map([...a].map(([u, n]) => [u, Math.min(n, b.get(u) ?? 0)]));
    return list.filter((u) => {
      const n = left.get(u) ?? 0;
      if (n <= 0) return false;
      left.set(u, n - 1);
      return true;
    });
  };
  const reordered = common(before).join() !== common(after).join();
  return { added, removed, reordered };
}

/**
 * Pour une playlist vivante : un titre ajouté à la main devient épinglé (toujours inclus),
 * un titre retiré à la main devient exclu (plus jamais inclus).
 */
export function applyManualEdits(rule: Rule, beforeIds: string[], afterIds: string[]): Rule {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  const added = afterIds.filter((id) => !before.has(id));
  const removed = beforeIds.filter((id) => !after.has(id));
  const pinned = new Set(rule.pinned ?? []);
  const excluded = new Set(rule.excluded ?? []);
  for (const id of added) {
    pinned.add(id);
    excluded.delete(id);
  }
  for (const id of removed) {
    excluded.add(id);
    pinned.delete(id);
  }
  return { ...rule, pinned: [...pinned], excluded: [...excluded] };
}

/** Pile d'annulation bornée. */
export class UndoStack<T> {
  private past: T[] = [];
  constructor(private limit = 60) {}
  push(state: T) {
    this.past.push(state);
    if (this.past.length > this.limit) this.past.shift();
  }
  pop(): T | undefined {
    return this.past.pop();
  }
  get size() {
    return this.past.length;
  }
  clear() {
    this.past = [];
  }
}

/** Les descriptions renvoyées par l'API sont encodées en entités HTML (« l&#x27;été »). */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}
