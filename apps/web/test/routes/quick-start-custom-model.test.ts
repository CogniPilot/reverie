import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * @fileoverview POST /api/quick-start's `customModel` field (docs/custom-model-endpoints-plan.md):
 * the ONE-SHOT launch path that computes a custom-model endpoint's injection BEFORE the
 * session/process exists and launches directly on it, so a custom-model Run never shows
 * the native-boot-then-restart the dedicated POST /api/sessions/:id/custom-model route's
 * restart-in-place design otherwise produces — most visibly on a CLI like Codex whose TUI
 * fully reinitializes on a restart. That dedicated route is still what an ALREADY-RUNNING
 * session uses to switch later; this is the create-time equivalent.
 *
 * Mirrors test/routes/session-custom-model.test.ts's fixtures and llama-swap mocking, since
 * this route mirrors that one's own checks (llama-swap conflict, unsupported CLI, unknown
 * endpoint, an argv-incompatible model id) rather than a lighter, separately-drifting copy.
 *
 * Session.prototype.startInteractive/startShell are mocked exactly like the workspace-hooks
 * quick-start tests: quick-start constructs a REAL Session (not the MockSession the route
 * test harness substitutes elsewhere), so tmux must never actually be reached.
 *
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { rm, readFile } from 'node:fs/promises';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { createMockRouteContext, safeRmHomeTree, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { getDataDir } from '../../src/config/instance.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { Session } from '../../src/session.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { customModelConfigDir } from '../../src/custom-model-injection-apply.js';
import { webviewFetch } from '../../src/web/webview-egress.js';
import { registerCliRegistryRoutes } from '../../src/web/routes/cli-registry-routes.js';
import { installResponseEnvelope } from '../../src/web/response-envelope.js';
import { getCli } from '../../src/config/cli-registry/registry.js';
import { invalidateCliResolverCache } from '../../src/utils/cli-resolver.js';
import { buildSpawnCommandFromRegistry } from '../../src/session-cli-registry-bridge.js';
import { writeRemoteCases, writeRemoteHosts } from '../../src/remote-hosts.js';

vi.mock('../../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
    '../../src/web/webview-egress.js'
  );
  return { ...actual, webviewFetch: vi.fn() };
});
const fetchMock = vi.mocked(webviewFetch);
const fixtureAvailability = vi.hoisted(() => ({ binary: '' }));
// Keep ambient resolution inert. Only this owned executable is advertised to
// the real catalog route; the final process proof executes that same file.
vi.mock('../../src/utils/cli-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-resolver.js')>();
  return {
    ...actual,
    isCliAvailable: (id: string) =>
      id === 'hands' && fixtureAvailability.binary ? existsSync(fixtureAvailability.binary) : actual.isCliAvailable(id),
  };
});

// quick-start's own local-CLI-availability gate (resolveCliLaunchError, unrelated to the
// custom-model injection this file tests) runs BEFORE the code under test and would
// otherwise 404 every non-claude mode on a box with no codex/pi/grok/omp binary installed —
// exactly this test environment. Mirrors the real "not remote" bypass documented at its own
// call site in session-routes.ts (`session-routes.test.ts`'s remote-codex test is the
// precedent for needing this at all).
vi.mock('../../src/utils/cli-launcher.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/cli-launcher.js')>(
    '../../src/utils/cli-launcher.js'
  );
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

const ENDPOINT: CustomModelHost = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

describe('POST /api/quick-start: customModel (one-shot custom-model launch)', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let restartSpy: ReturnType<typeof vi.spyOn>;

  const quickStart = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/quick-start', payload });

  async function server(envelope = false) {
    const instance = Fastify({ logger: false });
    await instance.register(fastifyCookie);
    if (envelope) installResponseEnvelope(instance, '');
    registerSessionRoutes(instance, ctx, { verifiedOwner: trustedFixtureOwner });
    registerCliRegistryRoutes(instance, trustedFixtureOwner);
    installRouteErrorHandler(instance);
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    restartSpy = vi.spyOn(Session.prototype, 'restartCli').mockResolvedValue(true);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 })); // default: not llama-swap
    ctx = createMockRouteContext();
    app = await server();
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateCliResolverCache();
    fixtureAvailability.binary = '';
    await rm(join(getDataDir(), 'custom-model-hosts.json'), { force: true });
    await rm(join(getDataDir(), 'remote-hosts.json'), { force: true });
    await rm(join(getDataDir(), 'remote-cases.json'), { force: true });
    await rm(join(getDataDir(), 'custom-model-configs'), { recursive: true, force: true });
    safeRmHomeTree(CASES_DIR);
  });

  it('carries a catalog-only CLI endpoint selection through browser, real API and launched provider environment', async () => {
    let launchedEnv: Record<string, string> | undefined;
    // Observe the existing launch boundary, not a disk/public serializer: those
    // deliberately remove provider credentials and must continue doing so.
    vi.mocked(Session.prototype.startInteractive).mockImplementation(async function (this: Session) {
      launchedEnv = { ...(this as unknown as { _envOverrides?: Record<string, string> })._envOverrides };
    });
    const root = mkdtempSync(join(tmpdir(), 'catalog-endpoint-'));
    const binary = join(root, 'reverie-hands');
    const log = join(root, 'argv.json');
    writeFileSync(
      binary,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify({args:process.argv.slice(2),base:process.env.REVERIE_HANDS_BASE_URL,model:process.env.REVERIE_HANDS_MODEL,key:process.env.REVERIE_HANDS_API_KEY}));`
    );
    chmodSync(binary, 0o700);
    fixtureAvailability.binary = binary;
    invalidateCliResolverCache();
    await app.close();
    app = await server(true);
    const catalog = (await app.inject('/api/clis')).json().data;
    expect(catalog.find((entry: { id: string }) => entry.id === 'hands')).toMatchObject({
      enabled: true,
      installed: true,
      supportsCustomModel: true,
    });
    expect(JSON.stringify(catalog)).not.toMatch(/apiKey|envOverrides|customModelInjection/);
    const dom = new JSDOM(
      `<!doctype html><select id="quickStartCase"><option selected>cm-catalog</option></select>
      <input id="tabCount" value="1"><button id="runBtn"></button><div id="runModeMenu"></div>`,
      { url: 'http://localhost/', runScripts: 'dangerously' }
    );
    try {
      const win = dom.window as any;
      win.eval('window.ReverieApp = function() {};');
      win.__reverieCliCatalog = catalog;
      for (const name of ['constants', 'session-ui']) {
        win.eval(readFileSync(new URL(`../../src/web/public/${name}.js`, import.meta.url), 'utf8'));
      }
      const browser = new win.ReverieApp();
      Object.assign(browser, {
        cases: [{ name: 'cm-catalog' }],
        terminal: { focus() {} },
        _runMinLockMs: 0,
        loadAppSettingsFromStorage: () => ({}),
        getCaseSettings: () => ({}),
        buildEnvOverrides: () => ({}),
        isCliAvailable: (id: string) =>
          catalog.some((entry: any) => entry.id === id && entry.enabled && entry.installed),
        _beginSessionLaunchStatus: () => 'synthetic-status',
        _reportSessionLaunchError: (_token: unknown, message: string) => {
          throw Error(message);
        },
        _ensureCreatedSessionVisible: async () => {},
        selectSession: async () => {},
        _nextCaseSessionStartNumber: () => 1,
      });
      const requests: any[] = [];
      win.fetch = async (url: string, options: { body: string }) => {
        expect(url).toBe('/api/quick-start');
        const payload = JSON.parse(options.body);
        requests.push(payload);
        const response = await app.inject({ method: 'POST', url, payload });
        expect(response.statusCode, response.body).toBe(200);
        return { json: () => response.json() };
      };
      await browser.runCustomModelEntry('hands', ENDPOINT.id, 'synthetic-model');
      expect(requests).toHaveLength(1);
      expect(requests[0].customModel).toEqual({ endpointId: ENDPOINT.id, modelId: 'synthetic-model' });
      expect(Session.prototype.startInteractive).toHaveBeenCalledTimes(1);
      const session = [...ctx.sessions.values()].find((current) => current.mode === 'hands') as unknown as Session;
      expect(session.customModel?.modelId).toBe('synthetic-model');
      const command = buildSpawnCommandFromRegistry(getCli('hands')!, { mode: 'hands', sessionId: session.id });
      expect(command).toBeTruthy();
      const result = spawnSync('/bin/sh', ['-c', command!], {
        encoding: 'utf8',
        timeout: 5000,
        env: { PATH: root, FIXTURE_CALLS: log, ...launchedEnv },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({
        args: [],
        base: ENDPOINT.baseUrl + '/v1',
        model: 'synthetic-model',
        key: ENDPOINT.apiKey,
      });
      expect(restartSpy).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the explicitly selected Claude hire model ahead of the app-wide launch default', async () => {
    ctx.getModelConfig.mockResolvedValue({ defaultModel: 'sonnet' });
    const response = await quickStart({ caseName: 'explicit-hire-model', mode: 'claude', modelOverride: 'opus' });
    expect(response.statusCode).toBe(200);
    const session = ctx.sessions.get(response.json().sessionId) as unknown as Session;
    expect(session.displayModel).toEqual({ model: 'opus', source: 'launch' });
  });

  it('launches a claude session already pointed at the endpoint — no restart at all', async () => {
    const res = await quickStart({
      caseName: 'cm-claude',
      mode: 'claude',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.customModel).toEqual({ endpointId: 'ep1', modelId: 'qwen3', label: 'llama.cpp box' });
    // The whole point: never restarted. It launched on the endpoint the first time.
    expect(restartSpy).not.toHaveBeenCalled();

    const isolatedDir = customModelConfigDir(sessionId);
    const trustFile = JSON.parse(await readFile(join(isolatedDir, '.claude.json'), 'utf-8'));
    expect(trustFile.customApiKeyResponses.approved).toEqual(['k']);
  });

  it('codex: writes the config.toml under the SAME id the session actually launches with, no restart', async () => {
    const res = await quickStart({
      caseName: 'cm-codex',
      mode: 'codex',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.customModel?.endpointId).toBe('ep1');
    expect(restartSpy).not.toHaveBeenCalled();

    const configDir = customModelConfigDir(sessionId);
    expect(existsSync(join(configDir, 'config.toml'))).toBe(true);
    const toml = await readFile(join(configDir, 'config.toml'), 'utf-8');
    expect(toml).toContain('model = "qwen3"');
  });

  it('pi: forces --model custom/<id> onto piConfig on the FIRST launch, not via a later restart', async () => {
    const res = await quickStart({
      caseName: 'cm-pi',
      mode: 'pi',
      customModel: { endpointId: 'ep1', modelId: 'qwen3.5-0.8b' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session & { piConfig?: { model?: string } };
    expect(session.getCustomModelForPersist()?.launchModel).toBe('custom/qwen3.5-0.8b');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('grok: forces the [model.<name>] block name onto grokConfig on the first launch', async () => {
    const res = await quickStart({
      caseName: 'cm-grok',
      mode: 'grok',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.getCustomModelForPersist()?.launchModel).toBe('reverie-custom');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('omp: forces custom/<id> onto ompConfig even with no incoming ompConfig at all', async () => {
    const res = await quickStart({
      caseName: 'cm-omp',
      mode: 'omp',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.getCustomModelForPersist()?.launchModel).toBe('custom/qwen3');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('404s for an unknown endpoint id', async () => {
    const res = await quickStart({
      caseName: 'cm-ghost',
      mode: 'claude',
      customModel: { endpointId: 'ghost', modelId: 'qwen3' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('NOT_FOUND');
  });

  it('refuses a mode with no known custom-model mechanism (antigravity)', async () => {
    const before = [...ctx.sessions.keys()];
    const res = await quickStart({
      caseName: 'cm-agy',
      mode: 'antigravity',
      supportsCustomModel: true, // A forged browser capability cannot authorize the server's recipe.
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect([...ctx.sessions.keys()]).toEqual(before);
    expect(Session.prototype.startInteractive).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('refuses a missing CLI descriptor before creating or starting a provider', async () => {
    const before = [...ctx.sessions.keys()];
    const response = await quickStart({
      caseName: 'cm-unknown-cli',
      mode: 'missing-cli',
      customModel: { endpointId: ENDPOINT.id, modelId: 'synthetic-model' },
    });
    expect(response.json().success).toBe(false);
    expect([...ctx.sessions.keys()]).toEqual(before);
    expect(Session.prototype.startInteractive).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('refuses a model id the CLI cannot carry on its command line, cleaning up any written config dir', async () => {
    const res = await quickStart({
      caseName: 'cm-badmodel',
      mode: 'pi',
      customModel: { endpointId: 'ep1', modelId: 'qwen 3 with spaces' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
  });

  it('refuses customModel for a remote case', async () => {
    await writeRemoteHosts(getDataDir(), [{
      id: 'synthetic-remote', label: 'Synthetic remote', host: '192.0.2.1', username: 'synthetic',
    }]);
    await writeRemoteCases(getDataDir(), [{
      name: 'cm-remote', type: 'remote', hostId: 'synthetic-remote', remotePath: '/synthetic/case',
    }]);
    const before = [...ctx.sessions.keys()];
    const res = await quickStart({
      caseName: 'cm-remote',
      mode: 'claude',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });
    expect(res.json()).toMatchObject({success: false, errorCode: 'INVALID_INPUT'});
    expect(res.json().error).toContain('not supported for remote cases');
    expect([...ctx.sessions.keys()]).toEqual(before);
    expect(Session.prototype.startInteractive).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  describe('llama-swap conflict check', () => {
    function mockRunning(running: Array<{ model: string; state: string }>) {
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') return new Response(JSON.stringify({ running }), { status: 200 });
        throw new Error(`unexpected request in this test: ${url.href}`);
      });
    }

    it('asks for confirmation instead of launching when another live session is using the currently loaded model', async () => {
      const other = ctx.sessions.get('test-session-1')!;
      (other as unknown as { customModel: unknown }).customModel = { endpointId: 'ep1', modelId: 'llama3' };
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await quickStart({
        caseName: 'cm-conflict',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      const body = res.json();
      expect(body.requiresConfirmation).toBe(true);
      expect(body.currentlyLoadedModel).toBe('llama3');
      expect(body.affectedSessions).toEqual([{ id: 'test-session-1', name: other.name }]);
      // Nothing was actually created.
      expect(ctx.sessions.size).toBe(1);
    });

    it('launches once confirmed, skipping the conflict check', async () => {
      const other = ctx.sessions.get('test-session-1')!;
      (other as unknown as { customModel: unknown }).customModel = { endpointId: 'ep1', modelId: 'llama3' };
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await quickStart({
        caseName: 'cm-confirmed',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3', confirmed: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresConfirmation).toBeUndefined();
      expect(ctx.sessions.size).toBe(2);
    });

    it('launches straight away when nothing else is using the currently loaded model', async () => {
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await quickStart({
        caseName: 'cm-noconflict',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresConfirmation).toBeUndefined();
    });
  });

  describe("context-window floor warning (this CLI's own overhead can exceed a small model's real context)", () => {
    const SMALL_CTX_ENDPOINT: CustomModelHost = {
      id: 'ep-small',
      label: 'tiny box',
      baseUrl: 'http://192.168.1.51:8080',
      apiKey: 'k',
      modelContextLengths: { 'qwen3.8-27b-ud-q4_k_xl': 16384 },
    };

    it('warns instead of launching when the discovered context is below the safe floor', async () => {
      await writeCustomModelHosts(getDataDir(), [ENDPOINT, SMALL_CTX_ENDPOINT]);

      const res = await quickStart({
        caseName: 'cm-small-ctx',
        mode: 'claude',
        customModel: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl' },
      });

      const body = res.json();
      expect(body.requiresContextWarning).toBe(true);
      expect(body.modelId).toBe('qwen3.8-27b-ud-q4_k_xl');
      expect(body.contextLength).toBe(16384);
      expect(body.minSafeContextTokens).toBe(40000);
      // Nothing was actually created.
      expect(ctx.sessions.size).toBe(1);
    });

    it('launches once confirmed, skipping the context check', async () => {
      await writeCustomModelHosts(getDataDir(), [ENDPOINT, SMALL_CTX_ENDPOINT]);

      const res = await quickStart({
        caseName: 'cm-small-ctx-confirmed',
        mode: 'claude',
        customModel: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl', confirmed: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresContextWarning).toBeUndefined();
      expect(ctx.sessions.size).toBe(2);
    });

    it('does not warn when nothing about context was discovered', async () => {
      const res = await quickStart({
        caseName: 'cm-no-ctx-data',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresContextWarning).toBeUndefined();
    });
  });

  describe('triggering the actual llama-swap load (not just watching for it)', () => {
    it('sends a real inference request naming the target model, concurrently with launching the session', async () => {
      const chatCalls: unknown[] = [];
      fetchMock.mockImplementation(async (url: URL, init?: { body?: unknown }) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'llama3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalls.push(JSON.parse(init!.body as string));
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      const res = await quickStart({
        caseName: 'cm-trigger',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget trigger settle

      expect(res.statusCode).toBe(200);
      expect(res.json().modelSwapInProgress).toBe(true);
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]).toMatchObject({ model: 'qwen3', max_tokens: 1 });
    });

    it('never sends a load-trigger request when the target model is already loaded and ready', async () => {
      let chatCalled = false;
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'qwen3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalled = true;
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      const res = await quickStart({
        caseName: 'cm-no-trigger',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.json().modelSwapInProgress).toBe(false);
      expect(chatCalled).toBe(false);
    });
  });
});
