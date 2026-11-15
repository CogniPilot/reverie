/** Actual Session and canonical writer; no provider or broker is executed. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, NativeProviderRetirementRequiredError, ProviderDispatchUnconfirmedError } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { PROVIDER_LAUNCH_DISK_KEY } from '../src/provider-launch-publication.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import Fastify from 'fastify';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { webviewFetch } from '../src/web/webview-egress.js';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    throw Error('No provider spawn is permitted');
  }),
}));
vi.mock('../src/web/webview-egress.js', () => ({
  webviewFetch: vi.fn(() => {
    throw Error('No endpoint request is permitted');
  }),
}));
import { spawn } from 'node-pty';
let root: string;
let store: StateStore;
let file: string;
beforeEach(() => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '');
  root = mkdtempSync(join(tmpdir(), 'native-model-preflight-'));
  file = join(root, 'state.json');
  store = new StateStore(file);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function session(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  return new Session({
    workingDir: root,
    mode: 'claude',
    useMux: false,
    publicationStore: store,
    owner: 'original-owner',
    ...extra,
  });
}
async function acknowledge(original: Session, transport: 'native-ordinary' | 'local-mux' = 'native-ordinary') {
  const operation = store.stageProviderLaunch(original, {
    transport,
    ...(transport === 'native-ordinary' ? { brokerSocket: '/synthetic/original-broker' } : {}),
    current: () => original.owner === 'original-owner',
    snapshot: () => original.toPersistedState(),
  });
  const execution = {
    kind: 'mux' as const,
    sessionId: original.id,
    owner: original.owner ?? null,
    mode: original.mode,
    command: 'synthetic-not-executed',
    cwd: root,
    environment: {},
  };
  await operation.prepare(original, execution);
  operation.claim();
  operation.assertClaimed(original, execution);
  operation.settle(true);
  return { operation, execution };
}
function snapshot(original: Session) {
  return {
    saved: original.toPersistedState(),
    model: original.getCustomModelForPersist(),
    env: original.getEnvOverridesForPersist(),
    hooks: original.workspaceHookConfiguration,
    intent: store.providerLaunchDenialSelector(original),
    disk: readFileSync(file, 'utf8'),
  };
}
it.each([
  { payload: { clear: true }, busy: false },
  { payload: { clear: true }, busy: true },
  { payload: { endpointId: 'not-loaded', modelId: 'not-loaded' }, busy: false },
  { payload: { endpointId: 'not-loaded', modelId: 'not-loaded' }, busy: true },
])(
  'holds owner configuration before model, config, endpoint or restart changes (%j)',
  async ({ payload, busy: busyState }) => {
    const original = session();
    const configDir = join(root, 'selected-config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, '.claude.json'), '{"owned":"original"}');
    const hookFile = join(root, '.claude', 'settings.local.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(hookFile, '{"hooks":{"owned":"original"}}');
    original.setCustomModel(
      {
        endpointId: 'original',
        modelId: 'original-model',
        label: 'original',
        configDir,
        envKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL'],
      },
      { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: 'http://synthetic.invalid' }
    );
    await acknowledge(original);
    // Socket absence and busy/idle reports are not native retirement evidence.
    vi.stubEnv('REVERIE_WORKER_SOCKET', '');
    const before = snapshot(original);
    const changed = vi.fn();
    original.on('workspaceHookGenerationChanged', changed);
    const setModel = vi.spyOn(original, 'setCustomModel');
    const restart = vi.spyOn(original, 'restartCli');
    const stage = vi.spyOn(store, 'stageProviderLaunch');
    const busy = vi.spyOn(original, 'isBusy').mockReturnValue(busyState);
    const app = Fastify({ logger: false });
    // Only this endpoint is exercised; real Session and Store own all state.
    type RouteContext = Parameters<typeof registerSessionRoutes>[1];
    const ctx: Pick<RouteContext, 'sessions' | 'store' | 'persistSessionState' | 'persistSessionStateNow'> = {
      sessions: new Map([[original.id, original]]),
      store,
      persistSessionState: vi.fn(),
      persistSessionStateNow: vi.fn(),
    };
    registerSessionRoutes(app, ctx as unknown as RouteContext, {
      verifiedOwner: trustedFixtureOwner,
    });
    installRouteErrorHandler(app);
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/' + original.id + '/custom-model',
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: 'CONFLICT',
        reason: 'native-provider-retirement-required',
      });
      expect(response.json().error).toContain('configuration is unchanged');
      expect(snapshot(original)).toEqual(before);
      expect(readFileSync(join(configDir, '.claude.json'), 'utf8')).toBe('{"owned":"original"}');
      expect(readFileSync(hookFile, 'utf8')).toBe('{"hooks":{"owned":"original"}}');
      expect(setModel).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(busy).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(webviewFetch).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
it('direct restart denies before lifecycle, hook and publication preparation', async () => {
  const original = session();
  await acknowledge(original);
  const before = snapshot(original);
  const stage = vi.spyOn(store, 'stageProviderLaunch');
  const changed = vi.fn();
  original.on('workspaceHookGenerationChanged', changed);
  await expect(original.restartCli()).rejects.toBeInstanceOf(NativeProviderRetirementRequiredError);
  expect(snapshot(original)).toEqual(before);
  expect(stage).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
it('reloaded native history denies despite false flags and no current worker endpoint', async () => {
  const original = session();
  await acknowledge(original);
  const nextStore = new StateStore(file);
  const next = session({ id: original.id, publicationStore: nextStore, providerDispatchHeld: false });
  expect(() => next.assertRestartCliPreflight()).toThrow(NativeProviderRetirementRequiredError);
  expect(readFileSync(file, 'utf8')).toBe(snapshot(original).disk);
});
it('unconfirmed saved history denies even without a native row or worker endpoint', () => {
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {},
      [PROVIDER_LAUNCH_DISK_KEY]: {
        version: 1,
        kind: 'unconfirmed',
        rows: {},
      },
    })
  );
  const nextStore = new StateStore(file);
  const next = session({ publicationStore: nextStore, providerDispatchHeld: false });
  const before = readFileSync(file, 'utf8');
  expect(() => next.assertRestartCliPreflight()).toThrow(ProviderDispatchUnconfirmedError);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(spawn).not.toHaveBeenCalled();
});
it('keeps a known native row distinct from unconfirmed history after reload', async () => {
  const original = session();
  await acknowledge(original);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved[PROVIDER_LAUNCH_DISK_KEY].kind = 'unconfirmed';
  writeFileSync(file, JSON.stringify(saved));
  const nextStore = new StateStore(file);
  const next = session({ id: original.id, publicationStore: nextStore, providerDispatchHeld: false });
  const before = readFileSync(file, 'utf8');
  expect(() => next.assertRestartCliPreflight()).toThrow(NativeProviderRetirementRequiredError);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(spawn).not.toHaveBeenCalled();
});
it('does not replace the genuine returned-local successor admission', async () => {
  const original = session();
  const { operation } = await acknowledge(original, 'local-mux');
  expect(operation.permitsNextLocal(original)).toBe(true);
  expect(() => original.assertRestartCliPreflight()).not.toThrow();
  const next = await acknowledge(original, 'local-mux');
  expect(next.operation.permitsNextLocal(original)).toBe(true);
  expect(spawn).not.toHaveBeenCalled();
});
it('requires the actual Session store even for this denial-only read', () => {
  const original = session();
  const foreign = new StateStore(join(root, 'foreign.json'));
  expect(() => foreign.assertProviderRestartPreflight(original)).toThrow('custody');
});
