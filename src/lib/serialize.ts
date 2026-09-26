// JSON ne sait pas représenter les typed arrays (utilisés par l'historique) : on les encode en base64.
// Partagé entre le navigateur et le serveur pour échanger les documents tels quels.

type TypedArrayName = 'Float64Array' | 'Uint32Array' | 'Uint8Array';
const CTORS = { Float64Array, Uint32Array, Uint8Array } as const;

interface Encoded {
  __ta: TypedArrayName;
  b64: string;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    for (const name of Object.keys(CTORS) as TypedArrayName[]) {
      if (v instanceof CTORS[name]) {
        const ta = v as Float64Array | Uint32Array | Uint8Array;
        return { __ta: name, b64: toBase64(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength)) } satisfies Encoded;
      }
    }
    return v;
  });
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.__ta === 'string' && typeof v.b64 === 'string' && v.__ta in CTORS) {
      const bytes = fromBase64(v.b64);
      // Copie alignée : le buffer décodé peut ne pas être aligné sur 8 octets.
      const aligned = new Uint8Array(bytes.length);
      aligned.set(bytes);
      return new CTORS[v.__ta as TypedArrayName](aligned.buffer);
    }
    return v;
  }) as T;
}
