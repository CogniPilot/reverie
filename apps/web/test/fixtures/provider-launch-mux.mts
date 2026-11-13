/** Actual production Session/Store/mux command construction; only OS transport ports are synthetic. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import child from 'node:child_process';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ProviderLaunchExecution } from '../../src/provider-launch-publication.js';
import type { CreateSessionOptions } from '../../src/mux-interface.js';

delete process.env.VITEST; // Isolated process: all physical process APIs below are replaced BEFORE product imports.
process.env.REVERIE_CAPACITY_RETRY = '0';
process.env.OPENAI_API_KEY = 'synthetic-original-key';
const [root, scenario] = process.argv.slice(2);
assert.ok(root && scenario);
const stateFile = join(root, 'mux-state.json');
const remoteScenario = scenario.startsWith('remote-');
const respawnScenario = scenario.startsWith('respawn');
process.env.HOME = root;
process.env.REVERIE_WORKER_SOCKET = respawnScenario || remoteScenario ? '' : '/synthetic/original-broker';
const commands: string[] = [];
let dead = false;
let panePid = 999999997;
let muxName = '';
let beforeEffect: (command: string) => void = () => {};
let afterEffect: () => Promise<void> = async () => {};
function output(command: string): string {
  if (command.includes('list-panes') && command.includes('#{session_name}|#{pane_pid}'))
    return `${muxName}|${panePid}|${dead ? 1 : 0}||\n`;
  if (command.includes('list-panes')) return `${dead ? 1 : 0} ${panePid} ${muxName}\n`;
  if (command.includes('#{pane_dead}')) return dead ? '1\n' : '0\n';
  if (command.includes('#{pane_pid}')) return `${panePid}\n`;
  if (command.includes('window_width')) return '120 40\n';
  if (command.includes(' -V')) return 'tmux 3.7\n';
  if (command.includes('which') || command.includes('command -v')) return '/bin/bash\n';
  return '';
}
function record(command: string, options?: { env?: NodeJS.ProcessEnv }): string {
  if (command.includes('new-session') || command.includes('respawn-pane')) {
    assert.equal(options?.env?.OPENAI_API_KEY, 'synthetic-original-key');
    beforeEffect(command);
  }
  commands.push(command);
  if (command.includes('respawn-pane')) dead = false;
  return output(command);
}
const exec = Object.assign(
  (command: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
    const result = record(command);
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (typeof callback === 'function') queueMicrotask(() => callback(null, result, ''));
    return { pid: 999999997, on() {}, kill() {} };
  },
  {
    [promisify.custom]: async (command: string, options?: { env?: NodeJS.ProcessEnv }) => {
      const stdout = record(command, options);
      if (command.includes('respawn-pane')) await afterEffect();
      return { stdout, stderr: '' };
    },
  }
);
const physical = {
  exec,
  execSync: (command: string, options?: { env?: NodeJS.ProcessEnv }) => record(command, options),
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback(null, '', ''));
    return { pid: 999999997, on() {}, kill() {} };
  },
  execFileSync: (_binary: string, args: string[]) => record(args.join(' ')),
  spawnSync: () => {
    throw new Error('Unexpected synchronous process port');
  },
  spawn: () => ({ pid: 999999997, unref() {}, on() {}, kill() {} }),
};
Object.assign(child, physical);
let exit: ((event: { exitCode: number }) => void) | undefined;
let ptySpawns = 0;
const spawn = () => {
  ptySpawns++;
  return {
    pid: 999999997,
    onData() {
      return { dispose() {} };
    },
    onExit(callback: (event: { exitCode: number }) => void) {
      exit = callback;
      return { dispose() {} };
    },
    kill() {},
    write() {},
    resize() {},
  };
};
mock.module('node-pty', { namedExports: { spawn }, defaultExport: { spawn } });
let failPublication = false;
const originalRename = fs.renameSync;
fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
  if (failPublication) throw new Error('synthetic pre-publication storage refusal');
  originalRename(...args);
};
let release!: () => void;
let queued!: () => void;
const waiting = new Promise<void>((resolve) => {
  queued = resolve;
});
const held = new Promise<void>((resolve) => {
  release = resolve;
});
let block = false;
const originalAsyncRename = asyncFs.rename;
asyncFs.rename = async (...args: Parameters<typeof asyncFs.rename>) => {
  if (block && args[1] === stateFile) {
    block = false;
    queued();
    await held;
  }
  await originalAsyncRename(...args);
};
syncBuiltinESMExports();

const { StateStore } = await import('../../src/state-store.js');
const { Session } = await import('../../src/session.js');
const { TmuxManager } = await import('../../src/tmux-manager.js');
const { PROVIDER_LAUNCH_DISK_KEY } = await import('../../src/provider-launch-publication.js');
const file = stateFile;
const store = new StateStore(file);
const mux = new TmuxManager();
const original = new Session({
  mode: 'shell',
  workingDir: root,
  useMux: true,
  mux,
  owner: 'synthetic-owner',
  publicationStore: store,
  envOverrides: { SYNTHETIC_SELECTION: 'original' },
  ...(remoteScenario
    ? {
        remote: {
          hostId: 'fixture-host',
          label: 'Fixture',
          host: 'fixture.invalid',
          username: 'fixture',
          remotePath: '/work',
          owned: true,
          remoteSessionName: 'original-durable-name',
        },
      }
    : {}),
});
muxName = `reverie-${original.id.slice(0, 8)}`;
let execution: ProviderLaunchExecution | undefined;
let staged!: () => void;
const preparing = new Promise<void>((resolve) => {
  staged = resolve;
});
const stage = store.stageProviderLaunch.bind(store);
let onPrepare: () => void = () => {};
store.stageProviderLaunch = (...args) => {
  const publication = stage(...args);
  const prepare = publication.prepare.bind(publication);
  publication.prepare = (subject, selected) => {
    execution = selected;
    staged();
    onPrepare();
    return prepare(subject, selected);
  };
  return publication;
};
let options: CreateSessionOptions | undefined;
const create = mux.createSession.bind(mux);
mux.createSession = (selected) => {
  options = selected;
  return create(selected);
};
const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
beforeEffect = (command) => {
  assert.ok(execution && execution.command !== 'test-mode');
  const row = disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id];
  assert.equal(row.configurationDigest, createHash('sha256').update(JSON.stringify(execution)).digest('hex'));
  assert.equal(row.sessionId, original.id);
  assert.equal(execution.environment.SYNTHETIC_SELECTION, 'original');
  if (scenario === 'create-late-row' && command.includes('respawn-pane'))
    queueMicrotask(() => {
      mux.registerSession({
        sessionId: original.id,
        muxName,
        pid: 999999996,
        createdAt: 0,
        workingDir: root,
        mode: 'shell',
        owner: 'successor-owner',
        attached: false,
      });
    });
};
if (scenario === 'create-emit-row')
  mux.once('sessionCreated', (subject) => {
    mux.registerSession({ ...subject, owner: 'successor-owner', pid: 999999996 });
  });
const changesWhileQueued = ['options', 'endpoint', 'owner', 'owner-aba', 'same-owner', 'busy-create'].includes(
  scenario
);
let writing: Promise<void> | undefined;
if (changesWhileQueued) {
  store.setSession(original.id, original.toPersistedState());
  block = true;
  writing = store.saveNowAsync();
  await waiting;
}
failPublication = scenario === 'storage';
const started = original.startShell().then(
  () => ({ ok: true, error: undefined }),
  (error) => ({ ok: false, error })
);
if (changesWhileQueued) {
  await Promise.race([
    preparing,
    started.then((value) => {
      throw value.error ?? new Error('missing preparation');
    }),
  ]);
  assert.equal(commands.filter((command) => /new-session|respawn-pane/.test(command)).length, 0);
  if (scenario === 'options') {
    process.env.OPENAI_API_KEY = 'synthetic-changed-key';
    options!.envOverrides!.SYNTHETIC_SELECTION = 'changed';
    options!.workingDir = '/synthetic/foreign';
    options!.sessionId = 'foreign-session';
  } else if (scenario === 'endpoint') process.env.REVERIE_WORKER_SOCKET = '/synthetic/foreign-broker';
  else if (scenario === 'same-owner') {
    const currentOwner = original.owner;
    original.owner = currentOwner;
  } else if (scenario === 'busy-create') {
    const sibling = new Session({
      id: original.id,
      mode: 'shell',
      workingDir: root,
      useMux: true,
      mux,
      owner: original.owner,
      publicationStore: store,
    });
    const refused = await sibling.startShell().then(
      () => ({ ok: true, error: undefined }),
      (error) => ({ ok: false, error })
    );
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /Another operation owns this terminal/);
    assert.equal(ptySpawns, 0);
    await sibling.stop(false);
  } else {
    const owner = original.owner;
    original.owner = 'foreign-owner';
    if (scenario === 'owner-aba') original.owner = owner;
  }
  release();
  await writing;
}
const result = await started;
const effects = () => commands.filter((command) => /new-session|respawn-pane/.test(command));
if (scenario === 'create-late-row' || scenario === 'create-emit-row') {
  assert.equal(result.ok, false);
  assert.equal(effects().length, 2);
  assert.equal(mux.getSession(original.id)!.owner, 'successor-owner');
  assert.equal(mux.getSession(original.id)!.pid, 999999996);
  assert.equal(original.providerDispatchHeld, true);
  assert.equal(ptySpawns, 0);
} else if (['endpoint', 'owner', 'owner-aba', 'storage'].includes(scenario)) {
  assert.equal(result.ok, false);
  assert.equal(effects().length, 0);
} else {
  assert.equal(result.ok, true, String(result.error));
  const row = disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id];
  assert.equal(effects().length, 2);
  if (!respawnScenario && !remoteScenario) {
    assert.ok(execution!.command.includes(`--attempt-id '${row.attemptId}'`));
    assert.ok(execution!.command.includes("REVERIE_WORKER_SOCKET='/synthetic/original-broker'"));
    assert.ok(!execution!.command.includes('foreign'));
    if (scenario === 'options') {
      // Actual registry-selected sensitive env consumes the captured plan.
      const port = mux as unknown as {
        _configureCliEnv(
          name: string,
          id: string,
          mode: 'codex',
          config: undefined,
          environment: Readonly<NodeJS.ProcessEnv>
        ): void;
      };
      port._configureCliEnv(muxName, original.id, 'codex', undefined, execution!.environment);
      assert.ok(commands.some((command) => command.includes("OPENAI_API_KEY 'synthetic-original-key'")));
      assert.ok(!commands.some((command) => command.includes('synthetic-changed-key')));
    }
  } else if (respawnScenario) {
    const first = row.attemptId;
    exit!({ exitCode: 0 });
    exit = undefined;
    dead = true;
    if (scenario === 'respawn') await original.startShell();
    else if (scenario === 'respawn-create') {
      const previous = mux.getSession(original.id)!;
      mux.respawnPane = async () => null; // Known refusal: neither writer nor command entered.
      await original.startShell();
      assert.notEqual(mux.getSession(original.id), previous);
      assert.equal(mux.getSession(original.id)!.owner, original.owner);
      assert.equal(original.providerDispatchHeld, false);
      assert.ok(!effects().some((command) => /kill-session/.test(command)));
      assert.deepEqual(
        effects().map((command) => (command.includes('new-session') ? 'create' : 'launch')),
        ['create', 'launch', 'create', 'launch']
      );
    } else if (scenario === 'respawn-row-entry') {
      const canonical = fs.readFileSync(file, 'utf8');
      const successor = { ...mux.getSession(original.id)!, pid: 999999996, owner: 'successor-owner' };
      mux.registerSession(successor);
      const mutationIndex = commands.length;
      const outcome = await original.startShell().then(
        () => ({ ok: true, error: undefined }),
        (error) => ({ ok: false, error })
      );
      assert.equal(outcome.ok, false);
      assert.equal(
        commands.slice(mutationIndex).filter((command) => /setenv|set-option|new-session|respawn-pane/.test(command))
          .length,
        0
      );
      assert.equal(fs.readFileSync(file, 'utf8'), canonical);
      assert.equal(mux.getSession(original.id), successor);
      assert.equal(successor.pid, 999999996);
    } else {
      let mutationIndex = -1;
      const replace = () => {
        mux.registerSession({ ...mux.getSession(original.id)!, pid: 999999996 });
        mutationIndex = commands.length;
      };
      let older: Promise<void> | undefined;
      let arrive!: () => void;
      const nextPreparation = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      if (scenario === 'respawn-row-write') {
        store.setConfig({ maxConcurrentSessions: 9 });
        block = true;
        older = store.saveNowAsync();
        await waiting;
        onPrepare = arrive;
      } else {
        const actualRespawn = mux.respawnPane.bind(mux);
        mux.respawnPane = (selected) =>
          actualRespawn({
            ...selected,
            onProviderDispatch: () => {
              original.on('workspaceHookGenerationChanged', replace);
              try {
                selected.onProviderDispatch?.();
              } finally {
                original.off('workspaceHookGenerationChanged', replace);
              }
            },
          });
      }
      const retry = original.startShell().then(
        () => ({ ok: true, error: undefined }),
        (error) => ({ ok: false, error })
      );
      if (scenario === 'respawn-row-write') {
        await nextPreparation;
        replace();
        release();
        await older;
      }
      const outcome = await retry;
      assert.equal(outcome.ok, false);
      assert.ok(mutationIndex >= 0);
      assert.equal(
        commands.slice(mutationIndex).filter((command) => /setenv|set-option|new-session|respawn-pane/.test(command))
          .length,
        0
      );
      assert.equal(original.providerDispatchHeld, true);
      assert.equal(mux.getSession(original.id)!.pid, 999999996);
    }
    const nextAttempt = disk()[PROVIDER_LAUNCH_DISK_KEY].rows[original.id].attemptId;
    if (scenario === 'respawn' || scenario === 'respawn-create' || scenario === 'respawn-row-notify')
      assert.notEqual(nextAttempt, first);
    else assert.equal(nextAttempt, first); // Entry/queued binding loss is refused before a new canonical intent.
    assert.equal(effects().length, scenario === 'respawn' ? 3 : scenario === 'respawn-create' ? 4 : 2);
  }
}
if (remoteScenario) {
  const intent = fs.readFileSync(file, 'utf8');
  let target = original;
  if (scenario === 'remote-restored') {
    target = new Session({
      ...original.toState(),
      workingDir: root,
      useMux: true,
      mux,
      muxSession: mux.getSession(original.id)!,
      publicationStore: store,
    });
    assert.equal(target.providerDispatchHeld, true);
  }
  dead = true;
  const late = scenario.startsWith('remote-late-');
  const reconciled = scenario === 'remote-reconciled';
  const initialMismatch = scenario.startsWith('remote-initial-');
  if (initialMismatch) {
    const subject = mux.getSession(target.id)!;
    if (scenario === 'remote-initial-target') subject.remote = { ...subject.remote!, host: 'successor.invalid' };
    else if (scenario === 'remote-initial-working-dir') subject.workingDir = '/synthetic/successor';
    else if (scenario === 'remote-initial-mode') subject.mode = 'codex';
    else throw new Error('Unknown initial remote fixture scenario');
  }
  let clearCalls = 0;
  const clearPaneExit = mux.clearPaneExit.bind(mux);
  mux.clearPaneExit = (name) => {
    clearCalls++;
    clearPaneExit(name);
  };
  let providerCalls = 0,
    viewerCalls = 0;
  const respawn = mux.respawnPane.bind(mux);
  mux.respawnPane = (selected) => {
    assert.equal(selected.providerLaunch, undefined);
    assert.equal(selected.remoteAttachOnly, true);
    assert.equal(selected.onlyIfDead, true);
    return respawn({
      ...selected,
      onProviderDispatch: () => {
        providerCalls++;
        throw new Error('Viewer cannot claim provider dispatch');
      },
      onViewerDispatch: () => {
        viewerCalls++;
      },
    });
  };
  beforeEffect = () => {
    assert.equal(fs.readFileSync(file, 'utf8'), intent);
    assert.equal(providerCalls, 0);
    if (scenario === 'remote-reconnect' || scenario === 'remote-restored' || reconciled) panePid = 999999995;
  };
  const change = scenario !== 'remote-reconnect' && scenario !== 'remote-restored' && !reconciled;
  if (late || reconciled)
    afterEffect = async () => {
      queued();
      await held;
    };
  else if (change && !initialMismatch) {
    const port = mux as unknown as { _resolveStatusLine(...args: unknown[]): Promise<unknown> };
    const resolve = port._resolveStatusLine.bind(port);
    port._resolveStatusLine = async (...args) => {
      const value = await resolve(...args);
      queued();
      await held;
      return value;
    };
  }
  const reconnect = target.reattachRemote();
  if (reconciled) {
    await waiting;
    const originalPid = mux.getSession(target.id)!.pid;
    await mux.reconcileSessions();
    assert.equal(mux.getSession(target.id)!.pid, originalPid);
    assert.equal(await target.reattachRemote(), false);
    await assert.rejects(
      respawn({
        sessionId: target.id,
        workingDir: root,
        mode: target.mode,
        owner: target.owner,
        remote: target.remote,
        admitted: () => true,
      }),
      /Another operation owns this terminal/
    );
    assert.equal(effects().length, 3);
    release();
  } else if (change && !initialMismatch) {
    await waiting;
    if (scenario === 'remote-host') target.toState().remote!.host = 'successor.invalid';
    else if (scenario === 'remote-name') target.toState().remote!.remoteSessionName = 'successor-session';
    else if (scenario === 'remote-owner') target.owner = 'successor-owner';
    else if (scenario === 'remote-subject') mux.registerSession({ ...mux.getSession(target.id)! });
    else if (scenario === 'remote-pid') mux.getSession(target.id)!.pid = 999999996;
    else if (scenario === 'remote-working-dir') mux.getSession(target.id)!.workingDir = '/synthetic/successor';
    else if (scenario === 'remote-mode') mux.getSession(target.id)!.mode = 'codex';
    else if (scenario === 'remote-late-pid') mux.getSession(target.id)!.pid = 999999996;
    else if (scenario === 'remote-late-subject') mux.registerSession({ ...mux.getSession(target.id)!, pid: 999999996 });
    else throw new Error('Unknown remote fixture scenario');
    release();
  }
  assert.equal(await reconnect, !change);
  assert.equal(providerCalls, 0);
  assert.equal(viewerCalls, change && !late ? 0 : 1);
  assert.equal(effects().length, change && !late ? 2 : 3);
  assert.equal(fs.readFileSync(file, 'utf8'), intent);
  if (change) assert.equal(clearCalls, 0);
  if (late) assert.equal(mux.getSession(target.id)!.pid, 999999996);
  if (!change) {
    const command = effects().at(-1)!;
    assert.ok(command.includes(' attach -t '));
    assert.ok(command.includes('original-durable-name'));
    assert.ok(!command.includes('new-session'));
    assert.ok(!command.includes('respawn-pane -k'));
    assert.equal(mux.getSession(target.id)!.remote?.owned, true);
    assert.equal(mux.getSession(target.id)!.pid, 999999995);
  }
  if (scenario === 'remote-restored') {
    assert.equal(target.providerDispatchHeld, true);
    assert.equal(target.canAcceptChatInput(), false);
    await target.stop(false);
  }
}
failPublication = false;
await original.stop(false);
mux.destroy();
if (!store.statePublicationHeld) await store.saveNowAsync();
process.stdout.write(JSON.stringify({ scenario, ok: true, production: true, effects: effects().length }) + '\n');
