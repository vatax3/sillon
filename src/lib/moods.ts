import type { AudioFeatures, Mood } from './types';

export const MOODS: { id: Mood; label: string; emoji: string; hint: string }[] = [
  { id: 'chill', label: 'Chill', emoji: '🌙', hint: 'calme, posé, peu d’énergie' },
  { id: 'energy', label: 'Énergie', emoji: '⚡', hint: 'rapide et puissant, idéal sport' },
  { id: 'party', label: 'Fête', emoji: '🪩', hint: 'dansant, énergique, positif' },
  { id: 'feelgood', label: 'Feel-good', emoji: '☀️', hint: 'joyeux, lumineux' },
  { id: 'melancholy', label: 'Mélancolie', emoji: '🌧️', hint: 'triste, introspectif' },
  { id: 'focus', label: 'Focus', emoji: '🎧', hint: 'instrumental, peu de voix' },
  { id: 'intense', label: 'Intense', emoji: '🔥', hint: 'sombre, agressif, très énergique' },
  { id: 'acoustic', label: 'Acoustique', emoji: '🪕', hint: 'doux, instruments acoustiques' },
];
export const MOOD_BY_ID = Object.fromEntries(MOODS.map((m) => [m.id, m])) as Record<
  Mood,
  (typeof MOODS)[number]
>;

/** Rampe linéaire 0→1 entre `from` et `to` (décroissante si from > to). */
export function ramp(x: number, from: number, to: number): number {
  const t = (x - from) / (to - from);
  return Math.max(0, Math.min(1, t));
}

/** Moyenne géométrique : un critère à 0 annule le mood, sans être aussi brutal qu'un min(). */
function gm(...xs: number[]): number {
  return Math.pow(
    xs.reduce((p, x) => p * Math.max(x, 1e-3), 1),
    1 / xs.length,
  );
}

export function moodScores(f: AudioFeatures): Record<Mood, number> {
  return {
    chill: gm(ramp(f.energy, 0.65, 0.3), ramp(f.speechiness, 0.35, 0.1), ramp(f.tempo, 135, 95) * 0.3 + 0.7),
    // Un titre très sombre relève plutôt d'« intense » : légère pénalité sur les valences basses.
    energy: gm(ramp(f.energy, 0.62, 0.85), ramp(f.tempo, 100, 128), 0.6 + 0.4 * ramp(f.valence, 0.05, 0.35)),
    party: gm(ramp(f.danceability, 0.55, 0.8), ramp(f.energy, 0.5, 0.75), ramp(f.valence, 0.3, 0.6)),
    feelgood: gm(ramp(f.valence, 0.5, 0.8), ramp(f.energy, 0.35, 0.6)),
    melancholy: gm(ramp(f.valence, 0.45, 0.18), ramp(f.energy, 0.72, 0.4)),
    focus: gm(ramp(f.instrumentalness, 0.3, 0.75), ramp(f.speechiness, 0.15, 0.05), ramp(f.energy, 0.85, 0.5)),
    intense: gm(ramp(f.energy, 0.75, 0.92), ramp(f.valence, 0.5, 0.2)),
    acoustic: gm(ramp(f.acousticness, 0.5, 0.85), ramp(f.energy, 0.65, 0.35)),
  };
}

export const MOOD_THRESHOLD = 0.6;

/** Moods retenus pour un titre, du plus marqué au moins marqué. */
export function moodsFromFeatures(f: AudioFeatures): Mood[] {
  const scores = moodScores(f);
  return (Object.entries(scores) as [Mood, number][])
    .filter(([, s]) => s >= MOOD_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
}
