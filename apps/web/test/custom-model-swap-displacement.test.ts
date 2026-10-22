/**
 * @fileoverview Tests for `detectCustomModelSwapDisplacements()`, the periodic sweep
 * behind server.ts's "custom model swap-displacement check" timer
 * (docs/custom-model-endpoints-plan.md). The apply/create routes' own swap-conflict check
 * only ever runs at a session's own launch/apply moment — this sweep is what catches a
 * LATER eviction triggered by a different session's normal use, which the launch-time
 * check structurally cannot see.
 *
 * Kept in its own file for the same reason as `custom-model-endpoint-rediscovery.test.ts`:
 * a sweep that walks every saved host would otherwise pick up hosts other tests in a
 * shared file create, making an exact call-count assertion meaningless.
 *
 * Port: N/A (no server; drives readCustomModelHosts/writeCustomModelHosts directly plus
 * the mocked webviewFetch dispatcher).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import {
  detectCustomModelSwapDisplacements,
  type CustomModelSessionLike,
} from '../src/web/routes/custom-model-routes.js';
import { webviewFetch } from '../src/web/webview-egress.js';

vi.mock('../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../src/web/webview-egress.js')>('../src/web/webview-egress.js');
  return { ...actual, webviewFetch: vi.fn() };
});

const fetchMock = vi.mocked(webviewFetch);

const ENDPOINT: CustomModelHost = {
  id: 'llama-swap',
  label: 'llama-swap',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

function session(
  overrides: Partial<CustomModelSessionLike> & Pick<CustomModelSessionLike, 'id'>
): CustomModelSessionLike {
  return { name: overrides.id, ...overrides };
}

function mockRunning(running: Array<{ model: string; state: string }>) {
  fetchMock.mockImplementation(async (url: URL) => {
    if (url.pathname === '/running') return new Response(JSON.stringify({ running }), { status: 200 });
    throw new Error(`unexpected request in this test: ${url.href}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('detectCustomModelSwapDisplacements', () => {
  it('flags a session whose own model is no longer in the running list, naming what displaced it', async () => {
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
    mockRunning([{ model: 'fast', state: 'ready' }]);
    const w1 = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });
    const notified = new Set<string>();

    const displacements = await detectCustomModelSwapDisplacements([w1], notified);

    expect(displacements).toEqual([
      {
        sessionId: 'w1',
        sessionName: 'w1',
        endpointId: 'llama-swap',
        previousModel: 'qwen3',
        currentlyLoadedModel: 'fast',
      },
    ]);
    expect(notified.has('w1')).toBe(true);
  });

  it('does not flag a session whose own model is still the one loaded and ready', async () => {
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
    mockRunning([{ model: 'qwen3', state: 'ready' }]);
    const w1 = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });

    const displacements = await detectCustomModelSwapDisplacements([w1], new Set());

    expect(displacements).toEqual([]);
  });

  it('notifies once per displacement — a repeat sweep with nothing changed does not re-flag it', async () => {
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
    mockRunning([{ model: 'fast', state: 'ready' }]);
    const w1 = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });
    const notified = new Set<string>();

    const first = await detectCustomModelSwapDisplacements([w1], notified);
    const second = await detectCustomModelSwapDisplacements([w1], notified);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('clears the notified flag once the session is back on its own model, so a later displacement flags again', async () => {
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
    const w1 = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });
    const notified = new Set<string>();

    mockRunning([{ model: 'fast', state: 'ready' }]);
    await detectCustomModelSwapDisplacements([w1], notified);
    expect(notified.has('w1')).toBe(true);

    mockRunning([{ model: 'qwen3', state: 'ready' }]); // back to normal
    await detectCustomModelSwapDisplacements([w1], notified);
    expect(notified.has('w1')).toBe(false);

    mockRunning([{ model: 'fast', state: 'ready' }]); // displaced again
    const third = await detectCustomModelSwapDisplacements([w1], notified);
    expect(third).toHaveLength(1);
  });

  it('skips a session on a non-llama-swap endpoint (no /running) — nothing to compare, never flagged', async () => {
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    const w1 = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });

    const displacements = await detectCustomModelSwapDisplacements([w1], new Set());

    expect(displacements).toEqual([]);
  });

  it('skips a session whose endpoint was deleted since it was created', async () => {
    await writeCustomModelHosts(getDataDir(), []); // ENDPOINT never saved
    const w1 = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });

    const displacements = await detectCustomModelSwapDisplacements([w1], new Set());

    expect(displacements).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a plain session with no customModel selection at all', async () => {
    const displacements = await detectCustomModelSwapDisplacements([session({ id: 'plain' })], new Set());
    expect(displacements).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('one endpoint failing (unreachable) never blocks checking sessions on another', async () => {
    const DOWN: CustomModelHost = { id: 'down', label: 'down', baseUrl: 'http://192.168.1.60:8080' };
    await writeCustomModelHosts(getDataDir(), [ENDPOINT, DOWN]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.href.includes('192.168.1.60')) throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      if (url.pathname === '/running') {
        return new Response(JSON.stringify({ running: [{ model: 'fast', state: 'ready' }] }), { status: 200 });
      }
      throw new Error(`unexpected request in this test: ${url.href}`);
    });
    const onDown = session({ id: 'w-down', customModel: { endpointId: 'down', modelId: 'x' } });
    const onLlamaSwap = session({ id: 'w1', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });

    const displacements = await detectCustomModelSwapDisplacements([onDown, onLlamaSwap], new Set());

    expect(displacements).toEqual([
      {
        sessionId: 'w1',
        sessionName: 'w1',
        endpointId: 'llama-swap',
        previousModel: 'qwen3',
        currentlyLoadedModel: 'fast',
      },
    ]);
  });

  it('multiple sessions on the same endpoint each get their own displacement entry', async () => {
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
    mockRunning([{ model: 'gemma', state: 'ready' }]);
    const w1 = session({ id: 'w1', name: 'w1-test2', customModel: { endpointId: 'llama-swap', modelId: 'qwen3' } });
    const w2 = session({ id: 'w2', name: 'w2-test2', customModel: { endpointId: 'llama-swap', modelId: 'fast' } });

    const displacements = await detectCustomModelSwapDisplacements([w1, w2], new Set());

    expect(displacements.map((d) => d.sessionId).sort()).toEqual(['w1', 'w2']);
  });
});
