/**
 * @fileoverview The text embeddings the old per-instance memory store ranks recall with, matching python's
 * `reverie.embeddings`: the hashed bag-of-words embedder (BLAKE2b with an 8-byte digest per feature) and the
 * llama-server `/embeddings` client. Vectors read back from the store are float32, so anything compared with them is
 * rounded the same way by the caller.
 */

import { crLog, pySum } from './python-float.js';

// BLAKE2b on 32-bit word pairs (low word first), so hashing a feature costs microseconds rather than BigInt arithmetic.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1,
  0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a] += v[b], 64-bit. */
function add64(a: number, b: number): void {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

/** v[a] += m[x], 64-bit. */
function add64m(a: number, x: number): void {
  const lo = v[a] + m[x];
  v[a + 1] = v[a + 1] + m[x + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

function g(a: number, b: number, c: number, d: number, x: number, y: number): void {
  add64(a, b);
  add64m(a, x);
  let lo = v[d] ^ v[a];
  let hi = v[d + 1] ^ v[a + 1];
  v[d] = hi; // rotate right 32
  v[d + 1] = lo;
  add64(c, d);
  lo = v[b] ^ v[c];
  hi = v[b + 1] ^ v[c + 1];
  v[b] = (lo >>> 24) | (hi << 8); // rotate right 24
  v[b + 1] = (hi >>> 24) | (lo << 8);
  add64(a, b);
  add64m(a, y);
  lo = v[d] ^ v[a];
  hi = v[d + 1] ^ v[a + 1];
  v[d] = (lo >>> 16) | (hi << 16); // rotate right 16
  v[d + 1] = (hi >>> 16) | (lo << 16);
  add64(c, d);
  lo = v[b] ^ v[c];
  hi = v[b + 1] ^ v[c + 1];
  v[b] = (hi >>> 31) | (lo << 1); // rotate right 63
  v[b + 1] = (lo >>> 31) | (hi << 1);
}

function compress(h: Uint32Array, block: Uint8Array, counter: number, last: boolean): void {
  for (let i = 0; i < 16; i++) {
    v[i] = h[i];
    v[i + 16] = IV[i];
  }
  v[24] ^= counter >>> 0;
  v[25] ^= Math.floor(counter / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i++)
    m[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10];
    g(0, 8, 16, 24, s[0] * 2, s[1] * 2);
    g(2, 10, 18, 26, s[2] * 2, s[3] * 2);
    g(4, 12, 20, 28, s[4] * 2, s[5] * 2);
    g(6, 14, 22, 30, s[6] * 2, s[7] * 2);
    g(0, 10, 20, 30, s[8] * 2, s[9] * 2);
    g(2, 12, 22, 24, s[10] * 2, s[11] * 2);
    g(4, 14, 16, 26, s[12] * 2, s[13] * 2);
    g(6, 8, 18, 28, s[14] * 2, s[15] * 2);
  }
  for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
}

/** Unkeyed BLAKE2b with an 8-byte digest, as its low and high little-endian 32-bit words. */
function blake2bWords(data: Uint8Array): [number, number] {
  const h = IV.slice();
  h[0] ^= 0x01010000 ^ 8;
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  const block = new Uint8Array(128);
  for (let i = 0; i < blocks; i++) {
    block.fill(0);
    block.set(data.subarray(i * 128, (i + 1) * 128));
    const last = i === blocks - 1;
    compress(h, block, last ? data.length : (i + 1) * 128, last);
  }
  return [h[0], h[1]];
}

/** The 8-byte digest read as a little-endian unsigned integer (python's `int.from_bytes(..., "little")`). */
export function blake2b64(data: Uint8Array): bigint {
  const [lo, hi] = blake2bWords(data);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

const WORD = /[a-z0-9']+/g;
const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for with from as is are was were be been being am ' +
    'i me my you your he she it its we they them this that these those do does did have has had not no ' +
    'yes just like about what which who whom how when where why there here very can could would should ' +
    'will shall may might must oh ok okay hey hi hello well too also ever even really'
  ).split(' ')
);

/** Lowercased word tokens without stopwords or single characters. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((word) => !STOPWORDS.has(word) && word.length > 1);
}

export function normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(pySum(vector.map((x) => x * x)));
  return norm === 0 ? [...vector] : vector.map((x) => x / norm);
}

/** The dot product of two unit vectors; 0 when their lengths differ or they are empty. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  return pySum(a.map((x, i) => x * b[i]));
}

export interface Embedder {
  name: string;
  embed(text: string, kind?: 'document' | 'query'): Promise<number[]>;
}

const encoder = new TextEncoder();
const weights = new Map<number, number>();
/** Sublinear term frequency, `1 + log(count)`, cached: counts repeat and the correctly rounded log is not cheap. */
function weight(count: number): number {
  let w = weights.get(count);
  if (w === undefined) weights.set(count, (w = 1 + crLog(count)));
  return w;
}

export function hashedEmbedder(dims = 1024): Embedder {
  return {
    name: `hashed-v1-${dims}`,
    async embed(text) {
      const vector = new Array<number>(dims).fill(0);
      const tokens = tokenize(text);
      const features = [...tokens, ...tokens.slice(1).map((token, i) => `${tokens[i]}_${token}`)];
      const counts = new Map<string, number>();
      for (const feature of features) counts.set(feature, (counts.get(feature) ?? 0) + 1);
      for (const [feature, count] of counts) {
        const [lo, hi] = blake2bWords(encoder.encode(feature));
        // n % dims for n = hi * 2**32 + lo, exact in doubles for any dims below 2**20; the sign is bit 63
        vector[(hi * (0x100000000 % dims) + (lo % dims)) % dims] += (hi >>> 31 ? 1 : -1) * weight(count);
      }
      return normalize(vector);
    },
  };
}

export interface LlamaOptions {
  model?: string;
  docPrefix?: string;
  queryPrefix?: string;
  /** Per-request deadline. */
  timeoutMs?: number;
  /** Largest response body read; the read stops as soon as it is exceeded. */
  maxBytes?: number;
  /** Absolute deadline (ms since the epoch) shared by every request of one recall. */
  deadline?: number;
  fetch?: typeof fetch;
}

/** The whole body, read incrementally and abandoned as soon as it exceeds `maxBytes`. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('embedding response is too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** A llama-server `/v1/embeddings` client, as python's LlamaEmbedder: prefixes by kind, model only when set. */
export function llamaEmbedder(url: string, options: LlamaOptions = {}): Embedder {
  const endpoint = url.replace(/\/+$/, '') + '/embeddings';
  const { model = '', docPrefix = 'search_document: ', queryPrefix = 'search_query: ' } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const request = options.fetch ?? fetch;
  return {
    name: `llama:${model || 'default'}`,
    async embed(text, kind = 'document') {
      const body: Record<string, string> = { input: (kind === 'query' ? queryPrefix : docPrefix) + text };
      if (model) body.model = model;
      const response = await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining(timeoutMs, options.deadline)),
      });
      if (!response.ok) throw new Error(`embedding service answered ${response.status}`);
      const raw = await readBounded(response, maxBytes);
      const vector = (JSON.parse(new TextDecoder().decode(raw)) as { data: Array<{ embedding: unknown[] }> }).data[0]
        .embedding;
      return normalize(
        vector.map((x) => {
          if (typeof x !== 'number') throw new Error('embedding service returned a non-numeric vector');
          return x;
        })
      );
    },
  };
}

/** Python's `make_embedder`: the llama backend when a URL is set and a probe succeeds, else the hashed one. */
export async function pickEmbedder(
  embedUrl: string,
  options: LlamaOptions & { dims?: number } = {}
): Promise<Embedder> {
  if (embedUrl) {
    const llama = llamaEmbedder(embedUrl, options);
    try {
      await llama.embed('probe');
      return llama;
    } catch {
      /* unreachable or malformed: fall back as python does */
    }
  }
  return hashedEmbedder(options.dims ?? 1024);
}

/** The time a request may take: its own limit, or less when the recall's shared deadline is nearer. */
export function remaining(limitMs: number, deadline?: number): number {
  if (deadline === undefined) return limitMs;
  const left = deadline - Date.now();
  if (left <= 0) throw new Error('recall took longer than its time limit');
  return Math.min(limitMs, left);
}
