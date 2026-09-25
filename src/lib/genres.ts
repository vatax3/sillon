// Les tags Last.fm / MusicBrainz sont bruités (« seen live », « british », « 90s »…).
// On les nettoie, puis on les regroupe en grandes familles lisibles.
import type { Mood } from './types';

export interface Family {
  id: string;
  label: string;
  keywords: string[];
}

// L'ordre compte : la première famille qui matche gagne (metal avant rock, etc.).
export const FAMILIES: Family[] = [
  { id: 'metal', label: 'Metal', keywords: ['metal', 'metalcore', 'deathcore', 'djent', 'grindcore', 'doom', 'sludge', 'thrash', 'black metal'] },
  { id: 'punk', label: 'Punk / Hardcore', keywords: ['punk', 'hardcore', 'emo', 'screamo', 'post-hardcore', 'oi'] },
  { id: 'hiphop', label: 'Hip-hop / Rap', keywords: ['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'drill', 'grime', 'boom bap', 'rap francais', 'rap français', 'cloud rap', 'phonk'] },
  { id: 'rnb', label: 'R&B / Soul / Funk', keywords: ['r&b', 'rnb', 'r b', 'soul', 'neo soul', 'neo-soul', 'funk', 'motown', 'gospel', 'disco', 'quiet storm', 'new jack swing'] },
  { id: 'ambient', label: 'Ambient / Chill', keywords: ['ambient', 'lo-fi', 'lofi', 'lo fi', 'chillhop', 'chillout', 'chill out', 'downtempo', 'new age', 'trip hop', 'trip-hop', 'drone', 'chillwave'] },
  { id: 'electronic', label: 'Électro', keywords: ['electronic', 'electronica', 'electro', 'house', 'techno', 'trance', 'edm', 'dubstep', 'drum and bass', 'drum n bass', 'dnb', 'jungle', 'uk garage', 'idm', 'synthwave', 'bass music', 'breakbeat', 'hardstyle', 'french touch', 'french house', 'dance', 'eurodance', 'big beat', 'future bass', 'electroclash', 'minimal'] },
  { id: 'jazz', label: 'Jazz', keywords: ['jazz', 'bebop', 'swing', 'big band', 'fusion', 'hard bop', 'cool jazz', 'nu jazz'] },
  { id: 'classical', label: 'Classique / BO', keywords: ['classical', 'classique', 'orchestral', 'baroque', 'opera', 'symphony', 'romantic era', 'neoclassical', 'modern classical', 'contemporary classical', 'soundtrack', 'score', 'film score', 'video game music', 'piano', 'minimalism', 'chamber music'] },
  { id: 'blues', label: 'Blues', keywords: ['blues', 'delta blues', 'blues rock'] },
  { id: 'country', label: 'Country', keywords: ['country', 'bluegrass', 'honky tonk', 'outlaw country'] },
  { id: 'reggae', label: 'Reggae / Dub', keywords: ['reggae', 'dub', 'dancehall', 'ska', 'rocksteady', 'roots reggae'] },
  { id: 'latin', label: 'Latino', keywords: ['latin', 'latino', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'bossa nova', 'samba', 'mpb', 'flamenco', 'tango', 'urbano latino', 'dembow'] },
  { id: 'world', label: 'Afro / Monde', keywords: ['afrobeat', 'afrobeats', 'afro', 'amapiano', 'world', 'raï', 'rai', 'highlife', 'soukous', 'zouk', 'kompa', 'coupé-décalé', 'african', 'celtic', 'balkan'] },
  { id: 'chanson', label: 'Chanson / Variété FR', keywords: ['chanson', 'chanson francaise', 'chanson française', 'variete francaise', 'variété française', 'french pop', 'nouvelle chanson', 'pop urbaine'] },
  { id: 'folk', label: 'Folk / Acoustique', keywords: ['folk', 'singer-songwriter', 'singer songwriter', 'acoustic', 'americana', 'indie folk', 'folk rock', 'freak folk'] },
  { id: 'indie', label: 'Indie / Alternative', keywords: ['indie', 'shoegaze', 'dream pop', 'bedroom pop', 'post-rock', 'post rock', 'math rock', 'slowcore', 'alternative', 'alt-rock', 'noise pop', 'art pop'] },
  { id: 'rock', label: 'Rock', keywords: ['rock', 'grunge', 'britpop', 'garage', 'psychedelic', 'progressive', 'prog', 'hard rock', 'classic rock', 'post-punk', 'new wave', 'rockabilly', 'stoner'] },
  { id: 'pop', label: 'Pop', keywords: ['pop', 'k-pop', 'kpop', 'j-pop', 'jpop', 'synthpop', 'synth-pop', 'dance pop', 'electropop', 'teen pop', 'hyperpop', 'europop'] },
];

export const FAMILY_BY_ID = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));

// Tags qui décrivent une ambiance plutôt qu'un genre → servent d'indices de mood.
export const MOOD_TAGS: Record<string, Mood> = {
  chill: 'chill', chillout: 'chill', relax: 'chill', relaxing: 'chill', mellow: 'chill', calm: 'chill', smooth: 'chill', dreamy: 'chill',
  sad: 'melancholy', melancholic: 'melancholy', melancholy: 'melancholy', depressing: 'melancholy', heartbreak: 'melancholy', emotional: 'melancholy', 'sad songs': 'melancholy',
  happy: 'feelgood', upbeat: 'feelgood', 'feel good': 'feelgood', fun: 'feelgood', uplifting: 'feelgood', summer: 'feelgood', sunny: 'feelgood',
  party: 'party', dance: 'party', danceable: 'party', club: 'party', groovy: 'party',
  energetic: 'energy', workout: 'energy', 'gym': 'energy', running: 'energy', 'high energy': 'energy',
  aggressive: 'intense', angry: 'intense', dark: 'intense', heavy: 'intense', brutal: 'intense',
  focus: 'focus', study: 'focus', instrumental: 'focus', 'background music': 'focus', concentration: 'focus',
  acoustic: 'acoustic', unplugged: 'acoustic', 'soft': 'acoustic', romantic: 'acoustic', love: 'acoustic',
};

const NOISE = [
  /^seen live$/, /favou?rites?/, /^my /, /^all$/, /^spotify/, /^under \d+/, /^\d+ ?(k|m)?$/,
  /vocalists?$/, /^(male|female)/, /^(british|american|english|french|german|swedish|canadian|australian|irish|norwegian|japanese|korean|belgian|spanish|italian|brazilian|usa|uk|us|france|paris|london|new york|los angeles)$/,
  /^(19|20)?\d0s$/, /^\d{4}$/, /^(beautiful|awesome|amazing|love at first listen|good|great|best|cool|epic|genius|masterpiece)$/,
  /albums? i own/, /check out/, /^to listen/, /^(band|artist|singer|group|musician|producer|dj|duo)s?$/,
];

export function cleanTag(raw: string): string | null {
  const t = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > 40) return null;
  if (NOISE.some((re) => re.test(t))) return null;
  return t;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const familyMatchers = FAMILIES.map((f) => ({
  id: f.id,
  re: new RegExp(`(^|[^a-z0-9&])(${f.keywords.map(escapeRe).join('|')})($|[^a-z0-9&])`),
}));

const familyCache = new Map<string, string | null>();
export function familyOfTag(tag: string): string | null {
  let hit = familyCache.get(tag);
  if (hit === undefined) {
    hit = familyMatchers.find((m) => m.re.test(tag))?.id ?? null;
    familyCache.set(tag, hit);
  }
  return hit;
}

export interface ArtistProfile {
  genres: string[];
  families: string[];
  moodHints: Mood[];
}

/**
 * Tags bruts → genres propres + familles (pondérées par l'ordre des tags, qui reflète leur poids)
 * + indices d'ambiance.
 */
export function profileFromTags(rawTags: string[]): ArtistProfile {
  const genres: string[] = [];
  const moodHints = new Set<Mood>();
  const familyScore = new Map<string, number>();
  rawTags.forEach((raw, i) => {
    const tag = cleanTag(raw);
    if (!tag) return;
    const mood = MOOD_TAGS[tag];
    if (mood) {
      moodHints.add(mood);
      // « dance » ou « acoustic » sont aussi des genres ; les autres ne sont que des ambiances.
      if (!familyOfTag(tag)) return;
    }
    genres.push(tag);
    const fam = familyOfTag(tag);
    if (fam) familyScore.set(fam, (familyScore.get(fam) ?? 0) + 1 / (1 + i * 0.5));
  });
  const ranked = [...familyScore.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const families = ranked.filter(([, s]) => s >= top * 0.5).slice(0, 3).map(([f]) => f);
  return { genres: genres.slice(0, 8), families, moodHints: [...moodHints] };
}
