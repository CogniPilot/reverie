/**
 * @fileoverview The text embeddings the old per-instance memory store ranks recall with, matching python's
 * `reverie.embeddings`: the hashed bag-of-words embedder (BLAKE2b with an 8-byte digest per feature) and the
 * llama-server `/embeddings` client. Vectors read back from the store are float32, so anything compared with them is
 * rounded the same way by the caller.
 */

import { crLog, pySum } from './python-float.js';

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
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

const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK;

function compress(h: bigint[], block: Uint8Array, counter: bigint, last: boolean): void {
  const view = new DataView(block.buffer, block.byteOffset, 128);
  const m = Array.from({ length: 16 }, (_, i) => view.getBigUint64(i * 8, true));
  const v = [...h, ...IV];
  v[12] ^= counter & MASK;
  v[13] ^= counter >> 64n;
  if (last) v[14] ^= MASK;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b with an 8-byte digest, read as a little-endian unsigned integer (python's `int.from_bytes`). */
export function blake2b64(data: Uint8Array): bigint {
  const h = [...IV];
  h[0] ^= 0x01010000n ^ 8n;
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let i = 0; i < blocks; i++) {
    const block = new Uint8Array(128);
    const chunk = data.subarray(i * 128, (i + 1) * 128);
    block.set(chunk);
    const last = i === blocks - 1;
    compress(h, block, BigInt(last ? data.length : (i + 1) * 128), last);
  }
  return h[0];
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
        const n = blake2b64(encoder.encode(feature));
        vector[Number(n % BigInt(dims))] += ((n >> 63n) & 1n ? 1 : -1) * (1 + crLog(count));
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
  /** Largest response body read. */
  maxBytes?: number;
  fetch?: typeof fetch;
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
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`embedding service answered ${response.status}`);
      const raw = await response.arrayBuffer();
      if (raw.byteLength > maxBytes) throw new Error('embedding response is too large');
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
