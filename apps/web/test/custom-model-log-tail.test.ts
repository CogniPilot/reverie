/**
 * @fileoverview Tests for `getLatestLlamaSwapLogLine()`/`pruneIdleLlamaSwapLogTails()` —
 * the real-time "what is llama.cpp actually doing" feed behind the loading banner's
 * second line (docs/custom-model-endpoints-plan.md). Confirmed live against a real
 * llama-swap deployment: its `GET /api/events` SSE stream carries the backend
 * llama-server process's own stdout (`load_model: ...`, `llama_server: model loaded`)
 * as `{"type":"logData","data":"{\"data\":\"...\",\"source\":\"upstream\"}"}` frames,
 * tagged distinctly from llama-swap's own `source: "proxy"` request-access log frames.
 *
 * ⚠️ `GET /logs` (the endpoint this feature's own first cut was built against, before
 * being caught by exactly this kind of live check) turns out to carry ONLY the proxy
 * log — confirmed live it never showed a single backend line even seconds after a real,
 * confirmed model swap. `/api/events` is the only source that actually has the data.
 *
 * Drives a hand-built `ReadableStream` body through the mocked `webviewFetch` rather
 * than a real network round-trip — the point under test is the SSE-frame parsing and
 * `source` filtering plus the one-connection-per-endpoint reuse, not networking itself.
 *
 * Each test uses its own host id (`llamaSwapLogTails` is a module-level Map, shared
 * across every test in this file) and `afterEach` force-prunes everything so no tail
 * a test forgot to close leaks into the next one.
 *
 * Port: N/A (no server; drives the exported functions directly).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLatestLlamaSwapLogLine, pruneIdleLlamaSwapLogTails } from '../src/web/routes/custom-model-routes.js';
import { webviewFetch } from '../src/web/webview-egress.js';
import type { CustomModelHost } from '../src/custom-model-hosts.js';

vi.mock('../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../src/web/webview-egress.js')>('../src/web/webview-egress.js');
  return { ...actual, webviewFetch: vi.fn() };
});

const fetchMock = vi.mocked(webviewFetch);

/** One real `GET /api/events` SSE frame carrying backend (`source: "upstream"`) log text. */
function upstreamLogFrame(text: string): string {
  const inner = JSON.stringify({ data: text, source: 'upstream' });
  return `event:message\ndata:${JSON.stringify({ type: 'logData', data: inner })}\n\n`;
}

/** The proxy-log flavor of the same event shape — must never be surfaced as `latestLine`. */
function proxyLogFrame(text: string): string {
  const inner = JSON.stringify({ data: text, source: 'proxy' });
  return `event:message\ndata:${JSON.stringify({ type: 'logData', data: inner })}\n\n`;
}

/** A streaming Response whose body enqueues `frames` up front and then stays open
 *  (never closes) — matches a real `/api/events` connection, confirmed live to stay
 *  open indefinitely (read past 220KB over 8s with no `done`). */
function openStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      // deliberately never controller.close()
    },
  });
  return new Response(stream, { status: 200 });
}

function host(id: string): CustomModelHost {
  return { id, label: id, baseUrl: `http://192.168.1.50:8080/${id}` };
}

/** Lets the fire-and-forget stream-pump's microtasks (reader.read() resolutions) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  pruneIdleLlamaSwapLogTails(Number.POSITIVE_INFINITY); // force-close every tail this file opened
  fetchMock.mockReset();
});

describe('getLatestLlamaSwapLogLine', () => {
  it('returns undefined before any line has arrived, then the real backend log line once it does', async () => {
    const h = host('t1');
    fetchMock.mockResolvedValue(
      openStreamResponse([upstreamLogFrame('0.31.428.568 I srv  llama_server: model loaded')])
    );

    const before = getLatestLlamaSwapLogLine(h);
    expect(before).toBeUndefined();
    await flush();
    const after = getLatestLlamaSwapLogLine(h);

    expect(after).toBe('0.31.428.568 I srv  llama_server: model loaded');
  });

  it('filters out llama-swap\'s own proxy-sourced frames, keeping only source: "upstream"', async () => {
    const h = host('t2');
    fetchMock.mockResolvedValue(
      openStreamResponse([
        proxyLogFrame('[INFO] Request 10.10.10.1 "GET /running HTTP/1.1" 200 407 "undici" 46.207µs'),
        upstreamLogFrame('0.14.157.100 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 16384'),
        proxyLogFrame('[WARN] some warning about something unrelated'),
      ])
    );

    getLatestLlamaSwapLogLine(h);
    await flush();

    expect(getLatestLlamaSwapLogLine(h)).toBe(
      '0.14.157.100 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 16384'
    );
  });

  it('keeps the LAST line when one upstream frame batches several newline-joined lines', async () => {
    const h = host('t3');
    fetchMock.mockResolvedValue(
      openStreamResponse([
        upstreamLogFrame(
          '0.00.001.000 I srv  llama_server: starting\n0.00.002.000 I srv  llama_server: loading tensors'
        ),
        upstreamLogFrame('0.00.003.000 I srv  llama_server: model loaded'),
      ])
    );

    getLatestLlamaSwapLogLine(h);
    await flush();

    expect(getLatestLlamaSwapLogLine(h)).toBe('0.00.003.000 I srv  llama_server: model loaded');
  });

  it('handles a frame split across two stream chunks (SSE double-newline boundary not yet seen)', async () => {
    const h = host('t3b');
    const whole = upstreamLogFrame('0.00.005.000 I srv  llama_server: model loaded');
    const splitAt = Math.floor(whole.length / 2);
    fetchMock.mockResolvedValue(openStreamResponse([whole.slice(0, splitAt), whole.slice(splitAt)]));

    getLatestLlamaSwapLogLine(h);
    await flush();

    expect(getLatestLlamaSwapLogLine(h)).toBe('0.00.005.000 I srv  llama_server: model loaded');
  });

  it('ignores a malformed frame instead of throwing', async () => {
    const h = host('t3c');
    fetchMock.mockResolvedValue(
      openStreamResponse(['event:message\ndata:not valid json\n\n', upstreamLogFrame('llama_server: model loaded')])
    );

    getLatestLlamaSwapLogLine(h);
    await flush();

    expect(getLatestLlamaSwapLogLine(h)).toBe('llama_server: model loaded');
  });

  it('ignores a non-logData event type', async () => {
    const h = host('t3d');
    fetchMock.mockResolvedValue(
      openStreamResponse([
        `event:message\ndata:${JSON.stringify({ type: 'modelStatus', data: '{}' })}\n\n`,
        upstreamLogFrame('llama_server: model loaded'),
      ])
    );

    getLatestLlamaSwapLogLine(h);
    await flush();

    expect(getLatestLlamaSwapLogLine(h)).toBe('llama_server: model loaded');
  });

  it('opens exactly one connection per endpoint — a second call while the tail is open never re-fetches', async () => {
    const h = host('t4');
    fetchMock.mockResolvedValue(openStreamResponse([upstreamLogFrame('llama_server: model loaded')]));

    getLatestLlamaSwapLogLine(h);
    await flush();
    getLatestLlamaSwapLogLine(h);
    getLatestLlamaSwapLogLine(h);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests /api/events specifically, with the endpoint's own auth headers", async () => {
    const h: CustomModelHost = { id: 't5', label: 't5', baseUrl: 'http://192.168.1.60:9000', apiKey: 'secret-key' };
    fetchMock.mockResolvedValue(openStreamResponse([]));

    getLatestLlamaSwapLogLine(h);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect((url as URL).pathname).toBe('/api/events');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-key' });
  });

  it('an unreachable endpoint (fetch throws) leaves latestLine undefined rather than throwing', async () => {
    const h = host('t6');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    expect(() => getLatestLlamaSwapLogLine(h)).not.toThrow();
    await flush();
    expect(getLatestLlamaSwapLogLine(h)).toBeUndefined();
  });

  it('a non-2xx response leaves latestLine undefined rather than throwing', async () => {
    const h = host('t7');
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    getLatestLlamaSwapLogLine(h);
    await flush();

    expect(getLatestLlamaSwapLogLine(h)).toBeUndefined();
  });
});

describe('pruneIdleLlamaSwapLogTails', () => {
  it('closes a tail nothing has polled recently, so the next access starts a fresh connection', async () => {
    const h = host('t8');
    fetchMock.mockResolvedValue(openStreamResponse([upstreamLogFrame('llama_server: model loaded')]));

    getLatestLlamaSwapLogLine(h); // opens the first connection, lastAccessedAt = now
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pruneIdleLlamaSwapLogTails(Date.now() + 60_000); // "now" far enough ahead that the tail reads as idle

    getLatestLlamaSwapLogLine(h); // the entry was removed — this must open a NEW connection
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves a recently-accessed tail alone', async () => {
    const h = host('t9');
    fetchMock.mockResolvedValue(openStreamResponse([upstreamLogFrame('llama_server: model loaded')]));

    getLatestLlamaSwapLogLine(h);
    await flush();

    pruneIdleLlamaSwapLogTails(Date.now()); // no time has passed — nothing is idle yet

    getLatestLlamaSwapLogLine(h);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just the one connection
  });
});
