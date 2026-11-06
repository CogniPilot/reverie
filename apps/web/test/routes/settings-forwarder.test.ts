/**
 * GET /api/settings moved to a Rust handler: the forwarder against a scripted child. The global hooks
 * admit the request; the forwarder sends exactly the TS settings path, publishes the handler's typed
 * bytes through every TS hook, never falls back to its own handler, and refuses only an owner whose
 * session ended during the call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { installResponseEnvelope } from '../../src/web/response-envelope.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSettingsGet } from '../../src/web/routes/settings-get-route.js';
import { RouteChannel } from '../../src/rust-routes/channel.js';
import { ROUTE_MEDIA, ROUTE_STATUSES } from '../../src/rust-routes/config.js';
import type { Frame } from '../../src/rust-routes/frames.js';
import { FakeChild } from '../rust-routes/fake-child.js';

type Script = (child: FakeChild, frame: Frame) => void;

let app: FastifyInstance | undefined;
let children: FakeChild[];
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(script: Script, owner: () => boolean = () => true, settingsPath = '/data/settings.json') {
  children = [];
  const channel = new RouteChannel({
    handlerPath: '/handler',
    statuses: ROUTE_STATUSES,
    media: ROUTE_MEDIA,
    log: () => {},
    spawn: (_path, args) => {
      const child = new FakeChild(Number(args[1]), script);
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  app = Fastify();
  let sends = 0;
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-ts-hook', String(++sends));
  });
  installResponseEnvelope(app, '');
  registerSettingsGet(app, { settingsPath, verifiedOwner: owner, rust: channel });
  installRouteErrorHandler(app);
  app.addHook('onClose', async () => {
    await channel.close();
  });
  await app.ready();
  return app;
}

const typed =
  (media: 1 | 2, body: string, status = 200): Script =>
  (child, frame) => {
    if (frame.body.kind === 'request')
      child.reply(frame.id, { kind: 'typed_response', media, status, body: Buffer.from(body) });
  };

describe('GET /api/settings forwarder', () => {
  it('publishes the typed bytes once through the TS hooks, with no second envelope', async () => {
    const server = await serve(typed(1, '{"success":true,"data":{"theme":"dark"}}'));
    const reply = await server.inject('/api/settings');
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('{"success":true,"data":{"theme":"dark"}}');
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['x-ts-hook']).toBe('1');

    await server.close();
    const text = await serve(typed(2, 'hello'));
    const plain = await text.inject('/api/settings');
    expect(plain.body).toBe('hello');
    expect(plain.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('sends exactly the settings path TS reads, relative ones unchanged', async () => {
    const server = await serve(typed(1, '{}'), () => true, 'relative/settings.json');
    await server.inject('/api/settings');
    const sent = children[0].received[0].body;
    expect(sent.kind).toBe('request');
    if (sent.kind !== 'request') return;
    expect(sent.route).toBe('GET /api/settings');
    expect(sent.json.toString()).toBe('{"settingsPath":"relative/settings.json"}');
  });

  it('passes the handler status through, including the legacy inherited-name 500', async () => {
    const body =
      '{"success":false,"error":"Called reply with an invalid status code: [object Object]","errorCode":"OPERATION_FAILED"}';
    const server = await serve(typed(1, body, 500));
    const reply = await server.inject('/api/settings');
    expect(reply.statusCode).toBe(500);
    expect(reply.body).toBe(body);
  });

  it('answers a refusal, or an untyped reply, with the curated 503 and never its own handler', async () => {
    const refused = await serve((child, frame) => child.reply(frame.id, { kind: 'refusal', code: 'FILE_BOUND' }));
    const reply = await refused.inject('/api/settings');
    expect(reply.statusCode).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({
      success: false,
      error: 'The Rust route handler could not answer (request 1-1). Nothing was changed.',
      errorCode: 'OPERATION_FAILED',
    });
    await refused.close();

    const untyped = await serve((child, frame) => {
      if (frame.body.kind === 'request')
        child.reply(frame.id, { kind: 'response', status: 200, body: Buffer.from('{}') });
    });
    expect((await untyped.inject('/api/settings')).statusCode).toBe(503);
  });

  it('refuses only an owner whose session ended during the call', async () => {
    let checks = 0;
    const revoked = await serve(typed(1, '{"leaked":true}'), () => ++checks === 1);
    const reply = await revoked.inject('/api/settings');
    expect(reply.statusCode).toBe(403);
    expect(reply.body).not.toContain('leaked');
    await revoked.close();

    // Not an owner when admitted (the policy let the caller in): answered, as the TS route answers it.
    const caller = await serve(typed(1, '{"success":true,"data":{}}'), () => false);
    expect((await caller.inject('/api/settings')).statusCode).toBe(200);
  });
});
