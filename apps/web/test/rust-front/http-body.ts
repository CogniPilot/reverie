/**
 * The paired tests' delivery oracle: what a client received, as bytes. A positive case compares these with exactly
 * what the route sends, never with events or markers alone.
 */

/** The body of a raw HTTP/1.1 response with its chunked transfer coding removed. Malformed or truncated chunk framing
 * throws, so a damaged stream cannot pass as a shorter body. */
export function responseBody(raw: Buffer): Buffer {
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('no end of the response headers');
  const body = raw.subarray(split + 4);
  if (!/^transfer-encoding:\s*chunked\s*$/im.test(raw.subarray(0, split).toString('latin1'))) return body;
  const parts: Buffer[] = [];
  for (let at = 0; ; ) {
    const eol = body.indexOf('\r\n', at);
    const size = eol < 0 ? NaN : Number.parseInt(body.subarray(at, eol).toString('latin1'), 16);
    if (!Number.isInteger(size) || size < 0) throw new Error(`bad chunk size at body offset ${at}`);
    at = eol + 2;
    if (size === 0) return Buffer.concat(parts);
    if (body.subarray(at + size, at + size + 2).toString('latin1') !== '\r\n')
      throw new Error(`truncated chunk at body offset ${at}`);
    parts.push(body.subarray(at, at + size));
    at += size + 2;
  }
}

/** Exactly what GET /sse?n&size sends: n events, each `size` bytes of "x". */
export const sseBody = (n: number, size: number) => `data: ${'x'.repeat(size)}\n\n`.repeat(n);
