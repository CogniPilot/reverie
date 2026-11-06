/**
 * The real WebServer behind a fake Rust front: start() binds through the front and takes its port from
 * `bound`, serves the front's connections with every hook in place, fails as listen() would on
 * `bind_failed`, binds the docker bridge through the front, and unbinds on stop(). The suite's setup gives
 * it a temporary HOME.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebServer } from '../../src/web/server.js';
import { FrontChannel } from '../../src/rust-front/front.js';
import { dataPath } from '../../src/config/instance.js';
import { FakeFront } from './fake-front.js';

type Internal = { app: FastifyInstance; _startDockerBridgeHooksListener(): Promise<void> };
const running: WebServer[] = [];
const env = { ...process.env };

afterEach(async () => {
  for (const server of running.splice(0)) await server.stop().catch(() => undefined);
  for (const key of ['REVERIE_DOCKER_BRIDGE_HOOKS', 'REVERIE_DOCKER_BRIDGE_HOST', 'REVERIE_API_URL'])
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
});

/** A test-mode WebServer behind a fake front; `bound` answers main's bind with `port`. */
function fronted(https = false): { server: WebServer; fake: FakeFront; front: FrontChannel } {
  const fake = new FakeFront();
  const front = new FrontChannel(fake.channel);
  const server = new WebServer(0, https, true, '127.0.0.1', undefined, false, '', undefined, undefined, false, front);
  running.push(server);
  return { server, fake, front };
}

async function start(fake: FakeFront, server: WebServer, port = 41235): Promise<void> {
  const started = server.start();
  await fake.next('bind_request');
  fake.send(0n, { kind: 'bound', listener: 'main', port });
  await started;
}

describe('WebServer behind the Rust front', () => {
  it('binds through the front, takes its port from bound, then accepts and reports service_ready', async () => {
    const { server, fake } = fronted();
    await start(fake, server);
    expect(fake.frames[0].body).toEqual({
      kind: 'bind_request',
      listener: 'main',
      tls: false,
      port: 0,
      host: '127.0.0.1',
    });
    expect(fake.frames.map((frame) => frame.body.kind)).toEqual(['bind_request', 'accepting', 'service_ready']);
    expect(server.boundPort).toBe(41235);
    expect(process.env.REVERIE_API_URL).toBe('http://127.0.0.1:41235');
    expect((server as unknown as Internal).app.server.listening).toBe(false);
  });

  it("serves the front's connections through every hook", async () => {
    const { server, fake } = fronted();
    await start(fake, server);
    const response = await fake.request(
      'GET /api/no-such-route HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(response).toMatch(/^HTTP\/1\.1 \d{3} /);
    // The security-header hook ran, so the request went through Fastify's own hooks, not around them.
    expect(response.toLowerCase()).toContain('x-content-type-options: nosniff');
  });

  it('keeps TLS out of Fastify when https is on, and leaves the certificate for the front', async () => {
    const { server, fake } = fronted(true);
    await start(fake, server);
    expect(fake.frames[0].body).toMatchObject({ kind: 'bind_request', tls: true });
    expect((server as unknown as Internal).app.server).not.toBeInstanceOf(HttpsServer);
    expect(existsSync(join(dataPath('certs'), 'server.key'))).toBe(true);
    expect(existsSync(join(dataPath('certs'), 'server.crt'))).toBe(true);
    expect(process.env.REVERIE_API_URL).toBe('https://127.0.0.1:41235');
  });

  it('rejects start() with the errno code on bind_failed, as listen() would', async () => {
    const { server, fake } = fronted();
    const started = server.start();
    await fake.next('bind_request');
    fake.send(0n, { kind: 'bind_failed', listener: 'main', errno: 'EADDRINUSE', message: 'address already in use' });
    await expect(started).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(fake.frames.some((frame) => frame.body.kind === 'accepting')).toBe(false);
  });

  it('unbinds main when it stops', async () => {
    const { server, fake } = fronted();
    await start(fake, server);
    await server.stop();
    running.splice(running.indexOf(server), 1);
    expect(fake.frames.at(-1)?.body).toEqual({ kind: 'unbind', listener: 'main' });
  });

  it('binds the docker bridge through the front, refuses non-hook paths with its 403, and unbinds it', async () => {
    process.env.REVERIE_DOCKER_BRIDGE_HOOKS = '1';
    process.env.REVERIE_DOCKER_BRIDGE_HOST = '172.17.0.1';
    const { server, fake } = fronted();
    await start(fake, server);
    // Test mode skips the bridge in start(); run the same step it runs outside test mode.
    const bridge = (server as unknown as Internal)._startDockerBridgeHooksListener();
    const request = await fake.next('bind_request', 1);
    expect(request.body).toEqual({
      kind: 'bind_request',
      listener: 'bridge',
      tls: false,
      port: 41235,
      host: '172.17.0.1',
    });
    fake.send(0n, { kind: 'bound', listener: 'bridge', port: 41235 });
    await bridge;
    await fake.next('accepting', fake.frames.indexOf(request));
    const refused = await fake.request('GET /api/sessions HTTP/1.1\r\nHost: 172.17.0.1\r\nConnection: close\r\n\r\n', {
      listener: 'bridge',
      peer: { address: '172.17.0.2', port: 40000 },
      local: { address: '172.17.0.1', port: 41235 },
    });
    expect(refused.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(refused).toContain('forbidden: the docker bridge listener serves hook endpoints only');
    await server.stop();
    running.splice(running.indexOf(server), 1);
    const unbinds = fake.frames.filter((frame) => frame.body.kind === 'unbind').map((frame) => frame.body);
    expect(unbinds).toEqual([
      { kind: 'unbind', listener: 'bridge' },
      { kind: 'unbind', listener: 'main' },
    ]);
  });
});
