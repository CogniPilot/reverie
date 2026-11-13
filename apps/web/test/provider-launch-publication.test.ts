/** Actual Session + canonical state file, with only the physical PTY replaced. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Session, ProviderDispatchUnconfirmedError } from '../src/session.js';
import { StateStore, StatePublicationUnconfirmedError, AcknowledgedStateWriteError } from '../src/state-store.js';
import * as storeModule from '../src/state-store.js';
import { SessionManager } from '../src/session-manager.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { CreateSessionOptions } from '../src/mux-interface.js';
import { prepareWorkspaceHooks } from '../src/workspace-hook-policy.js';
import {
  PROVIDER_LAUNCH_DISK_KEY,
  stageProviderLaunch,
  decodeProviderLaunchIntents,
  type ProviderLaunchIntent,
  type ProviderLaunchPublication,
  type ProviderLaunchExecution,
} from '../src/provider-launch-publication.js';
import { workerLaunchCommand, workerPtyCommand } from '../src/worker-execution.js';

const transport = vi.hoisted(() => ({ before: () => {}, exits: [] as Array<(event: { exitCode: number }) => void> }));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    transport.before();
    return {
      pid: 999_999_997,
      onData: vi.fn(),
      onExit: (callback: (event: { exitCode: number }) => void) => {
        transport.exits.push(callback);
        return { dispose() {} };
      },
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
    };
  }),
}));
vi.mock('../src/utils/claude-cli-resolver.js', async (original) => ({
  ...(await original<typeof import('../src/utils/claude-cli-resolver.js')>()),
  getClaudeBinaryPath: () => process.execPath,
  getClaudeCliVersion: () => 'synthetic',
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    closeSync: vi.fn(actual.closeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
import { spawn } from 'node-pty';
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const actualAsync = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let root: string, file: string, store: StateStore;
const sessions: Session[] = [];
beforeEach(() => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '');
  root = fs.mkdtempSync(join(tmpdir(), 'provider-publication-'));
  file = join(root, 'state.json');
  store = new StateStore(file);
  transport.before = () => {};
  transport.exits.length = 0;
  vi.mocked(spawn).mockClear();
});
afterEach(async () => {
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
  vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
  vi.mocked(asyncFs.rename).mockImplementation(actualAsync.rename);
  for (const session of sessions.splice(0)) await session.stop(false);
  if (!store.statePublicationHeld) await store.saveNowAsync();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function session(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const result = new Session({
    workingDir: root,
    mode: 'shell',
    useMux: false,
    publicationStore: store,
    owner: 'original-owner',
    ...extra,
  });
  sessions.push(result);
  return result;
}
function disk() {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as {
    sessions: Record<string, ReturnType<Session['toPersistedState']> & { __envOverrides?: Record<string, string> }>;
    [PROVIDER_LAUNCH_DISK_KEY]: {
      version: 1;
      kind: 'observed' | 'unconfirmed';
      rows: Record<string, ProviderLaunchIntent>;
    };
  };
}

it('acknowledges the original intent and private full snapshot BEFORE the direct shell spawn', async () => {
  const original = session({ envOverrides: { CLAUDE_CONFIG_DIR: '/synthetic/original-account' } });
  transport.before = () => {
    expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id]).toMatchObject({
      version: 1,
      phase: 'dispatch-intent',
      sessionId: original.id,
      owner: 'original-owner',
      mode: 'shell',
      transport: 'local-pty',
    });
    expect(disk().sessions[original.id].__envOverrides).toEqual({ CLAUDE_CONFIG_DIR: '/synthetic/original-account' });
  };
  await original.startShell();
  expect(spawn).toHaveBeenCalledOnce();
  expect(Object.hasOwn(store.getState(), PROVIDER_LAUNCH_DISK_KEY)).toBe(false);
  expect(Object.hasOwn(original.toState(), '__envOverrides')).toBe(false);
});

it('keeps a deleted public row denied on reload and refuses a new same-SID object or false flags', async () => {
  const original = session();
  await original.startShell();
  const intent = disk()[PROVIDER_LAUNCH_DISK_KEY];
  store.removeSession(original.id);
  store.reset();
  await store.saveNowAsync();
  expect(disk()[PROVIDER_LAUNCH_DISK_KEY]).toEqual(intent);
  expect(disk().sessions[original.id]).toBeUndefined();
  const restoredStore = new StateStore(file);
  const successor = session({ id: original.id, publicationStore: restoredStore, providerDispatchHeld: false });
  expect(successor.providerDispatchHeld).toBe(true);
  await expect(successor.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(spawn).toHaveBeenCalledOnce();
  expect(Object.hasOwn(restoredStore.getState(), PROVIDER_LAUNCH_DISK_KEY)).toBe(false);
});

it('checks the original owner at queue execution rather than before an older write completes', async () => {
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
    entered();
    await held;
    return actualAsync.rename(from, to);
  });
  store.setConfig({ maxConcurrentSessions: 8 });
  const older = store.saveNowAsync();
  await arrived;
  const original = session();
  const start = original.startShell();
  original.owner = 'replacement-owner';
  release();
  await older;
  await expect(start).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
  expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id]).toBeUndefined();
});

it.each(['rename-reply', 'directory-close'] as const)(
  'never dispatches or refunds an uncertain %s acknowledgement',
  async (fault) => {
    const original = session();
    if (fault === 'rename-reply')
      vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
        actual.renameSync(from, to);
        throw new Error('synthetic lost acknowledgement');
      });
    if (fault === 'directory-close') {
      let count = 0;
      vi.mocked(fs.closeSync).mockImplementation((fd) => {
        actual.closeSync(fd);
        if (++count === 2) throw new Error('synthetic consumed directory close');
      });
    }
    await expect(original.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
    expect(store.statePublicationHeld).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    const before = fs.readFileSync(file, 'utf8');
    expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id].phase).toBe('dispatch-intent');
    await expect(store.saveNowAsync()).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const successor = session({ id: original.id, publicationStore: new StateStore(file) });
    expect(successor.providerDispatchHeld).toBe(true);
  }
);

it.each(['sync', 'async'] as const)(
  'a failing logger cannot replace an ambiguous ordinary %s writer fence',
  async (kind) => {
    const original = session();
    await original.startShell();
    for (const exit of transport.exits.splice(0)) exit({ exitCode: 0 });
    const rows = disk()[PROVIDER_LAUNCH_DISK_KEY];
    const fault = new Error('synthetic lost ordinary rename acknowledgement');
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('synthetic logger failed');
    });
    store.setConfig({ maxConcurrentSessions: 7 });
    if (kind === 'sync') {
      vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
        actual.renameSync(from, to);
        throw fault;
      });
      expect(() => store.saveNow()).toThrow(StatePublicationUnconfirmedError);
    } else {
      vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
        await actualAsync.rename(from, to);
        throw fault;
      });
      await expect(store.saveNowAsync()).rejects.toBeInstanceOf(StatePublicationUnconfirmedError);
    }
    expect(store.statePublicationHeld).toBe(true);
    expect(disk()[PROVIDER_LAUNCH_DISK_KEY]).toEqual(rows);
    await expect(store.saveNowAsync()).rejects.toMatchObject({ code: 'STATE_PUBLICATION_UNCONFIRMED' });
    const retained = await store.saveNowAsync().catch((error: unknown) => error);
    expect((retained as StatePublicationUnconfirmedError).getPrivateEvidenceForReconciliation()).toMatchObject({
      error: fault,
    });
    expect(spawn).toHaveBeenCalledOnce();
  }
);

it('uses the SAME acknowledged UUID and original native endpoint, without changing viewer or protected selectors', async () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic/original-broker');
  const original = session();
  const operation = store.stageProviderLaunch(original, {
    transport: 'native-ordinary',
    brokerSocket: process.env.REVERIE_WORKER_SOCKET,
    current: () => original.owner === 'original-owner',
    snapshot: () => original.toPersistedState(),
  });
  const selection = operation.nativeSelection()!;
  const command = workerLaunchCommand('fixed-command', root, original.id, false, undefined, operation);
  expect(command).toContain(`--attempt-id '${selection.attemptId}'`);
  expect(command).toContain("REVERIE_WORKER_SOCKET='/synthetic/original-broker'");
  const pty = workerPtyCommand('fixed-program', [], root, original.id, operation);
  expect(pty.args.slice(0, 2)).toEqual(['--attempt-id', selection.attemptId]);
  expect(pty.env).toEqual({ REVERIE_WORKER_SOCKET: '/synthetic/original-broker' });
  const execution: ProviderLaunchExecution = {
    kind: 'mux',
    sessionId: original.id,
    owner: original.owner ?? null,
    mode: original.mode,
    command,
    cwd: root,
    environment: {},
  };
  await operation.prepare(original, execution);
  expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id].attemptId).toBe(selection.attemptId);
  operation.claim();
  operation.assertClaimed(original, execution);
  operation.settle(true);
  const next = store.stageProviderLaunch(original, {
    transport: 'native-ordinary',
    brokerSocket: process.env.REVERIE_WORKER_SOCKET,
    current: () => true,
    snapshot: () => original.toPersistedState(),
  });
  await expect(next.prepare(original, execution)).rejects.toThrow('unresolved');
  expect(workerLaunchCommand('fixed-command', root, original.id, true)).not.toContain('--attempt-id');
  expect(() => workerLaunchCommand('fixed-command', root, original.id, true, undefined, operation)).toThrow();
});

it('gives bare runPrompt the same before-effect receipt', async () => {
  const original = session({ mode: 'claude' });
  let entered!: () => void;
  const spawned = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.before = () => {
    expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id]).toMatchObject({
      mode: 'claude',
      transport: 'local-pty',
    });
    entered();
  };
  const result = original.runPrompt('synthetic prompt').then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error })
  );
  await Promise.race([
    spawned,
    result.then((outcome) => {
      throw new Error('Prompt ended before physical dispatch: ' + String(outcome.error));
    }),
  ]);
  expect(spawn).toHaveBeenCalledOnce();
  for (const exit of transport.exits) exit({ exitCode: 0 });
  const outcome = await result;
  expect(outcome.error).toBeUndefined();
});

it('wires the actual default SessionManager constructor and sendInput consumer to the canonical writer', async () => {
  vi.spyOn(storeModule, 'getStore').mockReturnValue(store); // Actual StateStore, never a receipt/noop stub.
  const manager = new SessionManager();
  const original = await manager.createSession(root);
  sessions.push(original);
  let entered!: () => void;
  const spawned = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.before = () => {
    expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id].sessionId).toBe(original.id);
    entered();
  };
  const failed = new Promise<never>((_, reject) =>
    manager.once('sessionError', (_id, message) => reject(new Error(String(message))))
  );
  await manager.sendToSession(original.id, 'synthetic manager prompt');
  await Promise.race([spawned, failed]);
  expect(spawn).toHaveBeenCalledOnce();
  for (const exit of transport.exits) exit({ exitCode: 0 });
});

function plan(original: Session) {
  return {
    subject: original,
    sessionId: original.id,
    owner: original.owner ?? null,
    mode: original.mode,
    workingDir: root,
    transport: 'local-pty' as const,
    current: () => true,
    snapshot: () => original.toPersistedState(),
  };
}
function execution(original: Session): ProviderLaunchExecution {
  return {
    kind: 'pty',
    sessionId: original.id,
    owner: original.owner ?? null,
    mode: original.mode,
    command: 'synthetic-exact-command',
    cwd: root,
    environment: {},
  };
}
it.each(['noop', 'counterfeit'] as const)(
  'a public staging factory with %s writer cannot arm any provider effect',
  async (kind) => {
    const original = session();
    let called = 0;
    const operation = stageProviderLaunch(plan(original), async () => {
      called++;
      return kind === 'noop' ? undefined : Object.freeze({});
    });
    await expect(operation.prepare(original, execution(original))).rejects.toThrow('Canonical durable');
    expect(called).toBe(1);
    expect(() => operation.claim()).toThrow();
    expect(() => operation.assertClaimed(original, execution(original))).toThrow();
    expect(fs.existsSync(file)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  }
);
it('a genuine acknowledgement cannot be borrowed by another operation or consumed twice', async () => {
  const original = session();
  let captured: unknown;
  const port = store as unknown as {
    commitProviderLaunch(s: Session, o: ProviderLaunchPublication, r: ProviderLaunchIntent): Promise<object>;
  };
  const commit = port.commitProviderLaunch.bind(store);
  vi.spyOn(port, 'commitProviderLaunch').mockImplementation(async (...args) => {
    const ack = await commit(...args);
    captured = ack;
    return ack;
  });
  const first = store.stageProviderLaunch(original, {
    transport: 'local-pty',
    current: () => true,
    snapshot: () => original.toPersistedState(),
  });
  const actual = execution(original);
  await first.prepare(original, actual);
  const stolen = stageProviderLaunch(plan(original), async () => captured);
  await expect(stolen.prepare(original, actual)).rejects.toThrow('Canonical durable');
  first.claim();
  first.assertClaimed(original, actual);
  expect(() => first.claim()).toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
it('keeps a refusal before preparation terminal without inventing uncertain dispatch', async () => {
  const original = session();
  const source = { transport: 'local-pty' as const, current: () => true, snapshot: () => original.toPersistedState() };
  const refused = store.stageProviderLaunch(original, source);
  refused.settle(false);
  expect(refused.fenced).toBe(false);
  expect(() => refused.claim()).toThrow();
  expect(() => refused.assertCurrent()).toThrow();
  await expect(refused.prepare(original, execution(original))).rejects.toThrow();
  expect(refused.fenced).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  const next = store.stageProviderLaunch(original, source);
  await next.prepare(original, execution(original));
  next.claim();
  next.assertClaimed(original, execution(original));
  expect(spawn).not.toHaveBeenCalled();
});
it('never turns a prepared but unclaimed intent into a pre-preparation refusal', async () => {
  const original = session();
  const source = { transport: 'local-pty' as const, current: () => true, snapshot: () => original.toPersistedState() };
  const prepared = store.stageProviderLaunch(original, source);
  await prepared.prepare(original, execution(original));
  prepared.settle(false);
  expect(prepared.fenced).toBe(true);
  expect(() => prepared.claim()).toThrow();
  const next = store.stageProviderLaunch(original, source);
  await expect(next.prepare(original, execution(original))).rejects.toThrow('earlier provider launch intent');
  expect(spawn).not.toHaveBeenCalled();
});
it.each([{ value: ['local-pty'] }, { value: null }, { value: 0 }, { value: false }, { value: {} }])(
  'rejects non-string transport $value without coercing saved data',
  async ({ value: transportValue }) => {
    const original = session();
    await original.startShell();
    const rows = disk()[PROVIDER_LAUNCH_DISK_KEY].rows;
    expect(() =>
      decodeProviderLaunchIntents({ ...rows, [original.id]: { ...rows[original.id], transport: transportValue } })
    ).toThrow();
  }
);
it('keeps pre-rename projections and consuming-close errors private under ordinary inspection and logging', async () => {
  const marker = 'PRIVATE_PROVIDER_STATE_' + Date.now();
  const original = session({ envOverrides: { CLAUDE_CONFIG_DIR: marker } });
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
    throw new Error('synthetic pre-rename failure');
  });
  vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
    actual.closeSync(fd);
    throw new Error('synthetic consuming close');
  });
  const operation = store.stageProviderLaunch(original, {
    transport: 'local-pty',
    current: () => true,
    snapshot: () => original.toPersistedState(),
  });
  const failure = await operation.prepare(original, execution(original)).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AcknowledgedStateWriteError);
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  console.error(failure);
  expect(inspect(failure)).not.toContain(marker);
  expect(JSON.stringify(failure)).not.toContain(marker);
  expect(inspect(logs.mock.calls)).not.toContain(marker);
  expect(JSON.stringify((failure as AcknowledgedStateWriteError).getPrivateEvidenceForReconciliation())).toContain(
    marker
  );
  expect(spawn).not.toHaveBeenCalled();
});
it('SessionManager updates retain only store-owned respawn fields and allow authoritative explicit clear', async () => {
  vi.spyOn(storeModule, 'getStore').mockReturnValue(store);
  const manager = new SessionManager();
  const original = await manager.createSession(root);
  sessions.push(original);
  const respawn: NonNullable<ReturnType<Session['toState']>['respawnConfig']> = {
    enabled: true,
    idleTimeoutMs: 2345,
    updatePrompt: 'synthetic update',
    interStepDelayMs: 1000,
    sendClear: true,
    sendInit: true,
  };
  store.setSession(original.id, {
    ...original.toPersistedState(),
    respawnConfig: respawn,
    respawnEnabled: true,
    __envOverrides: { CLAUDE_CONFIG_DIR: 'stale-private' },
  } as ReturnType<Session['toState']>);
  original.emit('output', 'synthetic update');
  expect(store.getSession(original.id)).toMatchObject({ respawnConfig: respawn, respawnEnabled: true });
  expect((store.getSession(original.id) as unknown as { __envOverrides?: unknown }).__envOverrides).toBeUndefined();
  store.setSessionFromOwner(
    original,
    { ...original.toPersistedState(), respawnConfig: undefined, respawnEnabled: false },
    'authoritative'
  );
  expect(store.getSession(original.id)?.respawnConfig).toBeUndefined();
  expect(store.getSession(original.id)?.respawnEnabled).toBe(false);
});

it.each(['shell', 'interactive', 'prompt'] as const)(
  'dispatches native direct %s only through A with the original UUID and endpoint',
  async (kind) => {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic/selected-native-broker');
    const proof = await prepareWorkspaceHooks(root, 'install', { scaffold: false, enabled: async () => true });
    const original = session({ mode: kind === 'shell' ? 'shell' : 'claude', workspaceHookPreparation: proof });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport.before = () => {
      expect(disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id].transport).toBe('native-ordinary');
      entered();
    };
    const started = (
      kind === 'shell'
        ? original.startShell()
        : kind === 'interactive'
          ? original.startInteractive()
          : original.runPrompt('synthetic')
    ).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error })
    );
    await Promise.race([
      reached,
      started.then((result) => {
        throw new Error('Start ended before native dispatch: ' + String(result.error));
      }),
    ]);
    const [binary, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(binary).toBe('reverie-worker-exec');
    expect(args).toEqual(
      expect.arrayContaining([
        '--attempt-id',
        disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id].attemptId,
        '--session-id',
        original.id,
      ])
    );
    expect(options?.env?.REVERIE_WORKER_SOCKET).toBe('/synthetic/selected-native-broker');
    if (kind === 'prompt') for (const exit of transport.exits) exit({ exitCode: 0 });
    const result = await started;
    if (kind !== 'prompt') expect(result.error).toBeInstanceOf(ProviderDispatchUnconfirmedError); // No mux/READY proof invented for a direct worker client.
    expect(spawn).toHaveBeenCalledOnce();
  }
);
it('an unavailable native executable never falls back to a website shell', async () => {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic/unavailable-broker');
  const original = session();
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw new Error('synthetic unavailable worker client');
  });
  await expect(original.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(spawn).toHaveBeenCalledOnce();
  expect(vi.mocked(spawn).mock.calls[0][0]).toBe('reverie-worker-exec');
  expect(original.providerDispatchHeld).toBe(true);
});
it.each(['same-owner', 'different-owner', 'same-sid'] as const)(
  'refuses borrowing a genuine B acknowledgement for A (%s)',
  async (relation) => {
    const a = session(),
      b = session({
        ...(relation === 'same-sid' ? { id: a.id } : {}),
        owner: relation === 'different-owner' ? 'other-owner' : a.owner,
      });
    const publication = store.stageProviderLaunch(b, {
      transport: 'local-pty',
      current: () => true,
      snapshot: () => b.toPersistedState(),
    });
    await publication.prepare(b, execution(b)); // A genuine canonical B file acknowledgement, not an invented receipt.
    const before = fs.readFileSync(file, 'utf8');
    const mux = new TmuxManager();
    await expect(
      mux.createSession({
        sessionId: a.id,
        workingDir: a.workingDir,
        mode: a.mode,
        owner: a.owner,
        providerLaunch: publication,
        providerSubject: a,
        onProviderDispatch: () => publication.claim(),
      })
    ).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(mux.getSession(a.id)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  }
);

it.each(['create', 'respawn'] as const)(
  'refuses conflicting remote/container %s selections before dispatch',
  async (action) => {
    const original = session();
    const mux = new TmuxManager();
    const provider = vi.fn(),
      viewer = vi.fn();
    const options: CreateSessionOptions = {
      sessionId: original.id,
      workingDir: root,
      mode: 'shell',
      owner: original.owner,
      remote: {
        hostId: 'synthetic-remote',
        label: 'Synthetic',
        host: '192.0.2.1',
        username: 'synthetic',
        remotePath: '/work',
        owned: false,
      },
      docker: {
        hostId: 'synthetic-container',
        label: 'Synthetic',
        engine: 'docker',
        image: 'synthetic',
        containerName: 'synthetic',
        hostWorkspacePath: root,
        containerWorkdir: '/work',
        network: 'none',
        mountCredentials: false,
        hooksEnabled: false,
        resumeOnStart: false,
      },
      onProviderDispatch: provider,
      onViewerDispatch: viewer,
    };
    mux.registerSession({
      sessionId: original.id,
      muxName: 'reverie-synthetic',
      pid: 999_999_997,
      createdAt: Date.now(),
      workingDir: root,
      mode: 'shell',
      attached: false,
      owner: original.owner,
    });
    try {
      await expect(action === 'create' ? mux.createSession(options) : mux.respawnPane(options)).rejects.toThrow(
        'both remote and container'
      );
      expect(provider).not.toHaveBeenCalled();
      expect(viewer).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      mux.destroy();
    }
  }
);

it.each(['not-dead-only', 'missing-admission', 'refused-admission'] as const)(
  'strict remote attachment cannot bypass its original dead-client admission (%s)',
  async (kind) => {
    const original = session();
    const mux = new TmuxManager();
    const provider = vi.fn(),
      viewer = vi.fn();
    mux.registerSession({
      sessionId: original.id,
      muxName: 'reverie-synthetic',
      pid: 999_999_997,
      createdAt: Date.now(),
      workingDir: root,
      mode: 'shell',
      attached: false,
      owner: original.owner,
    });
    try {
      const result = mux.respawnPane({
        sessionId: original.id,
        workingDir: root,
        mode: 'shell',
        owner: original.owner,
        remote: {
          hostId: 'synthetic-remote',
          label: 'Synthetic',
          host: '192.0.2.1',
          username: 'synthetic',
          remotePath: '/work',
          owned: true,
        },
        remoteAttachOnly: true,
        onlyIfDead: kind !== 'not-dead-only',
        ...(kind === 'missing-admission' ? {} : { admitted: () => kind !== 'refused-admission' }),
        onProviderDispatch: provider,
        onViewerDispatch: viewer,
      });
      if (kind === 'refused-admission') expect(await result).toBeNull();
      else await expect(result).rejects.toThrow('original admitted dead client');
      expect(provider).not.toHaveBeenCalled();
      expect(viewer).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      mux.destroy();
    }
  }
);

it.each(['same-row', 'replaced-row'] as const)(
  'holds the original respawn row while awaiting its real writer (%s)',
  async (kind) => {
    const remote = {
      hostId: 'synthetic-remote',
      label: 'Synthetic',
      host: '192.0.2.1',
      username: 'synthetic',
      remotePath: '/work',
      owned: true,
    };
    const original = session({ remote }),
      mux = new TmuxManager();
    mux.registerSession({
      sessionId: original.id,
      muxName: `reverie-${original.id.slice(0, 8)}`,
      pid: 999_999_997,
      createdAt: Date.now(),
      workingDir: root,
      mode: 'shell',
      attached: false,
      owner: original.owner,
      remote,
    });
    const publication = store.stageProviderLaunch(original, {
      transport: 'remote',
      current: () => true,
      snapshot: () => original.toPersistedState(),
    });
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
      entered();
      await held;
      return actualAsync.rename(from, to);
    });
    store.setConfig({ maxConcurrentSessions: 9 });
    const older = store.saveNowAsync();
    await arrived;
    const provider = vi.fn(() => publication.claim()),
      viewer = vi.fn();
    const options = { sessionId: original.id, workingDir: root, mode: 'shell' as const, owner: original.owner, remote };
    const ordinary = mux.respawnPane({
      ...options,
      providerLaunch: publication,
      providerSubject: original,
      onProviderDispatch: provider,
    });
    try {
      if (kind === 'replaced-row') {
        const successor = { ...mux.getSession(original.id)!, pid: 999_999_996 };
        mux.registerSession(successor);
        release();
        await older;
        expect(await ordinary).toBeNull();
        expect(provider).not.toHaveBeenCalled();
        expect(viewer).not.toHaveBeenCalled();
        expect(mux.getSession(original.id)).toBe(successor);
        expect(successor.pid).toBe(999_999_996);
        publication.settle(false);
        expect(publication.fenced).toBe(true);
        const restored = session({ id: original.id, publicationStore: new StateStore(file) });
        expect(restored.providerDispatchHeld).toBe(true);
        return;
      }
      await expect(
        mux.respawnPane({
          ...options,
          remoteAttachOnly: true,
          onlyIfDead: true,
          admitted: () => true,
          onViewerDispatch: viewer,
        })
      ).rejects.toThrow('Another operation owns this terminal');
      expect(provider).not.toHaveBeenCalled();
      expect(viewer).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(false);
      release();
      await older;
      expect(await ordinary).toBe(999_999_997);
      expect(provider).toHaveBeenCalledOnce();
      expect(
        await mux.respawnPane({
          ...options,
          remoteAttachOnly: true,
          onlyIfDead: true,
          admitted: () => true,
          onViewerDispatch: viewer,
        })
      ).toBe(999_999_997);
      expect(viewer).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.allSettled([older, ordinary]);
      mux.destroy();
    }
  }
);

it.each(['structural', 'prototype', 'proxy', 'other-store'] as const)(
  'refuses a non-owning publication subject before getters or filesystem effects (%s)',
  (kind) => {
    const original = session();
    const getters = vi.fn(() => {
      throw new Error('Untrusted Session property accessed');
    });
    const structural = Object.defineProperty({}, 'id', { get: getters });
    const subject =
      kind === 'structural'
        ? structural
        : kind === 'prototype'
          ? Object.create(Session.prototype)
          : kind === 'proxy'
            ? new Proxy(original, {})
            : original;
    const target = kind === 'other-store' ? new StateStore(join(root, 'other-store.json')) : store;
    const source = {
      transport: 'local-pty' as const,
      current: () => true,
      snapshot: () => original.toPersistedState(),
    };
    expect(() => target.stageProviderLaunch(subject, source)).toThrow('Original Session state-store custody required');
    expect(() => target.providerLaunchHeldFor(subject)).toThrow('Original Session state-store custody required');
    expect(getters).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  }
);

it('does not transfer a known-returned local continuation to a new principal', async () => {
  const original = session();
  await original.startShell();
  for (const exit of transport.exits.splice(0)) exit({ exitCode: 0 });
  const before = disk()[PROVIDER_LAUNCH_DISK_KEY];
  original.owner = 'successor-owner';
  await expect(original.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(disk()[PROVIDER_LAUNCH_DISK_KEY]).toEqual(before);
  expect(spawn).toHaveBeenCalledOnce();
});

it('allows a same-owner explicit local mode change only through a new canonical acknowledgement', async () => {
  const original = session();
  await original.startShell();
  for (const exit of transport.exits.splice(0)) exit({ exitCode: 0 });
  const before = disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id];
  original.setMode('claude');
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  transport.before = entered;
  const running = original.runPrompt('synthetic next local operation').then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error })
  );
  await Promise.race([
    reached,
    running.then((result) => {
      throw result.error ?? new Error('Expected physical dispatch');
    }),
  ]);
  const after = disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id];
  expect(after).toMatchObject({ owner: before.owner, mode: 'claude', transport: 'local-pty' });
  expect(after.attemptId).not.toBe(before.attemptId);
  for (const exit of transport.exits.splice(0)) exit({ exitCode: 0 });
  expect((await running).error).toBeUndefined();
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('cannot erase the original denial by restoring an older backup without private rows', async () => {
  const prior = JSON.stringify(store.getState());
  const original = session();
  await original.startShell();
  for (const exit of transport.exits.splice(0)) exit({ exitCode: 0 });
  const before = disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id];
  fs.writeFileSync(file + '.bak', prior);
  expect(store.recoverFromBackup()).toBe(true);
  await store.saveNowAsync();
  expect(disk()[PROVIDER_LAUNCH_DISK_KEY]).toEqual({
    version: 1,
    kind: 'unconfirmed',
    rows: { [original.id]: before },
  });
  await expect(original.startShell()).rejects.toThrow();
  const successor = session({ id: original.id, providerDispatchHeld: false });
  expect(successor.providerDispatchHeld).toBe(true);
  expect(spawn).toHaveBeenCalledOnce();
});

it('preserves a malformed private history as a durable denial without a public Session row', async () => {
  fs.writeFileSync(
    file,
    JSON.stringify({ ...store.getState(), [PROVIDER_LAUNCH_DISK_KEY]: { version: 1, kind: 'observed', rows: [] } })
  );
  const restored = new StateStore(file);
  const original = session({ publicationStore: restored });
  expect(original.providerDispatchHeld).toBe(true);
  restored.reset();
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual({
    version: 1,
    kind: 'unconfirmed',
    rows: {},
  });
  // An ordinary subsequent replacement must preserve the denial too.
  restored.setConfig({ maxConcurrentSessions: 4 });
  await restored.saveNowAsync();
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual({
    version: 1,
    kind: 'unconfirmed',
    rows: {},
  });
  expect(Object.hasOwn(restored.getState(), PROVIDER_LAUNCH_DISK_KEY)).toBe(false);
  await expect(original.startShell()).rejects.toBeInstanceOf(ProviderDispatchUnconfirmedError);
  expect(spawn).not.toHaveBeenCalled();
});

it('retains exactly the original local publication for its live Session lifetime', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/provider-launch-lifetime.mts', import.meta.url));
  const result = await promisify(execFile)(
    process.execPath,
    ['--expose-gc', '--experimental-test-module-mocks', '--import', 'tsx', fixture, root],
    { timeout: 15_000, maxBuffer: 64 * 1024, cwd: fileURLToPath(new URL('..', import.meta.url)) }
  );
  const line = result.stdout.trim().split('\n').at(-1);
  expect(JSON.parse(line!)).toEqual({
    retainedWhileLive: true,
    replacedLocalCollected: true,
    ownerCollected: true,
    successorDenied: true,
  });
});

it.each([
  'native',
  'options',
  'endpoint',
  'owner',
  'owner-aba',
  'same-owner',
  'storage',
  'busy-create',
  'create-late-row',
  'create-emit-row',
  'respawn',
  'respawn-create',
  'respawn-row-entry',
  'respawn-row-write',
  'respawn-row-notify',
])('joins actual production mux dispatch and durable original ownership (%s)', async (scenario) => {
  const fixture = fileURLToPath(new URL('./fixtures/provider-launch-mux.mts', import.meta.url));
  const result = await promisify(execFile)(
    process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', fixture, root, scenario],
    { timeout: 15_000, maxBuffer: 128 * 1024, cwd: fileURLToPath(new URL('..', import.meta.url)) }
  );
  const line = result.stdout.trim().split('\n').at(-1);
  expect(JSON.parse(line!)).toEqual({
    scenario,
    ok: true,
    production: true,
    effects: ['endpoint', 'owner', 'owner-aba', 'storage'].includes(scenario)
      ? 0
      : scenario === 'respawn'
        ? 3
        : scenario === 'respawn-create'
          ? 4
          : 2,
  });
});

it.each([
  'remote-reconnect',
  'remote-reconciled',
  'remote-restored',
  'remote-host',
  'remote-name',
  'remote-owner',
  'remote-subject',
  'remote-pid',
  'remote-working-dir',
  'remote-mode',
  'remote-initial-target',
  'remote-initial-working-dir',
  'remote-initial-mode',
  'remote-late-pid',
  'remote-late-subject',
])('uses the actual production mux for strict remote viewer ownership (%s)', async (scenario) => {
  const fixture = fileURLToPath(new URL('./fixtures/provider-launch-mux.mts', import.meta.url));
  const result = await promisify(execFile)(
    process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', fixture, root, scenario],
    { timeout: 15_000, maxBuffer: 128 * 1024, cwd: fileURLToPath(new URL('..', import.meta.url)) }
  );
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({
    scenario,
    ok: true,
    production: true,
    effects: [
      'remote-reconnect',
      'remote-restored',
      'remote-reconciled',
      'remote-late-pid',
      'remote-late-subject',
    ].includes(scenario)
      ? 3
      : 2,
  });
});

it('retains an armed unused publication independently of expired dispatch authority and denies a foreign Session', async () => {
  const original = session();
  let current = true;
  const operation = store.stageProviderLaunch(original, {
    transport: 'native-ordinary',
    brokerSocket: '/synthetic/original-broker',
    current: () => current,
    snapshot: () => original.toPersistedState(),
  });
  const execution: ProviderLaunchExecution = {
    kind: 'pty',
    sessionId: original.id,
    owner: original.owner ?? null,
    mode: original.mode,
    command: 'fixed',
    cwd: root,
    environment: {},
  };
  await operation.prepare(original, execution);
  const retained = original.captureEmployeeRecoveryRetention();
  expect(retained()).toBe(true);
  current = false;
  expect(() => operation.claim()).toThrow();
  expect(retained()).toBe(true);
  expect(store.providerLaunchHeldFor(session({ id: original.id }))).toBe(true);
  expect(store.captureProviderLaunchRetention(session({ id: original.id }))()).toBe(false);
  await expect(
    store
      .stageProviderLaunch(original, {
        transport: 'local-pty',
        current: () => true,
        snapshot: () => original.toPersistedState(),
      })
      .prepare(original, execution)
  ).rejects.toThrow('unresolved');
  // A second staged object cannot replace the strongly held, already armed original.
  expect(retained()).toBe(true);
});

it('stable recovery custody survives the actual original PTY exit callback but not a later launch publication', async () => {
  const original = session();
  await original.startShell();
  const live = original.captureEmployeeRecoveryCurrent();
  const retained = original.captureEmployeeRecoveryRetention();
  expect(live()).toBe(true);
  expect(retained()).toBe(true);
  transport.exits.at(-1)!({ exitCode: 0 });
  expect(live()).toBe(false);
  expect(retained()).toBe(true);
  await original.startShell();
  expect(retained()).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(2);
});
it('a public staging factory cannot replace the original Session pending slot', () => {
  const original = session();
  const forged = stageProviderLaunch(
    {
      subject: original,
      sessionId: original.id,
      owner: original.owner ?? null,
      mode: original.mode,
      workingDir: root,
      transport: 'native-ordinary',
      current: () => true,
      snapshot: () => original.toPersistedState(),
    },
    async () => {}
  );
  expect(() => Session.retainProviderLaunchPublication(original, store, forged)).toThrow('custody');
});

it('a queued superseded stage cannot publish after a newer original stage owns pending custody', async () => {
  const original = session();
  const source = { transport: 'local-pty' as const, current: () => true, snapshot: () => original.toPersistedState() };
  const old = store.stageProviderLaunch(original, source);
  const execution: ProviderLaunchExecution = {
    kind: 'pty',
    sessionId: original.id,
    owner: original.owner ?? null,
    mode: original.mode,
    command: 'fixed',
    cwd: root,
    environment: {},
  };
  const first = old.prepare(original, execution);
  const next = store.stageProviderLaunch(original, source);
  await expect(first).rejects.toThrow('unresolved');
  await next.prepare(original, execution);
  expect(store.providerLaunchHeldFor(original)).toBe(false);
  const retained = original.captureEmployeeRecoveryRetention();
  expect(retained()).toBe(true);
});
