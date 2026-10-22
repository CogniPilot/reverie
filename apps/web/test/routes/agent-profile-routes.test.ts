/**
 * @fileoverview GET /api/agents/:id/profile: the read-only agent profile, built by the reverie
 * runtime's `profile` report. An injected runner stands in for the runtime, except in the
 * runner test, which runs a stub executable. Port: N/A (app.inject()).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import {
  CACHE_MS,
  profileChildEnv,
  profileRunnerFromEnv,
  registerAgentProfileRoutes,
  type ProfileRunner,
} from '../../src/web/routes/agent-profile-routes.js';
import { createMockSession } from '../mocks/index.js';

const PROFILE = { session: { id: 'test-session-1', name: 'alpha' }, runtime: { switch: { available: false } } };

let clock = 1_000_000;
async function setup(runner: ProfileRunner | null, authUser?: { username: string; role: 'admin' | 'user' }) {
  const h = await createRouteTestHarness((app, ctx) => registerAgentProfileRoutes(app, ctx, runner, () => clock), {
    authUser,
  });
  for (const id of ['other-session-2', 'other-session-3']) h.ctx.sessions.set(id, createMockSession(id) as never);
  return h;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/agents/:id/profile', () => {
  it('returns the runtime report for a known session', async () => {
    const runner = vi.fn(async () => JSON.stringify(PROFILE));
    const { app } = await setup(runner);
    const res = await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: PROFILE });
    expect(runner).toHaveBeenCalledWith('test-session-1', { includeDms: true });
  });

  it('lets an agent read only its own profile, never its direct-message rooms', async () => {
    const runner = vi.fn(async () => JSON.stringify(PROFILE));
    const { app } = await setup(runner);
    const self = await app.inject({
      method: 'GET',
      url: '/api/agents/test-session-1/profile',
      headers: { 'x-reverie-parent-session': 'test-session-1' },
    });
    expect(self.statusCode).toBe(200);
    expect(runner).toHaveBeenCalledWith('test-session-1', { includeDms: false });
    for (const header of ['other-session-2', 'not-a-session', '']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agents/test-session-1/profile',
        headers: { 'x-reverie-parent-session': header },
      });
      expect(res.statusCode, header).toBe(403);
    }
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("never serves the owner's cached report (direct-message rooms included) to an agent, nor the reverse", async () => {
    const runner = vi.fn(async (_id: string, view: { includeDms: boolean }) =>
      JSON.stringify({ ...PROFILE, rooms: view.includeDms ? ['general', 'dm-with-owner'] : ['general'] })
    );
    const { app } = await setup(runner);
    const url = '/api/agents/test-session-1/profile';
    const asOwner = await app.inject({ method: 'GET', url });
    expect(asOwner.json().data.rooms).toContain('dm-with-owner');
    const asAgent = await app.inject({ method: 'GET', url, headers: { 'x-reverie-parent-session': 'test-session-1' } });
    expect(asAgent.statusCode).toBe(200);
    expect(asAgent.json().data.rooms).toEqual(['general']);
    expect(runner).toHaveBeenLastCalledWith('test-session-1', { includeDms: false });
    // and the other order, on a fresh session id
    const agentFirst = await app.inject({
      method: 'GET',
      url: '/api/agents/other-session-2/profile',
      headers: { 'x-reverie-parent-session': 'other-session-2' },
    });
    expect(agentFirst.json().data.rooms).toEqual(['general']);
    const ownerSecond = await app.inject({ method: 'GET', url: '/api/agents/other-session-2/profile' });
    expect(ownerSecond.json().data.rooms).toContain('dm-with-owner');
  });

  it('gives the runtime only the named environment: no session id, console credentials, prefix matches, temp dir or API keys', () => {
    const env = profileChildEnv({
      PATH: '/bin',
      HOME: '/h',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: '/t',
      CLAUDE_CONFIG_DIR: '/c',
      REVERIE_RUNTIME_POLICY: '/p',
      REVERIE_API_URL: 'http://x',
      REVERIE_SESSION_ID: 'abc',
      REVERIE_USERNAME: 'admin',
      REVERIE_PASSWORD: 'secret',
      FOO_API_KEY: 'nope',
      AWS_ACCESS_KEY_ID: 'nope',
      AWS_SESSION_TOKEN: 'nope',
      REVERIE_DATA_DIR: '/d',
      REVERIE_TOKEN: 'secret',
      OPENAI_API_KEY: 'nope',
      ANTHROPIC_API_KEY: 'nope',
      AWS_SECRET_ACCESS_KEY: 'nope',
      NODE_OPTIONS: '--inspect',
    });
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'REVERIE_API_URL',
      'REVERIE_RUNTIME_POLICY',
    ]);
  });

  it('answers 404 for an unknown session without running the report', async () => {
    const runner = vi.fn(async () => JSON.stringify(PROFILE));
    const { app } = await setup(runner);
    const res = await app.inject({ method: 'GET', url: '/api/agents/nobody/profile' });
    expect(res.statusCode).toBe(404);
    expect(runner).not.toHaveBeenCalled();
  });

  it('answers 503 when the server has no runtime policy configured', async () => {
    const { app } = await setup(null);
    const res = await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('REVERIE_RUNTIME_POLICY');
  });

  it('maps the runtime error reports: a vanished session is 404, anything else 502', async () => {
    const gone = await setup(async () => JSON.stringify({ error: 'no such session', status: 404 }));
    const res = await gone.app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND', error: 'no such session' });

    const down = await setup(async () => JSON.stringify({ error: 'connection refused' }));
    const failed = await down.app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('connection refused');
  });

  it('answers 502 when the runtime fails or prints no JSON object', async () => {
    for (const runner of [
      async () => 'Traceback (most recent call last)',
      async () => '[1, 2]',
      async () => {
        throw new Error('spawn reverie-runtime ENOENT');
      },
    ] as ProfileRunner[]) {
      const { app } = await setup(runner);
      const res = await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('The reverie runtime did not return a profile');
    }
  });

  it('shares one report between concurrent requests for the same session', async () => {
    let release!: (value: string) => void;
    const runner = vi
      .fn<ProfileRunner>(async () => JSON.stringify(PROFILE))
      .mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    const { app } = await setup(runner);
    const first = app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    const second = app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    release(JSON.stringify(PROFILE));
    expect((await first).statusCode).toBe(200);
    expect((await second).json().data).toEqual(PROFILE);
    await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(runner).toHaveBeenCalledTimes(1); // a finished report is reused briefly
    clock += CACHE_MS + 1;
    await app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(runner).toHaveBeenCalledTimes(2); // and refreshed after that
  });

  it('runs at most two reports at once; a burst over many sessions waits its turn', async () => {
    const releases: Array<() => void> = [];
    const runner = vi.fn(() => new Promise<string>((resolve) => releases.push(() => resolve(JSON.stringify(PROFILE)))));
    const { app } = await setup(runner);
    const requests = ['test-session-1', 'other-session-2', 'other-session-3'].map((id) =>
      app.inject({ method: 'GET', url: `/api/agents/${id}/profile` })
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner).toHaveBeenCalledTimes(2); // the third waits
    releases.shift()!();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(3));
    while (releases.length) releases.shift()!();
    expect((await Promise.all(requests)).map((r) => r.statusCode)).toEqual([200, 200, 200]);
  });

  it('is single-user only, and still hides other users sessions in multi-user mode', async () => {
    vi.stubEnv('REVERIE_MULTIUSER', '1');
    const runner = vi.fn(async () => JSON.stringify(PROFILE));
    const stranger = await setup(runner, { username: 'someone-else', role: 'user' });
    const hidden = await stranger.app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(hidden.statusCode).toBe(404);
    const admin = await setup(runner, { username: 'admin', role: 'admin' });
    const res = await admin.app.inject({ method: 'GET', url: '/api/agents/test-session-1/profile' });
    expect(res.statusCode).toBe(501);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('profileRunnerFromEnv', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is disabled without a runtime policy', () => {
    expect(profileRunnerFromEnv({ PATH: '/usr/bin' })).toBeNull();
  });

  it('runs the configured binary with the policy, strips the parent session, and keeps an exit-1 report', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-profile-'));
    const bin = join(dir, 'reverie-runtime');
    writeFileSync(
      bin,
      '#!/bin/sh\nprintf \'{"args":"%s","parent":"%s"}\' "$*" "${REVERIE_SESSION_ID:-none}"\nexit 1\n'
    );
    chmodSync(bin, 0o755);
    const run = profileRunnerFromEnv({
      PATH: '/usr/bin:/bin',
      REVERIE_RUNTIME_POLICY: '/policy.json',
      REVERIE_RUNTIME_BIN: bin,
      REVERIE_SESSION_ID: 'some-agent',
    });
    expect(JSON.parse(await run!('abc-1', { includeDms: true }))).toEqual({
      args: '--policy /policy.json profile abc-1',
      parent: 'none',
    });
    expect(JSON.parse(await run!('abc-1', { includeDms: false })).args).toBe(
      '--policy /policy.json profile abc-1 --no-dms'
    );
  });
});
