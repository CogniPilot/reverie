/**
 * GET /api/subscription-profiles moved to a Rust handler: the forwarder against a scripted child.
 * The route keeps authorization, the CLI-registry modes and every TS hook; it never falls back to
 * its own handler, and it publishes only to a live, still-authorized request.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSubscriptionProfileRoutes } from '../../src/web/routes/subscription-profile-routes.js';
import { subscriptionModes } from '../../src/subscription-profiles.js';
import { SubscriptionUsageReader } from '../../src/subscription-usage.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { RouteChannel } from '../../src/rust-routes/channel.js';
import { ROUTE_STATUSES } from '../../src/rust-routes/config.js';
import type { Frame } from '../../src/rust-routes/frames.js';
import { NO_OWNER } from '../../src/owner-auth/marks.js';
import { FakeChild } from '../rust-routes/fake-child.js';

type Script = (child: FakeChild, frame: Frame) => void;

let root: string;
let app: FastifyInstance | undefined;
let children: FakeChild[];
const saved = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-forwarder-'));
  process.env.REVERIE_DATA_DIR = root;
  children = [];
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

async function serve(script: Script, owner: () => boolean = () => true): Promise<FastifyInstance> {
  const channel = new RouteChannel({
    handlerPath: '/handler',
    statuses: ROUTE_STATUSES,
    log: () => {},
    spawn: (_path, args) => {
      const child = new FakeChild(Number(args[1]), script);
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  app = Fastify();
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-ts-hook', 'ran');
  });
  registerSubscriptionProfileRoutes(app, new SubscriptionUsageReader('test'), async () => [], owner, NO_OWNER, channel);
  installRouteErrorHandler(app);
  app.addHook('onClose', async () => {
    await channel.close();
  });
  await app.ready();
  return app;
}

const answer =
  (body: string, status = 200): Script =>
  (child, frame) => {
    if (frame.body.kind === 'request') child.reply(frame.id, { kind: 'response', status, body: Buffer.from(body) });
  };

describe('subscription profiles moved to the Rust handler', () => {
  // First in the file, before anything loads the memoized CLI registry in this module graph.
  it('never touches the CLI registry when the handler needs no modes', async () => {
    writeFileSync(join(root, 'clis.json'), '{ not json');
    const server = await serve(answer('{"success":true,"data":{"profiles":[]}}'));
    const reply = await server.inject('/api/subscription-profiles');
    expect(reply.statusCode).toBe(200);
    expect(readdirSync(root)).toEqual(['clis.json']);
  });

  it('answers with the handler bytes, never its own handler, through every TS hook', async () => {
    writeFileSync(join(root, 'subscription-profiles.json'), 'not a profile list');
    const server = await serve(answer('{"from":"rust"}'));
    const reply = await server.inject('/api/subscription-profiles');
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('{"from":"rust"}');
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['x-ts-hook']).toBe('ran');
    const sent = children[0].received[0].body;
    expect(sent.kind).toBe('request');
    if (sent.kind !== 'request') return;
    expect(Object.keys(JSON.parse(sent.json.toString()))).toEqual(['env', 'home', 'cwd', 'platform', 'dataDir']);
  });

  it('reads the modes only when the handler asks, for exactly its providers', async () => {
    const server = await serve((child, frame) => {
      if (frame.body.kind === 'request')
        child.reply(frame.id, { kind: 'observe', observation: 'subscription_modes', providers: ['openai'] });
      if (frame.body.kind === 'observed')
        child.reply(frame.id, { kind: 'response', status: 200, body: frame.body.json });
    });
    const reply = await server.inject('/api/subscription-profiles');
    expect(JSON.parse(reply.body)).toEqual({ openai: subscriptionModes('openai') });
  });

  it('keeps the first 403 in TS and refuses a caller revoked during the call', async () => {
    const refused = await serve(answer('{}'), () => false);
    expect((await refused.inject('/api/subscription-profiles')).statusCode).toBe(403);
    expect(children).toHaveLength(0);
    await refused.close();

    let checks = 0;
    const revoked = await serve(answer('{"leaked":true}'), () => ++checks === 1);
    const reply = await revoked.inject('/api/subscription-profiles');
    expect(reply.statusCode).toBe(403);
    expect(reply.body).not.toContain('leaked');
  });

  it('answers a refusal with the curated 503 that names the request', async () => {
    const server = await serve((child, frame) => child.reply(frame.id, { kind: 'refusal', code: 'PLATFORM' }));
    const reply = await server.inject('/api/subscription-profiles');
    expect(reply.statusCode).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({
      success: false,
      error: 'The Rust route handler could not answer (request 1-1). Nothing was changed.',
      errorCode: 'OPERATION_FAILED',
    });
    expect(reply.headers['x-ts-hook']).toBe('ran');
  });

  it('over real HTTP: a slow reply still arrives, and a disconnect cancels and writes nothing', async () => {
    let release: (() => void) | undefined;
    const server = await serve((child, frame) => {
      if (frame.body.kind !== 'request') return;
      release = () => child.reply(frame.id, { kind: 'response', status: 200, body: Buffer.from('{"slow":true}') });
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;
    const get = () => httpRequest({ host: '127.0.0.1', port, path: '/api/subscription-profiles' });

    const slow = get();
    const body = new Promise<string>((done) =>
      slow.on('response', (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => done(text));
      })
    );
    slow.end();
    await new Promise((wait) => setTimeout(wait, 200));
    release?.();
    expect(await body).toBe('{"slow":true}');
    expect(children[0].received.map((frame) => frame.body.kind)).toEqual(['request']);

    release = undefined;
    const dropped = get();
    dropped.on('error', () => {});
    dropped.end();
    await new Promise((wait) => setTimeout(wait, 100));
    dropped.destroy();
    await new Promise((wait) => setTimeout(wait, 100));
    expect(children[0].received.map((frame) => frame.body.kind)).toEqual(['request', 'request', 'cancel']);
    release?.();
  });
});

describe('the forwarder snapshot premise', () => {
  it('no server source writes HOME, the forwarded variables or the cwd', () => {
    const source = resolve(import.meta.dirname, '../../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(source);
    expect(existsSync(join(source, 'web/routes/subscription-profile-routes.ts'))).toBe(true);
    const writes =
      /process\.env\.(HOME|CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_DATA_HOME|REVERIE_DATA_DIR)\s*=(?!=)|delete process\.env\.(HOME|CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_DATA_HOME|REVERIE_DATA_DIR)|process\.chdir\(/;
    expect(files.filter((path) => writes.test(readFileSync(path, 'utf8')))).toEqual([]);
  });
});
