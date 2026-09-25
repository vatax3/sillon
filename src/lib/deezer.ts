// L'API publique de Deezer est excellente pour les artistes similaires et fournit des extraits de 30 s,
// sans clé. Elle n'envoie pas d'en-tête CORS : on passe par son mode JSONP.
import { normalizeName } from './enrich';
import { sleep } from './http';

let counter = 0;
let lastCall = 0;
// Quota Deezer : 50 requêtes / 5 s. On reste nettement en dessous.
const MIN_INTERVAL = 150;

function jsonpOnce<T>(url: string, timeout = 12_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__sillon_dz_${Date.now()}_${counter++}`;
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const cleanup = () => {
      delete w[cb];
      script.remove();
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Deezer : délai dépassé'));
    }, timeout);
    w[cb] = (data: T) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('Deezer injoignable'));
    };
    script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.appendChild(script);
  });
}

const cache = new Map<string, unknown>();

async function dz<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (cache.has(path)) return cache.get(path) as T;
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_INTERVAL - Date.now();
    lastCall = Math.max(Date.now(), lastCall + MIN_INTERVAL);
    if (wait > 0) await sleep(wait, signal);
    const json = await jsonpOnce<T & { error?: { code: number; message: string } }>(`https://api.deezer.com${path}`);
    if (json.error) {
      // Code 4 = quota dépassé : on patiente et on réessaie.
      if (json.error.code === 4 && attempt < 3) {
        await sleep(5000, signal);
        continue;
      }
      throw new Error(`Deezer : ${json.error.message}`);
    }
    cache.set(path, json);
    return json;
  }
}

export interface DzArtist {
  id: number;
  name: string;
  picture_medium?: string;
  nb_fan?: number;
}

export interface DzTrack {
  id: number;
  title: string;
  duration: number;
  preview: string;
  artist: { id: number; name: string };
  album: { id: number; title: string; cover_medium?: string };
}

export async function findArtist(name: string, signal?: AbortSignal): Promise<DzArtist | null> {
  const res = await dz<{ data: DzArtist[] }>(`/search/artist?q=${encodeURIComponent(name)}&limit=5`, signal);
  const target = normalizeName(name);
  return res.data.find((a) => normalizeName(a.name) === target) ?? null;
}

export async function relatedArtists(id: number, signal?: AbortSignal): Promise<DzArtist[]> {
  return (await dz<{ data: DzArtist[] }>(`/artist/${id}/related?limit=25`, signal)).data;
}

export async function artistTop(id: number, limit = 10, signal?: AbortSignal): Promise<DzTrack[]> {
  return (await dz<{ data: DzTrack[] }>(`/artist/${id}/top?limit=${limit}`, signal)).data;
}
