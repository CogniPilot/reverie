/** Real WebServer global hooks must preserve the federation protocol's bare wire contract. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebServer } from '../src/web/server.js';
import { BuiltinEmbassy } from '../src/embassy-builtin.js';
import type { EmbassyHost } from '../src/embassy-host.js';
import { parsePairInvite } from '../src/embassy-pair-key.js';
import { dataPath } from '../src/config/instance.js';
let server: WebServer, app: FastifyInstance;
beforeAll(async () => {
  server = new WebServer(0, false, true, '127.0.0.1', undefined, false, '/reverie');
  await server.start();
  app = (server as unknown as { app: FastifyInstance }).app;
});
afterAll(async () => {
  await server?.stop();
});
it('keeps protocol errors bare through real global hooks, including the mounted base path', async () => {
  for (const prefix of ['', '/reverie']) {
    const response = await app.inject({ method: 'POST', url: prefix + '/api/embassy/pair-request', payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'ADVERTISED_ORIGIN_REQUIRED' } });
    expect(response.json()).not.toHaveProperty('success');
    expect(response.json()).not.toHaveProperty('data');
  }
});
it('keeps a valid private pairing response bare and ordinary console APIs enveloped', async () => {
  const builtin = new BuiltinEmbassy({
    file: dataPath('embassy-host', 'builtin.json'),
    channelFile: dataPath('embassy-channel', 'channel.json'),
    secretFile: dataPath('embassy-channel', 'secret'),
  });
  await builtin.init();
  await builtin.configure('https://embassy.example.com');
  const host = (server as unknown as { embassyHost: EmbassyHost }).embassyHost;
  for (const prefix of ['', '/reverie']) {
    const invite = parsePairInvite((await host.createInvite(randomUUID())).qr),
      secret = randomBytes(32).toString('base64url');
    const response = await app.inject({
      method: 'POST',
      url: prefix + '/api/embassy/pair-request',
      payload: {
        roomId: invite.roomId,
        token: invite.token,
        claimHash: createHash('sha256').update(secret).digest('base64url'),
        company: 'Synthetic visitor',
        identity: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'pending', roomId: invite.roomId, requestId: expect.any(String) });
    expect(response.json()).not.toHaveProperty('success');
    expect(response.json()).not.toHaveProperty('data');
  }
  const ordinary = await app.inject({ url: '/api/status' });
  expect(ordinary.statusCode).toBe(200);
  expect(ordinary.json()).toMatchObject({ success: true, data: expect.any(Object) });
});
