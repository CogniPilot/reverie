import { acknowledgeMuxFixture } from './helpers/acknowledged-mux-fixture.js';
import { initialLaunchAdmitted } from '../src/initial-launch-admission.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { WebServer } from '../src/web/server.js';
import { agentSpawn, EXIT, httpRequest, type ApiResponse } from '../src/cli-agent.js';
import { getCli, registryFilePath, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import type { Session } from '../src/session.js';

// Only discovery is synthetic. The HTTP client, server, constructor and test PTY startup are real.
vi.mock('../src/utils/cli-resolver.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-resolver.js')>()),
  isCliAvailable: () => true,
  resolveCliBinDir: () => '/usr/bin',
  missingCliMessage: () => null,
}));
let server: WebServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
});

it('carries a compatible custom legacy codec from the headless CLI through HTTP into the actual Session', async () => {
  const custom = structuredClone(getCli('codex')!);
  custom.id = 'custom-codex' as typeof custom.id;
  mkdirSync(dirname(registryFilePath()), { recursive: true });
  writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis: { 'custom-codex': custom } }), {
    mode: 0o600,
  });
  reloadCliRegistry();
  expect(getCli('custom-codex')).toBeDefined();
  server = new WebServer(0, false, true);
  await server.start();
  const base = `http://127.0.0.1:${server.boundPort}`;
  const workingDir = join(homedir(), 'owned-cli-parent');
  mkdirSync(workingDir, { recursive: true });
  const actorResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'claude', workingDir }),
  });
  const actor = (await actorResponse.json()).data.session.id as string;
  const responses: ApiResponse[] = [];
  const code = await agentSpawn(
    {
      ctx: { selfId: actor, apiUrl: base },
      json: false,
      io: { out: () => {}, err: () => {} },
      request: async (ctx, options) => {
        const response = await httpRequest(ctx, options);
        responses.push(response);
        return response;
      },
    },
    {
      caseName: 'owned-custom-codex',
      mode: 'custom-codex',
      ready: false,
      timeoutMs: 1000,
      reasoningEffort: 'high',
      bypassApprovals: true,
      resumeSessionId: actor,
    }
  );
  expect(code, JSON.stringify(responses)).toBe(EXIT.ok);
  const sid = (responses[0].json?.data as { sessionId: string }).sessionId;
  const session = (server as unknown as { sessions: Map<string, Session> }).sessions.get(sid)!;
  expect(session.mode).toBe('custom-codex');
  expect(session.toState().codexConfig).toMatchObject({
    reasoningEffort: 'high',
    dangerouslyBypassApprovals: true,
    resumeSessionId: actor,
  });
  expect(session.parentSessionId).toBe(actor);
  custom.launch.variants[0].args.push({ lit: '--later-explicit-operation' });
  writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis: { 'custom-codex': custom } }), {
    mode: 0o600,
  });
  reloadCliRegistry();
  expect(initialLaunchAdmitted(session)).toBe(true); // Genuine completed initial dispatch ended only this continuation.
});

it.each(['interactive', 'shell'] as const)(
  'retains original create admission across later initial %s startup and observed ABA',
  async (action) => {
    const custom = structuredClone(getCli('codex')!);
    custom.id = 'custom-codex' as typeof custom.id;
    const publish = () => {
      mkdirSync(dirname(registryFilePath()), { recursive: true });
      writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis: { 'custom-codex': custom } }), {
        mode: 0o600,
      });
      reloadCliRegistry();
    };
    publish();
    server = new WebServer(0, false, true);
    await server.start();
    const base = `http://127.0.0.1:${server.boundPort}`;
    const workingDir = join(homedir(), `owned-initial-${action}`);
    mkdirSync(workingDir, { recursive: true });
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'custom-codex', workingDir }),
    });
    const sid = (await created.json()).data.session.id as string;
    const mux = (server as unknown as { mux: TmuxManager }).mux;
    const spawn = vi.spyOn(mux, 'createSession');
    custom.launch.variants[0].args.push({ lit: '--changed-protocol' });
    publish();
    const start = () =>
      fetch(`${base}/api/sessions/${sid}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    const refused = await start();
    expect((await refused.json()).success).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    custom.launch.variants[0].args.pop();
    publish();
    const stillRefused = await start();
    expect((await stillRefused.json()).success).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect((server as unknown as { sessions: Map<string, Session> }).sessions.get(sid)?.pid).toBeNull();
  }
);

it('retains initial admission after an actual Session observes uncertain provider dispatch', async () => {
  const custom = structuredClone(getCli('codex')!);
  custom.id = 'custom-codex' as typeof custom.id;
  const publish = () => {
    mkdirSync(dirname(registryFilePath()), { recursive: true });
    writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis: { 'custom-codex': custom } }), {
      mode: 0o600,
    });
    reloadCliRegistry();
  };
  publish();
  server = new WebServer(0, false, true);
  await server.start();
  const base = `http://127.0.0.1:${server.boundPort}`;
  const workingDir = join(homedir(), 'owned-uncertain-initial');
  mkdirSync(workingDir, { recursive: true });
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'custom-codex', workingDir }),
  });
  const sid = (await created.json()).data.session.id as string;
  const session = (server as unknown as { sessions: Map<string, Session> }).sessions.get(sid)!;
  const mux = (server as unknown as { mux: TmuxManager }).mux;
  const spawn = vi.spyOn(mux, 'createSession').mockImplementation(async (options) => {
    await acknowledgeMuxFixture(options);
    throw new Error('Synthetic provider effect answer lost');
  });
  const start = () =>
    fetch(`${base}/api/sessions/${sid}/interactive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  const response = await start();
  expect((await response.json()).success).toBe(false);
  expect(session.providerDispatchHeld).toBe(true);
  expect(spawn).toHaveBeenCalledOnce();
  custom.launch.variants[0].args.push({ lit: '--changed-after-unknown' });
  publish();
  expect(initialLaunchAdmitted(session)).toBe(false);
  const repeated = await start();
  expect((await repeated.json()).success).toBe(false);
  expect(spawn).toHaveBeenCalledOnce();
});
