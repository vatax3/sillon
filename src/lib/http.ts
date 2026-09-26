/** Identifiant envoyé par le serveur auto-hébergé (MusicBrainz bloque les clients anonymes). */
export const SERVER_USER_AGENT = 'Sillon/1.0 (self-hosted; https://github.com/vatax3/sillon)';

/** En-têtes à ajouter côté serveur uniquement (un navigateur refuse de modifier son User-Agent). */
export const serverHeaders = (): Record<string, string> => (typeof document === 'undefined' ? { 'User-Agent': SERVER_USER_AGENT } : {});

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * fetch avec reprise automatique sur 429 (en respectant Retry-After) et sur 5xx.
 * `beforeRetry` permet par ex. de rafraîchir un token sur 401.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { retries?: number; onUnauthorized?: () => Promise<RequestInit> } = {},
): Promise<Response> {
  const retries = opts.retries ?? 5;
  let current = init;
  let refreshedAuth = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, current);
    } catch (e) {
      if (isAbort(e) || attempt >= retries) throw e;
      await sleep(1000 * 2 ** attempt, init.signal ?? undefined);
      continue;
    }
    if (res.status === 401 && opts.onUnauthorized && !refreshedAuth) {
      refreshedAuth = true;
      current = await opts.onUnauthorized();
      continue;
    }
    const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await sleep(Math.min(wait, 60_000), init.signal ?? undefined);
      continue;
    }
    return res;
  }
}

/** Exécute `task` sur chaque élément avec une concurrence bornée et un délai minimal entre deux démarrages. */
export async function throttledEach<T>(
  items: T[],
  task: (item: T, index: number) => Promise<void>,
  opts: { concurrency: number; minIntervalMs: number; signal?: AbortSignal },
): Promise<void> {
  let next = 0;
  let lastStart = 0;
  let gate = Promise.resolve();
  const reserveSlot = () => {
    // Sérialise les démarrages pour garantir l'intervalle minimal.
    const p = gate.then(async () => {
      const wait = lastStart + opts.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait, opts.signal);
      lastStart = Date.now();
    });
    gate = p.catch(() => {});
    return p;
  };
  const worker = async () => {
    while (next < items.length) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = next++;
      await reserveSlot();
      await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, items.length) }, worker));
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
