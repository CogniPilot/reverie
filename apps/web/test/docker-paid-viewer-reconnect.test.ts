/** Real paid-launch owner, Session lifecycle, StateStore and v3 Engine/Installer
 * proofs over bounded PTY/Docker reply ports. No Docker/provider/native effect
 * or physical local-client custody acceptance is claimed. */
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { CompanyDockerContinuationStore, dockerEmployeeProviderSourceDigest } from '../src/docker-employee-store.js';
import { RuntimeRecipeSchema } from '../src/expert-runtime-recipe.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { SessionState } from '../src/types.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { TmuxManager, buildDockerLaunchCommand } from '../src/tmux-manager.js';
import { captureDockerEmployeeProviderLaunch } from '../src/docker-employee-provider-launch.js';
import { bindInitialLaunchAdmission } from '../src/initial-launch-admission.js';
import { PROVIDER_LAUNCH_DISK_KEY } from '../src/provider-launch-publication.js';
import { TerminalInputService, terminalInputFingerprint } from '../src/web/terminal-input-service.js';
import { dockerContinuationDigest as digest } from '../src/docker-employee-continuation.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../src/docker-employee-provider-view-native.js';
import { dockerPlanRetirementFixture } from './helpers/docker-plan-retirement-fixture.js';
import { installRecordedDockerViewer, recordedDockerViewerSocketPath } from './helpers/recorded-docker-viewer.js';

const transport = vi.hoisted(() => ({
  clients: [] as Array<{ file: string; args: string[]; pid: number; tty: string }>,
  writes: [] as string[],
  data: [] as Array<(text: string) => void>,
  exits: [] as Array<(event: { exitCode: number; signal: number }) => void>,
  registered: undefined as (() => void) | undefined,
}));
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]) => {
    if (
      file !== process.execPath ||
      args[0] !== '-e' ||
      args[1] !== 'if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.pipe(process.stdout);'
    )
      throw Error('Unexpected non-test outer viewer command');
    const pid = 2000000 + transport.clients.length,
      tty = '/dev/pts/' + (900 + transport.clients.length);
    transport.clients.push({ file, args, pid, tty });
    const listeners: Array<(event: { exitCode: number; signal: number }) => void> = [];
    let exited = false;
    const exit = (event: { exitCode: number; signal: number }) => {
      if (exited) return;
      exited = true;
      for (const callback of listeners) callback(event);
    };
    transport.exits.push(exit);
    return {
      pid,
      ptsName: tty,
      cols: 80,
      rows: 24,
      process: 'tmux',
      handleFlowControl: false,
      write: vi.fn((text: string) => transport.writes.push(text)),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: (callback: (text: string) => void) => {
        transport.data.push(callback);
        return { dispose: () => {} };
      },
      onExit: (callback: typeof exit) => {
        listeners.push(callback);
        transport.registered?.();
        return { dispose: () => {} };
      },
      kill: vi.fn(() => exit({ exitCode: 0, signal: 0 })),
    };
  }),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn((command: string) => (command.includes('tmux') ? 'tmux 3.5a\n' : '')),
    execFileSync: vi.fn(() => Buffer.from('')),
    exec: vi.fn((_command: unknown, options: unknown, callback?: unknown) => {
      const fn = typeof options === 'function' ? options : callback;
      if (typeof fn === 'function') queueMicrotask(() => fn(null, '', ''));
      return { pid: 2147483647, on: vi.fn(), kill: vi.fn() };
    }),
    spawn: vi.fn((command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
      if (
        command !== 'flock' ||
        JSON.stringify(args) !== JSON.stringify(['--exclusive', '--wait', '5', '--conflict-exit-code', '75', '3'])
      )
        throw Error('Unexpected native subprocess');
      return actual.spawn(command, args, options);
    }),
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (
          file !== '/bin/tmux' ||
          args.length !== 8 ||
          args[0] !== '-N' ||
          args[1] !== '-f' ||
          args[2] !== '/dev/null' ||
          args[3] !== '-L' ||
          args[5] !== 'display-message' ||
          args[6] !== '-p' ||
          args[7] !== '#{pid}|#{socket_path}'
        )
          throw Error('Unexpected native subprocess');
        callback(null, '500000|' + recordedDockerViewerSocketPath(args[4]!) + '\n', '');
        return { pid: 2147483647, on: vi.fn(), kill: vi.fn() };
      }
    ),
  };
});
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  transport.registered = undefined;
  for (const close of cleanup.splice(0).reverse()) await close();
  transport.clients.length = transport.writes.length = transport.data.length = transport.exits.length = 0;
  vi.restoreAllMocks();
});

async function paidFixture(originalDead = true, canonicalReady = false) {
  const custody = installRecordedDockerViewer();
  custody.recordCapture();
  custody.recordLocalClients();
  const directory = fs.mkdtempSync(join(tmpdir(), 'paid-v3-view-'));
  fs.chmodSync(directory, 0o700);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const companyFile = new CompanyStore(join(directory, 'company.json'));
  let canonicalSaved: SessionState | undefined;
  const canonicalCompany = new CompanyService(companyFile, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), setStatus: vi.fn() },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  const canonical = new CompanyDockerContinuationStore(canonicalCompany, () => canonicalSaved);
  const native = await dockerPlanRetirementFixture(
    canonicalReady
      ? {
          canonicalRead: async (row) => {
            await companyFile.init();
            const employee = EmployeeSchema.parse({
              id: row.employeeId,
              owner: row.owner,
              sessionId: row.request.sessionId,
              sessionGeneration: row.request.sessionGeneration,
              name: 'Synthetic',
              icon: 'S',
              position: 'Employee',
              expertise: ['testing'],
              createdAt: 1,
              onVacation: false,
              desiredRunning: true,
            });
            canonicalSaved = {
              id: row.request.sessionId,
              owner: row.owner,
              mode: 'claude',
              workingDir: '/workspace',
              claudeMode: 'normal',
              allowedTools: 'Read',
              pid: null,
              status: 'idle',
              currentTaskId: null,
              createdAt: 1,
              lastActivityAt: 1,
            };
            return {
              providerSourceDigest: dockerEmployeeProviderSourceDigest(employee, canonicalSaved),
              publish: async (ready) => {
                await companyFile.update((state) => {
                  state.employees = [
                    {
                      ...employee,
                      dockerBinding: {
                        version: 1,
                        operationId: ready.request.operationId,
                        credentialId: ready.credentialId,
                        sessionId: ready.request.sessionId,
                        sessionGeneration: ready.request.sessionGeneration,
                        containerId: ready.destination!.containerId,
                        imageId: ready.destination!.imageId,
                        originalDigest: digest(ready.destination),
                        policyDigest: digest(ready.policy),
                      },
                    },
                  ];
                  state.dockerEmployeeContinuations = [ready];
                });
              },
              requireCurrent: (ready) => {
                if (
                  ready.version !== 3 ||
                  ready.phase !== 'ready' ||
                  !canonical.existingSubject(ready.employeeId, ready)
                )
                  throw Error('Actual canonical published target changed');
              },
            };
          },
        }
      : undefined
  );
  const path = join(directory, 'state.json'),
    store = new StateStore(path),
    mux = new TmuxManager(),
    docker = structuredClone(native.target.docker!),
    row = native.state.work!,
    session = new Session({
      id: native.target.id,
      mode: 'claude',
      workingDir: docker.containerWorkdir,
      claudeMode: 'normal',
      allowedTools: 'Read',
      docker,
      mux,
      useMux: true,
      publicationStore: store,
    });
  cleanup.push(async () => {
    await session.stop(false);
    mux.destroy();
    store.flush();
    native.engine.close();
    if (native.strictEngine !== native.engine) native.strictEngine.close();
  });
  const binding = {
    version: 1 as const,
    operationId: row.request.operationId,
    credentialId: row.credentialId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    containerId: row.destination!.containerId,
    imageId: row.destination!.imageId,
    originalDigest: digest(row.destination),
    policyDigest: digest(row.policy),
  };
  let nativeCurrent = true,
    launchCurrent = true,
    localDead = false;
  const current = () => {
      if (!nativeCurrent) throw Error('Native target changed');
    },
    owner = captureDockerEmployeeProviderLaunch(session, binding, current),
    launchOptions = {
      mode: 'claude' as const,
      docker,
      sessionId: session.id,
      createContext: {} as never,
      execEnv: {},
      execEnvNames: [],
      canonicalCommand: 'claude --resume 90000000-0000-4000-8000-000000000009',
      continuationLaunch: owner,
    };
  session.bindDockerContinuationLaunch(owner);
  bindInitialLaunchAdmission(session, () => launchCurrent);
  // Actual Manager rendering must consume the original paid owner exactly once.
  // The recorder supplies only raw readonly process/PTY data to the real proof factories.
  vi.spyOn(mux, 'isPaneDead').mockImplementation(() => localDead);
  vi.spyOn(mux, 'capturePaneText').mockReturnValue('❯ retained unsent draft');
  const liveness = vi
    .spyOn(mux, 'readPaneLiveness')
    .mockImplementation(async () =>
      localDead ? { state: 'dead' } : { state: 'live', pid: mux.getSession(session.id)!.pid }
    );
  const realRespawn = mux.respawnPane.bind(mux),
    create = vi.spyOn(mux, 'createSession'),
    respawn = vi.spyOn(mux, 'respawnPane'),
    input = vi.spyOn(mux, 'sendInput');
  // Revoke the genuine launch request only after its mux dispatch and actual
  // public PTY listener registration. Real Session settlement must retain the
  // uncertain paid publication; no private field or denial DTO is assigned.
  transport.registered = () => {
    launchCurrent = false;
    transport.registered = undefined;
  };
  await expect(session.startInteractive()).rejects.toThrow('unconfirmed');
  expect(transport.exits).toHaveLength(1);
  expect(() => buildDockerLaunchCommand(launchOptions)).toThrow('already held');
  expect(custody.issued).toHaveLength(1);
  expect(custody.clients).toHaveLength(1);
  expect(session.providerDispatchHeld).toBe(true);
  expect(session.toState().providerDispatchHoldKind).toBe('intrinsic');
  expect(create).toHaveBeenCalledOnce();
  expect(respawn).not.toHaveBeenCalled();
  store.flush();
  const denial = JSON.parse(fs.readFileSync(path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY],
    retained = session.captureEmployeeRecoveryRetention(),
    intent = session.employeeRecoveryIntentSelector(),
    pane = mux.getSession(session.id);
  expect(denial.rows[session.id].transport).toBe('docker');
  expect(retained()).toBe(true);
  expect(pane).toBeDefined();
  transport.data[0]!('❯ retained unsent draft');
  const screen = session.terminalBuffer;
  // A real public PTY exit, not a writable Session field, establishes the lost
  // outer client. Native target liveness remains independently positive.
  localDead = originalDead;
  transport.exits[0]!({ exitCode: 1, signal: 0 });
  expect(session.pid).toBeNull();
  create.mockClear();
  vi.mocked(native.command.create).mockClear();
  vi.mocked(native.command.run).mockClear();
  // Keep the genuine mux dispatch/row checks; only local syscall observation is
  // controlled. The actual builder must select a private view, not paid owner.
  respawn.mockImplementation(async (options) => {
    expect(options.dockerContinuationLaunch).toBeUndefined();
    expect(options.dockerContinuationView).toBeDefined();
    const result = await realRespawn(options);
    const command = custody.issued.at(-1)!.command.argv;
    expect(command).toContain('/opt/reverie-worker-client/bin/node');
    expect(command).toContain(DOCKER_PROVIDER_VIEW_PROGRAM);
    expect(command).not.toContain('claude');
    expect(command).not.toContain('new-session');
    expect(command).not.toContain('respawn-pane');
    localDead = false;
    return result;
  });
  const capture = () => native.engine.captureProviderView(row, current),
    unchanged = () => {
      expect(mux.getSession(session.id)).toBe(pane);
      expect(session.muxName).toBe(pane!.muxName);
      expect(session.terminalBuffer).toBe(screen);
      expect(session.providerDispatchHeld).toBe(true);
      expect(session.toState().providerDispatchHoldKind).toBe('intrinsic');
      expect(retained()).toBe(true);
      expect(session.employeeRecoveryIntentSelector()).toBe(intent);
      owner.requireFor(session);
      expect(() => session.bindDockerContinuationLaunch(owner)).toThrow(
        'Original unopened Docker continuation required'
      );
      expect(() => buildDockerLaunchCommand(launchOptions)).toThrow('already held');
      store.flush();
      expect(JSON.parse(fs.readFileSync(path, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY]).toEqual(denial);
      expect(create).not.toHaveBeenCalled();
      expect(native.command.create).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(native.command.run)
          .mock.calls.some(
            ([args]) => args[0] === 'container' && ['start', 'stop', 'create', 'restart'].includes(args[1]!)
          )
      ).toBe(false);
      expect(input).not.toHaveBeenCalled();
      expect(transport.writes).toEqual([]);
    };
  return {
    native,
    canonicalCompany,
    companyFile,
    canonical,
    custody,
    session,
    mux,
    store,
    capture,
    unchanged,
    liveness,
    respawn,
    revoke: () => {
      nativeCurrent = false;
    },
  };
}

it('retains a genuinely claimed paid v3 launch and intrinsic uncertainty after the actual outer-client exit', async () => {
  const f = await paidFixture();
  f.unchanged();
  expect(f.session.pid).toBeNull();
  expect(f.respawn).not.toHaveBeenCalled();
});

it('repairs a paid v3 outer viewer with fresh engine/installer proof and no new provider dispatch', async () => {
  const f = await paidFixture(),
    view = await f.capture();
  expect(await f.session.reconnectDockerContinuationView(view, () => true, f.capture)).toBe(true);
  expect(f.session.pid).not.toBeNull();
  expect(f.session.dockerContinuationViewCurrent).toBe(true);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(transport.clients).toHaveLength(2);
  expect(vi.mocked(f.native.command.run).mock.calls.some(([args]) => args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))).toBe(
    true
  );
  f.unchanged();
});

it.each(['retained', 'deleted'] as const)(
  'keeps the published v3 target readable after retired-source cleanup: %s original',
  async (sourceState) => {
    const f = await paidFixture(true, true);
    const row = f.native.state.work!;
    expect(row.version).toBe(3);
    expect(row.phase).toBe('ready');
    expect(f.native.state.sourceStop?.phase).toBe('closed');
    expect(f.native.record.phase).toBe('completed');
    // Earn the real current target view and retire only the old Session view
    // before changing the controlled read-only Engine observation port.
    await f.capture();
    await f.native.retireSourceView();
    expect(f.native.old.providerDispatchHeld).toBe(true);
    expect(f.native.old.terminalInputHeld).toBe(true);
    const installed = await f.native.engine.planReplacementOriginal(row, () => {});
    if (sourceState === 'deleted') {
      const run = vi.mocked(f.native.command.run).getMockImplementation()!;
      vi.mocked(f.native.command.run).mockImplementation(async (args, input) => {
        if (args[0] === 'container' && args[1] === 'inspect' && args[2] === row.original.containerId)
          throw Error('Controlled Engine absence: the retired original container no longer exists');
        return run(args, input);
      });
    }
    await expect(f.native.engine.existingImage(row, () => {})).resolves.toEqual(row.workerImage);
    await expect(f.native.engine.observeStorage(row)).resolves.toBe('ready');
    await expect(
      f.native.engine.verifyPlanReplacementCanonicalAccount(row, installed.installedAuthDigest, () => {})
    ).resolves.toBeUndefined();
    const observed = await f.native.engine.observeDestination(row);
    expect(observed?.provider.kind).toBe('running');
    const binding = f.companyFile.snapshot().employees[0]!.dockerBinding!;
    const health = await f.native.engine.captureProviderHealth(row, binding, () => {});
    expect(health.require(f.companyFile.snapshot().employees[0]!)).toBe('live');
    const result = await f
      .capture()
      .then((view) => f.session.reconnectDockerContinuationView(view, () => true, f.capture))
      .then(
        (connected) => ({ connected, failure: undefined }),
        (failure: unknown) => ({ connected: false, failure })
      );
    f.unchanged();
    expect(result.failure).toBeUndefined();
    expect(result.connected).toBe(true);
    expect(f.session.dockerContinuationViewCurrent).toBe(true);
  }
);

function refuseRetiredOriginal(f: Awaited<ReturnType<typeof paidFixture>>) {
  const row = f.native.state.work!;
  const run = vi.mocked(f.native.command.run).getMockImplementation()!;
  vi.mocked(f.native.command.run).mockImplementation(async (args, input) => {
    if (args[0] === 'container' && args[1] === 'inspect' && args[2] === row.original.containerId)
      throw Error('Controlled retired original absence');
    return run(args, input);
  });
}

it('keeps work, installation, START and resource effects source-strict after publication', async () => {
  const f = await paidFixture(true, true),
    row = f.native.state.work!;
  refuseRetiredOriginal(f);
  await expect(f.capture()).resolves.toBeDefined();
  await expect(f.native.strictEngine.captureProviderView(row, () => {})).rejects.toThrow(
    'Controlled retired original absence'
  );
  await expect(f.native.strictEngine.existingImage(row, () => {})).rejects.toThrow(
    'Controlled retired original absence'
  );
  await expect(f.native.engine.prepareStorage(row, () => {})).rejects.toThrow('Controlled retired original absence');
  await expect(f.native.engine.configureResources(row, () => {})).rejects.toThrow(
    'Controlled retired original absence'
  );
  await expect(f.native.engine.start(row, () => {})).rejects.toThrow('Controlled retired original absence');
  await expect(f.native.engine.provisionIdentity(row, 'unissued', () => {})).rejects.toThrow(
    'Controlled retired original absence'
  );
  await expect(f.native.engine.captureProviderView({ ...row, phase: 'provider-issued' }, () => {})).rejects.toThrow(
    'Controlled retired original absence'
  );
  f.unchanged();
});

it.each(['owner', 'generation', 'binding', 'recipe', 'record'] as const)(
  'refuses a deleted-source read after actual canonical %s drift',
  async (drift) => {
    const f = await paidFixture(true, true),
      row = f.native.state.work!;
    const view = await f.capture();
    refuseRetiredOriginal(f);
    await f.companyFile.update((state) => {
      const employee = state.employees[0]!;
      if (drift === 'owner') employee.owner = 'different-owner';
      if (drift === 'generation') employee.sessionGeneration++;
      if (drift === 'binding') employee.dockerBinding!.containerId = 'f'.repeat(64);
      if (drift === 'recipe')
        employee.runtimeRecipe = RuntimeRecipeSchema.parse({ mode: 'claude', workingDir: '/different', configs: {} });
      if (drift === 'record') state.dockerEmployeeContinuations![0]!.sourceDigest = 'f'.repeat(64);
    });
    await expect(f.capture()).rejects.toThrow('Actual canonical published target changed');
    expect(() => view.require(row.request.sessionId, f.session.docker!)).toThrow();
    f.unchanged();
  }
);

it('keeps stopped historical image DATA separate from current published provider currency', async () => {
  const f = await paidFixture(true, true),
    row = f.native.state.work!;
  await f.companyFile.update((state) => {
    state.employees[0]!.sessionGeneration++;
  });
  await expect(f.native.engine.existingPlanSourceImage(row, () => {})).resolves.toEqual(row.workerImage);
  await expect(f.native.engine.existingImage(row, () => {})).rejects.toThrow(
    'Actual canonical published target changed'
  );
  await expect(f.capture()).rejects.toThrow('Actual canonical published target changed');
  await expect(
    f.native.engine.existingPlanSourceImage(row, () => {
      throw Error('Original requester revoked');
    })
  ).rejects.toThrow('Original requester revoked');
  refuseRetiredOriginal(f);
  await expect(f.native.engine.existingPlanSourceImage(row, () => {})).rejects.toThrow(
    'Controlled retired original absence'
  );
  f.unchanged();
});

it('rechecks actual canonical selection after a completed installer read await', async () => {
  const f = await paidFixture(true, true),
    row = f.native.state.work!;
  refuseRetiredOriginal(f);
  const run = vi.mocked(f.native.command.run).getMockImplementation()!;
  let changed = false;
  vi.mocked(f.native.command.run).mockImplementation(async (args, input) => {
    const result = await run(args, input);
    if (!changed && args[0] === 'exec' && args.includes('plan-status')) {
      changed = true;
      await f.companyFile.update((state) => {
        state.employees[0]!.sessionGeneration++;
      });
    }
    return result;
  });
  await expect(f.capture()).rejects.toThrow('Actual canonical published target changed');
  expect(changed).toBe(true);
  expect(f.companyFile.snapshot().employees[0]!.sessionGeneration).toBe(row.request.sessionGeneration + 1);
  f.unchanged();
});

it.each(['Pid', 'StartedAt', 'Config', 'Mounts'] as const)(
  'refuses native published %s drift between real provider observations',
  async (field) => {
    const f = await paidFixture(true, true),
      row = f.native.state.work!;
    refuseRetiredOriginal(f);
    const run = vi.mocked(f.native.command.run).getMockImplementation()!;
    let observed = false;
    vi.mocked(f.native.command.run).mockImplementation(async (args, input) => {
      const result = await run(args, input);
      if (args[0] === 'exec' && args.includes(DOCKER_PROVIDER_VIEW_PROGRAM)) observed = true;
      if (observed && args[0] === 'container' && args[1] === 'inspect' && args[2] === row.destination!.containerId) {
        const rows = JSON.parse(result);
        if (field === 'Pid') rows[0].State.Pid++;
        if (field === 'StartedAt') rows[0].State.StartedAt = '2026-11-16T00:01:00.000000000Z';
        if (field === 'Config') rows[0].Config.Env.push('UNSELECTED=1');
        if (field === 'Mounts') rows[0].Mounts[0].RW = !rows[0].Mounts[0].RW;
        return JSON.stringify(rows);
      }
      return result;
    });
    await expect(f.capture()).rejects.toThrow();
    expect(observed).toBe(true);
    f.unchanged();
  }
);

it.each(['Pid', 'StartedAt', 'installer'] as const)(
  'keeps missing native %s proof held without recreating it',
  async (field) => {
    const f = await paidFixture(true, true),
      row = f.native.state.work!;
    refuseRetiredOriginal(f);
    const run = vi.mocked(f.native.command.run).getMockImplementation()!;
    const task = row.tasks!.find((task) => task.role === 'identity-helper')!;
    if (task.phase !== 'completed') throw Error('Expected genuine completed installer');
    const installer = task.containerId;
    vi.mocked(f.native.command.run).mockImplementation(async (args, input) => {
      if (field === 'installer' && args[0] === 'container' && args[1] === 'inspect' && args[2] === installer)
        throw Error('Controlled missing completed installer');
      const result = await run(args, input);
      if (
        field !== 'installer' &&
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === row.destination!.containerId
      ) {
        const rows = JSON.parse(result);
        delete rows[0].State[field];
        return JSON.stringify(rows);
      }
      return result;
    });
    await expect(f.capture()).rejects.toThrow();
    f.unchanged();
  }
);

it('repairs only the lost website client while the original claimed paid outer command remains live', async () => {
  const f = await paidFixture(false),
    original = f.custody.issued[0]!;
  expect(original.command.argv).toContain('sh');
  expect(original.command.argv).toContain('-lc');
  expect(await f.session.reconnectDockerContinuationView(await f.capture(), () => true, f.capture)).toBe(true);
  expect(f.session.dockerContinuationViewCurrent).toBe(true);
  expect(f.respawn).not.toHaveBeenCalled();
  expect(f.custody.issued).toHaveLength(1);
  expect(f.custody.issued[0]).toBe(original);
  expect(f.custody.clients).toHaveLength(2);
  expect(transport.clients).toHaveLength(2);
  expect(f.session.pid).toBe(transport.clients[1]!.pid);
  f.unchanged();
});

it('keeps an explicit unknown-input fence held while repairing the paid v3 viewer', async () => {
  const f = await paidFixture(),
    service = new TerminalInputService(),
    intent = { input: 'must never be replayed', useMux: false, clientId: 'paid-view-fixture', seq: 1 },
    tag = { clientId: intent.clientId, seq: intent.seq, fingerprint: terminalInputFingerprint(intent) };
  f.session.holdUnconfirmedInput(Error('Original input reply unavailable'));
  expect(service.begin(f.session, intent, () => true).state).toBe('held');
  expect(service.inspect(f.session, tag, () => true)).toBe('held');
  expect(await f.session.reconnectDockerContinuationView(await f.capture(), () => true, f.capture)).toBe(true);
  expect(f.session.terminalInputHeld).toBe(true);
  expect(service.begin(f.session, intent, () => true).state).toBe('held');
  expect(service.inspect(f.session, tag, () => true)).toBe('held');
  f.unchanged();
});

it('rechecks admission after the actual final v3 read and settles only the same attached client on explicit retry', async () => {
  const f = await paidFixture();
  let allowed = true;
  await expect(
    f.session.reconnectDockerContinuationView(
      await f.capture(),
      () => allowed,
      async () => {
        const observed = await f.capture();
        allowed = false;
        return observed;
      }
    )
  ).rejects.toThrow('Original Docker viewer binding changed');
  expect(f.session.viewerInputHeld).toBe(true);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(transport.clients).toHaveLength(2);
  f.unchanged();
  allowed = true;
  expect(await f.session.reconnectDockerContinuationView(await f.capture(), () => allowed, f.capture)).toBe(true);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(transport.clients).toHaveLength(2);
  f.unchanged();
});

it('settles an unknown final observation on the same attached client without a second local respawn', async () => {
  const f = await paidFixture(),
    view = await f.capture();
  await expect(
    f.session.reconnectDockerContinuationView(
      view,
      () => true,
      async () => {
        throw Error('Final original view reply lost');
      }
    )
  ).rejects.toThrow('reply lost');
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(transport.clients).toHaveLength(2);
  expect(f.session.viewerInputHeld).toBe(true);
  expect(await f.session.reconnectDockerContinuationView(await f.capture(), () => true, f.capture)).toBe(true);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(transport.clients).toHaveLength(2);
  f.unchanged();
});

it('refuses revoked native proof before touching the lost paid viewer', async () => {
  const f = await paidFixture(),
    view = await f.capture();
  f.revoke();
  await expect(f.session.reconnectDockerContinuationView(view, () => true, f.capture)).rejects.toThrow(
    'Native target changed'
  );
  expect(f.respawn).not.toHaveBeenCalled();
  expect(transport.clients).toHaveLength(1);
  // The retained paid owner shares native currency, so its require now refuses.
  expect(f.session.providerDispatchHeld).toBe(true);
  expect(f.session.pid).toBeNull();
});
