/**
 * @fileoverview The float helpers and hashed embedder reproduce python's results where V8's own functions differ. Values
 * come from python (math.log, 0.995 ** h, repr, hashlib.blake2b, reverie.embeddings.HashedEmbedder); the log and pow
 * samples are the inputs on which V8's Math.log and Math.pow disagree with python.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blake2b64, hashedEmbedder } from '../src/memory-embed.js';
import { crLog, crPow, pyFloatRepr, pySum } from '../src/python-float.js';

const reference = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'python-float-reference.json'), 'utf8')
) as {
  log: Array<[number, number]>;
  pow: Array<[number, number]>;
  glibcNotCorrectlyRounded: Array<[number, number]>;
  repr: Array<[number, string]>;
  blake2b64: Array<[string, string]>;
  hashedVectorSha256: Array<[string, string]>;
};

describe('python float arithmetic', () => {
  it("matches math.log where V8's Math.log does not", () => {
    for (const [x, y] of reference.log) expect(crLog(x), String(x)).toBe(y);
  });

  it("matches 0.995 ** hours where V8's Math.pow does not", () => {
    for (const [h, y] of reference.pow) expect(crPow(0.995, h), String(h)).toBe(y);
  });

  it('is one unit in the last place from the C library only where the C library is not correctly rounded', () => {
    for (const [h, y] of reference.glibcNotCorrectlyRounded) {
      const got = crPow(0.995, h);
      expect(got).not.toBe(y);
      expect(Math.abs(got - y)).toBeLessThanOrEqual(Number.EPSILON * Math.abs(y));
    }
  });

  it("sums like python's compensated sum()", () => {
    expect(pySum([1e16, 1, -1e16])).toBe(1);
    expect(pySum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(pySum([])).toBe(0);
  });

  it('formats like repr()', () => {
    for (const [x, s] of reference.repr) expect(pyFloatRepr(x)).toBe(s);
  });
});

describe('the hashed embedder', () => {
  it('hashes like hashlib.blake2b(digest_size=8), across block boundaries', () => {
    for (const [text, n] of reference.blake2b64)
      expect(blake2b64(new TextEncoder().encode(text)), JSON.stringify(text)).toBe(BigInt(n));
  });

  it('embeds exactly as reverie.embeddings.HashedEmbedder(1024), repeated tokens included', async () => {
    for (const [text, sha] of reference.hashedVectorSha256) {
      const vector = await hashedEmbedder(1024).embed(text);
      expect(
        createHash('sha256')
          .update(Buffer.from(new Float64Array(vector).buffer))
          .digest('hex'),
        JSON.stringify(text)
      ).toBe(sha);
    }
  });
});
