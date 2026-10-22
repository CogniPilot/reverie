import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerVoiceTurnRoutes } from '../../src/web/routes/voice-turn-routes.js';
import type { ChatroomService } from '../../src/chatroom-service.js';
import { ChatroomMessageSchema } from '../../src/web/schemas.js';

afterEach(() => vi.unstubAllGlobals());

async function probe(url = 'http://127.0.0.1:8090') {
  const { app } = await createRouteTestHarness((server) =>
    registerVoiceTurnRoutes(server, {} as ChatroomService, { serviceUrl: () => url })
  );
  try {
    const response = await app.inject({ method: 'GET', url: '/api/voice/status' });
    expect(response.headers['cache-control']).toBe('no-store');
    return response.json().data;
  } finally {
    await app.close();
  }
}

describe('speech service readiness', () => {
  it('probes health only and requires both Whisper and Piper to be ready', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', stt: 'ready', tts: 'ready' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await probe()).toMatchObject({ available: true });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8090/health',
      expect.objectContaining({ signal: expect.any(AbortSignal), redirect: 'error' })
    );
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify({ status: 'ok', stt: 'loading', tts: 'ready' }))
    );
    expect(await probe()).toMatchObject({ available: false, message: expect.stringContaining('not ready') });
  });

  it('reports an unreachable service with host/port and excludes credentials/path/query', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private upstream error')));
    const result = await probe('https://user:secret@voice.example:9443/private?token=secret');
    expect(result.available).toBe(false);
    expect(result.message).toContain('Whisper/Piper speech service at voice.example:9443');
    expect(JSON.stringify(result)).not.toMatch(/secret|user:|private|token/);
  });

  it.each([
    ['non-JSON', 'bad', 200],
    ['HTTP failure', '{}', 503],
    ['oversize', 'x'.repeat(4097), 200],
    ['wrong shape', '[]', 200],
  ])('fails closed for %s health replies', async (_name, text, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(text, { status }))
    );
    expect((await probe()).available).toBe(false);
  });

  it('aborts a stalled health request within the two-second probe budget', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        })
    );
    const started = Date.now();
    expect((await probe()).available).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('spoken message content boundary', () => {
  const image = '00000000-0000-4000-8000-000000000001';
  it('preserves image-only typed messages and rejects empty spoken messages even with an attachment', () => {
    expect(ChatroomMessageSchema.safeParse({ text: '', attachments: [image] }).success).toBe(true);
    expect(ChatroomMessageSchema.safeParse({ text: ' \n ', spoken: true }).success).toBe(false);
    expect(ChatroomMessageSchema.safeParse({ text: '', spoken: true, attachments: [image] }).success).toBe(false);
    expect(ChatroomMessageSchema.safeParse({ text: 'a transcript', spoken: true }).success).toBe(true);
  });
});
