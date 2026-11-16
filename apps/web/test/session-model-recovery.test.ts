import { acknowledgeMuxFixture } from './helpers/acknowledged-mux-fixture.js';
/**
 * @fileoverview A session's launch model survives recovery.
 *
 * `Session._model` is what becomes `claude --model <id>`: the caller's per-session `model`
 * from POST /api/sessions, or the app-wide default. It lives in memory, so it reaches a
 * relaunch after a Reverie restart or a reboot restore only if `toState()` persists it and
 * both recovery constructors hand it back. Without that, a recovered session silently
 * relaunches on the account default.
 *
 * `restoreMuxSessions()` (server.ts) cannot be reached under vitest, where
 * `reconcileSessions()` reports every pane alive, and the reboot-restore route rejects every
 * workspace before building a Session in its route tests. The two constructors are therefore
 * pinned by a source check, the same way `test/remote-wake.test.ts` pins its wiring, and the
 * round trip itself is driven through a real `Session` against the in-memory tmux layer.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

import { captureClaudeLaunch } from './helpers/capture-claude-launch.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { captureDockerEmployeeProviderLaunch } from '../src/docker-employee-provider-launch.js';
import { bindInitialLaunchAdmission } from '../src/initial-launch-admission.js';
import { shellescape } from '../src/docker-hosts.js';
import { installRecordedDockerViewer, recordedDockerViewerSocketPath } from './helpers/recorded-docker-viewer.js';
import { TmuxManager, buildSpawnCommand } from '../src/tmux-manager.js';
import type { MuxSession, RespawnPaneOptions, TerminalMultiplexer } from '../src/mux-interface.js';
import type { EffortLevel, SessionDocker } from '../src/types.js';

// Replace only the fixed readonly server query with a bounded Node child. The
// original renderer and native proof factories still run; no tmux/Docker starts.
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = (...args: Parameters<typeof actual.execFile>) => {
    const [file, argv] = args;
    if (
      file !== '/bin/tmux' ||
      !Array.isArray(argv) ||
      argv.length !== 8 ||
      argv.slice(0, 4).join('|') !== '-N|-f|/dev/null|-L' ||
      typeof argv[4] !== 'string' ||
      argv.slice(5).join('|') !== 'display-message|-p|#{pid}|#{socket_path}'
    )
      throw Error('Unexpected fixture process');
    return Reflect.apply(actual.execFile, actual, [
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', '500000|' + recordedDockerViewerSocketPath(argv[4]) + '\n'],
      ...args.slice(2),
    ]);
  };
  return { ...actual, execFile };
});

const SRC = fileURLToPath(new URL('../src', import.meta.url));

describe('the launch model survives recovery', () => {
  const workingDir = join(homedir(), 'reverie-cases', 'session-model-recovery');
  const sessions: Session[] = [];

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('persists the model in the session state', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude', model: 'claude-fable-5-1' });
    sessions.push(session);
    expect(session.toState().model).toBe('claude-fable-5-1');
  });

  it('relaunches a session rebuilt from that state on the same model', async () => {
    mkdirSync(workingDir, { recursive: true });
    const original = new Session({ workingDir, mode: 'claude', model: 'claude-fable-5-1' });
    sessions.push(original);
    const state = original.toState();

    // Rebuilt the way both recovery paths build one, from the persisted record.
    const mux = new TmuxManager();
    const createSession = vi.spyOn(mux, 'createSession');
    const rebuilt = new Session({
      id: state.id,
      workingDir,
      mode: state.mode,
      mux,
      useMux: true,
      model: state.model,
    });
    sessions.push(rebuilt);
    await rebuilt.startInteractive();

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-fable-5-1' }));
  });

  it('is handed back by both recovery constructors', () => {
    const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
    const reboot = readFileSync(join(SRC, 'web', 'routes', 'reboot-restore-routes.ts'), 'utf-8');
    expect(server).toMatch(/model:\s*savedState\?\.model,/);
    expect(reboot).toMatch(/model:\s*saved\.model,/);
  });

  it('is neither published nor persisted for a CLI that keeps its model in its own config', () => {
    // Cron hands the app-wide default (a Claude id) to every CLI that has a model at all.
    // codex never launches on the top-level field, so publishing it would report a model the
    // session never ran on, and recovery would carry that wrong value forward.
    for (const mode of ['codex', 'opencode', 'shell'] as const) {
      const session = new Session({ workingDir: '/tmp', mode, model: 'claude-fable-5-1' });
      sessions.push(session);
      expect(session.toState().model, mode).toBeUndefined();
    }
  });
});

/**
 * #514 (per-session `model` → `--model`) and #530 (`advisorModel` → the launch's ONE
 * `--settings` JSON) landed together and touch the same launch and recovery code. A claude
 * session carrying both, with or without ultracode (whose blob shares that `--settings`
 * object), must relaunch with both on every recovery path.
 */
describe('a launch model and an advisor survive recovery together', () => {
  const MODEL = 'claude-fable-5-1';
  const ADVISOR = 'opus';
  const sessions: Session[] = [];

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop();
  });

  /** The settings JSON actually received by the synthetic provider. */
  function settingsOf(cmd: string): unknown {
    const args = captureClaudeLaunch(cmd);
    expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    return JSON.parse(args[args.indexOf('--settings') + 1]);
  }

  /** Render what tmux-manager hands buildSpawnCommand for these options. */
  function launchLine(options: Pick<RespawnPaneOptions, 'sessionId' | 'model' | 'effort' | 'advisorModel'>): string {
    return buildSpawnCommand({
      mode: 'claude',
      sessionId: options.sessionId,
      model: options.model,
      effort: options.effort,
      advisorModel: options.advisorModel,
      claudeCliVersion: null,
    });
  }

  function expectBoth(cmd: string, effort: EffortLevel | undefined, boxed = false): void {
    const args = captureClaudeLaunch(cmd);
    expect(args[args.indexOf('--model') + 1]).toBe(MODEL);
    expect(cmd).not.toContain('--advisor ');
    const settings = settingsOf(cmd),
      expected = effort === 'ultracode' ? { ultracode: true, advisorModel: ADVISOR } : { advisorModel: ADVISOR };
    if (boxed) {
      expect(settings).toMatchObject(expected);
      expect(settings).toHaveProperty('hooks');
    } else expect(settings).toEqual(expected);
    if (effort && effort !== 'ultracode') expect(args[args.indexOf('--effort') + 1]).toBe(effort);
  }

  function persistedRecord(effort: EffortLevel | undefined) {
    const original = new Session({ workingDir: '/tmp', mode: 'claude', model: MODEL, advisorModel: ADVISOR, effort });
    sessions.push(original);
    const state = original.toState();
    expect(state.model).toBe(MODEL);
    expect(state.advisorModel).toBe(ADVISOR);
    return state;
  }

  it.each([['ultracode'], ['high'], [undefined]] as const)(
    'reboot restore (fresh pane) relaunches on both, effort %s',
    async (effort) => {
      const state = persistedRecord(effort);
      // The reboot-restore constructor: no muxSession, so startInteractive() creates a pane.
      const mux = new TmuxManager();
      const createSession = vi.spyOn(mux, 'createSession');
      const rebuilt = new Session({
        id: state.id,
        workingDir: '/tmp',
        mode: state.mode,
        mux,
        useMux: true,
        effort: state.effort,
        model: state.model,
        advisorModel: state.advisorModel,
      });
      sessions.push(rebuilt);
      await rebuilt.startInteractive();

      expect(createSession).toHaveBeenCalledTimes(1);
      const options = createSession.mock.calls[0][0];
      expect(options).toEqual(expect.objectContaining({ model: MODEL, advisorModel: ADVISOR, effort }));
      expectBoth(launchLine(options), effort);
    }
  );

  it.each([['ultracode'], ['high'], [undefined]] as const)(
    'restoreMuxSessions onto a dead pane respawns on both, effort %s',
    async (effort) => {
      const state = persistedRecord(effort);
      const respawns: RespawnPaneOptions[] = [];
      const subject: MuxSession = {
        muxName: 'reverie-aaaa',
        sessionId: state.id,
        owner: state.owner,
        pid: 4241,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: state.mode ?? 'claude',
        attached: false,
      };
      const registered = new Map([[subject.sessionId, subject]]);
      const mux = {
        getSession: (id: string) => registered.get(id),
        isAvailable: () => true,
        muxSessionExists: () => true,
        isPaneDead: () => true,
        setAttached: () => {},
        respawnPane: async (options: RespawnPaneOptions) => {
          respawns.push(options);
          if (options.admitted && !options.admitted()) return null;
          await acknowledgeMuxFixture(options); // The fake pane now actually dispatches.
          return 4242;
        },
      } as unknown as TerminalMultiplexer;
      // The restoreMuxSessions() constructor: an existing muxSession, whose pane is dead, so
      // startInteractive() takes the dead-pane respawn.
      const rebuilt = new Session({
        id: state.id,
        workingDir: '/tmp',
        mode: state.mode,
        mux,
        useMux: true,
        muxSession: subject,
        effort: state.effort,
        model: state.model,
        advisorModel: state.advisorModel,
      });
      sessions.push(rebuilt);
      await rebuilt.startInteractive();

      expect(respawns).toHaveLength(1);
      expect(respawns[0]).toEqual(expect.objectContaining({ model: MODEL, advisorModel: ADVISOR, effort }));
      expectBoth(launchLine(respawns[0]), effort);
    }
  );

  it('both recovery constructors hand back model, advisorModel and effort', () => {
    const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
    const reboot = readFileSync(join(SRC, 'web', 'routes', 'reboot-restore-routes.ts'), 'utf-8');
    for (const field of ['effort', 'model', 'advisorModel']) {
      expect(server).toMatch(new RegExp(`\\b${field}:\\s*savedState\\?\\.${field},`));
      expect(reboot).toMatch(new RegExp(`\\b${field}:\\s*saved\\.${field},`));
    }
  });

  it.each(['_createSession', 'respawnPane'] as const)(
    'the production legacy %s branch forwards its original model, effort and advisor',
    (methodName) => {
      // Ordinary test-mode transport intentionally skips rendering. Keep this
      // method-scoped source guard alongside the real builder consumers above;
      // global helper/call counts supply no forwarding evidence.
      const source = readFileSync(join(SRC, 'tmux-manager.ts'), 'utf8');
      const requireForwarding = (text: string) => {
        const tree = ts.createSourceFile('tmux-manager.ts', text, ts.ScriptTarget.Latest, true);
        const manager = tree.statements.find(
          (statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'TmuxManager'
        );
        if (!manager || !ts.isClassDeclaration(manager)) throw Error('Original Manager class missing');
        const method = manager.members.find(
          (member) => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName
        );
        if (!method || !ts.isMethodDeclaration(method) || !method.body) throw Error('Original Manager method missing');
        let args: ts.ObjectLiteralExpression | undefined;
        const visit = (node: ts.Node): void => {
          if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === 'baseCmd' &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === 'buildSpawnCommand' &&
            node.initializer.arguments[0] &&
            ts.isObjectLiteralExpression(node.initializer.arguments[0])
          )
            args = node.initializer.arguments[0];
          ts.forEachChild(node, visit);
        };
        visit(method.body);
        if (!args) throw Error('Original legacy launch call missing');
        for (const field of ['model', 'effort', 'advisorModel']) {
          if (
            !args.properties.some(
              (property) => ts.isShorthandPropertyAssignment(property) && property.name.text === field
            )
          )
            throw Error('Legacy ' + methodName + ' does not forward original ' + field);
        }
        return { tree, args };
      };
      const { tree, args } = requireForwarding(source);
      const model = args.properties.find(
        (property) => ts.isShorthandPropertyAssignment(property) && property.name.text === 'model'
      )!;
      const omitted = source.slice(0, model.getStart(tree)) + 'model: undefined' + source.slice(model.getEnd());
      expect(() => requireForwarding(omitted)).toThrow('does not forward original model');
    }
  );

  it.each([['ultracode'], ['high'], [undefined]] as const)(
    'the actual boxed Manager renderer carries model, advisor and effort %s to the synthetic provider',
    async (effort) => {
      const root = mkdtempSync(join(tmpdir(), 'boxed-model-render-'));
      const custody = installRecordedDockerViewer();
      custody.recordCapture();
      const state = persistedRecord(effort),
        mux = new TmuxManager();
      const operationId = '30000000-0000-4000-8000-000000000003',
        containerId = 'd'.repeat(64),
        imageId = 'sha256:' + 'c'.repeat(64);
      const docker: SessionDocker = {
        hostId: 'boxed-runtime',
        label: 'fixture',
        engine: 'docker',
        image: imageId,
        containerName: containerId,
        hostWorkspacePath: '/',
        containerWorkdir: root,
        network: 'bridge',
        mountCredentials: false,
        hooksEnabled: false,
        resumeOnStart: true,
        owned: false,
        daemonHost: 'unix:///run/reverie-engine/docker.sock',
        continuation: {
          operationId,
          employeeId: '10000000-0000-4000-8000-000000000001',
          sessionGeneration: 1,
          clientManifestDigest: '4'.repeat(64),
          apiUrl: 'http://synthetic.invalid',
        },
      };
      const session = new Session({
        ...state,
        workingDir: root,
        mode: 'claude',
        useMux: true,
        mux,
        docker,
        niceConfig: { enabled: false, niceValue: 10 },
        publicationStore: new StateStore(join(root, 'state.json')),
      });
      sessions.push(session);
      bindInitialLaunchAdmission(session, () => true);
      session.bindDockerContinuationLaunch(
        captureDockerEmployeeProviderLaunch(
          session,
          {
            version: 1,
            operationId,
            credentialId: '40000000-0000-4000-8000-000000000004',
            sessionId: session.id,
            sessionGeneration: 1,
            containerId,
            imageId,
            originalDigest: '1'.repeat(64),
            policyDigest: '2'.repeat(64),
          },
          () => {}
        )
      );
      try {
        await session.startInteractive();
        expect(custody.issued).toHaveLength(1);
        const issued = custody.issued[0]!;
        expect(issued.row).toBe(mux.getSession(session.id));
        expect(issued.command.argv.slice(0, 3)).toEqual([
          '/bin/docker',
          '--host',
          'unix:///run/reverie-engine/docker.sock',
        ]);
        const inner = issued.command.argv.at(-1)!;
        const prefix = 'export PATH=/opt/reverie-worker-client/bin:"$PATH"; printf %s ';
        expect(inner.startsWith(prefix)).toBe(true);
        const end = inner.indexOf(" | '/opt/reverie-worker-tools/bin/tmux'", prefix.length);
        expect(end).toBeGreaterThan(prefix.length);
        const literal = inner.slice(prefix.length, end);
        const source = literal.slice(1, -1).replaceAll("'\\''", "'");
        expect(shellescape(source)).toBe(literal); // Decode DATA only; execute no Docker/tmux program.
        const first = source.split('\n')[0]!;
        const words = [...first.matchAll(/"((?:[^"\\]|\\[0-7]{3})*)"/g)];
        expect(words.map((word) => word[0]).join(' ')).toBe(first);
        const argv = words.map((word) =>
          word[1]!.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
        );
        expect(argv.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'reverie-dkr-' + session.id, '-c', root]);
        expect(argv).toHaveLength(7);
        expectBoth(argv[6]!, effort, true);
        expect(session.toState()).toMatchObject({ model: MODEL, advisorModel: ADVISOR, effort });
      } finally {
        await session.stop();
        mux.destroy();
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
