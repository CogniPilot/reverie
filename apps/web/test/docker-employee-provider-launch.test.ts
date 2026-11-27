import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { shellescape } from '../src/docker-hosts.js';
import { EmployeeSchema } from '../src/company-types.js';
import { dockerEmployeeSourceDigest } from '../src/docker-employee-store.js';
import {
  captureDockerEmployeeProviderLaunch,
  DockerEmployeeProviderLaunch,
} from '../src/docker-employee-provider-launch.js';
import {
  TmuxManager,
  buildDockerLaunchCommand,
  buildSpawnCommand,
  buildDockerKillCommand,
  dockerProviderExitEvidenceCommands,
  DOCKER_PROVIDER_EXIT_EVIDENCE_SECONDS,
  DOCKER_PROVIDER_LAUNCH_WINDOW_SECONDS,
} from '../src/tmux-manager.js';
import { dockerProviderSocketLabel } from '../src/docker-employee-provider-view-native.js';
import { rebootRestoreLaunchConfig, rebootResumeTarget } from '../src/utils/native-thread-profile.js';
import { tmuxSourceCommands } from '../src/tmux-source-command.js';
import type { SessionDocker, SessionMode, SessionState } from '../src/types.js';
const eid = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000002',
  oid = '30000000-0000-4000-8000-000000000003';
const cid = 'a'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  digest = 'c'.repeat(64);
const sessions: Session[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const session of sessions.splice(0)) await session.stop(false);
});
function docker(): SessionDocker {
  return {
    hostId: 'boxed',
    label: 'Boxed',
    engine: 'docker',
    image,
    containerName: cid,
    hostWorkspacePath: '/',
    containerWorkdir: '/synthetic/work',
    network: 'bridge',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      operationId: oid,
      employeeId: eid,
      sessionGeneration: 7,
      clientManifestDigest: digest,
      apiUrl: 'http://boxed-office:3000',
    },
  };
}
function fixture(mode: 'claude' | 'codex' | 'hands' = 'claude') {
  const place = docker(),
    session = new Session({ id: sid, workingDir: place.containerWorkdir, mode: mode as SessionMode, docker: place });
  sessions.push(session);
  const binding = {
    version: 1 as const,
    operationId: oid,
    credentialId: '40000000-0000-4000-8000-000000000004',
    sessionId: sid,
    sessionGeneration: 7,
    containerId: cid,
    imageId: image,
    originalDigest: digest,
    policyDigest: digest,
  };
  const opts = {
    mode: mode as SessionMode,
    docker: place,
    sessionId: sid,
    createContext: {} as never,
    execEnv: {},
    execEnvNames: [],
    canonicalCommand: 'claude --model preserved --resume 55555555-5555-4555-8555-555555555555',
  };
  return { place, session, binding, opts };
}
describe('boxed original provider publication', () => {
  it.each([undefined, 'session-v1'] as const)(
    'uses the same fixed %s namespace for one original launch and later kill',
    (runtimeNamespace) => {
      const f = fixture();
      f.place.continuation!.planReplacement = {
        provider: 'anthropic',
        projectionDigest: '8'.repeat(64),
        ...(runtimeNamespace ? { runtimeNamespace } : {}),
      };
      const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
      const command = buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner });
      const label = dockerProviderSocketLabel(sid, runtimeNamespace);
      expect(command).toContain('start-server');
      expect(command).toContain('attach-session');
      expect(command.split(label)).toHaveLength(3);
      expect(buildDockerKillCommand({ docker: f.place, sessionId: sid })).toContain(
        '-L ' + shellescape(label) + ' kill-session'
      );
      expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
    }
  );
  it('pins the namespace inside the genuine one-shot Session owner', () => {
    const f = fixture();
    f.place.continuation!.planReplacement = {
      provider: 'anthropic',
      projectionDigest: '8'.repeat(64),
      runtimeNamespace: 'session-v1',
    };
    const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    delete f.place.continuation!.planReplacement.runtimeNamespace;
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow(
      'Original Docker Session changed'
    );
  });
  it.each([
    ['anthropic', 'claude', 'CLAUDE_CONFIG_DIR'],
    ['openai', 'codex', 'CODEX_HOME'],
  ] as const)(
    'routes %s through the fixed target generation without inheriting account secrets',
    (provider, mode, configKey) => {
      const f = fixture(mode),
        projectionDigest = '8'.repeat(64);
      f.place.continuation!.planReplacement = { provider, projectionDigest };
      const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
      const command = buildDockerLaunchCommand({
        ...f.opts,
        continuationLaunch: owner,
        execEnv: {
          ANTHROPIC_API_KEY: 'synthetic-wrong-key',
          OPENAI_BASE_URL: 'https://wrong.invalid',
          CLAUDE_CONFIG_DIR: '/old-source-home',
          CODEX_HOME: '/old-source-home',
          REVERIE_WORKER_IDENTITY_FILE: '/old-source-token',
          REVERIE_HOOK_GENERATION: 'fresh-managed-epoch',
          WORKSPACE_TOOL: 'keep',
        },
        execEnvNames: [
          'ANTHROPIC_AUTH_TOKEN',
          'OPENAI_API_KEY',
          'CLAUDE_CONFIG_DIR',
          'CODEX_HOME',
          'REVERIE_HOOK_GENERATION',
          'WORKSPACE_TOOL',
        ],
      });
      const root = '/home/agent/.reverie/plan-moves/' + oid + '/generation-' + projectionDigest;
      expect(command).toContain(configKey + '=' + root + (provider === 'anthropic' ? '/claude' : '/codex'));
      expect(command).toContain('REVERIE_WORKER_IDENTITY_FILE=' + root + '/worker-identity-' + cid);
      expect(command).toContain('REVERIE_HOOK_GENERATION=fresh-managed-epoch');
      expect(command).toContain('WORKSPACE_TOOL=keep');
      for (const forbidden of [
        'synthetic-wrong-key',
        'wrong.invalid',
        '/old-source-home',
        '/old-source-token',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
      ])
        expect(command).not.toContain(forbidden);
      expect(command).not.toContain('REVERIE_WORKER_IDENTITY_FILE=/home/agent/.reverie/docker-worker-identity');
    }
  );
  it('refuses changing the account generation after capturing the real Session launch owner', () => {
    const f = fixture();
    f.place.continuation!.planReplacement = { provider: 'anthropic', projectionDigest: '8'.repeat(64) };
    const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    f.place.continuation!.planReplacement.projectionDigest = '9'.repeat(64);
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow(
      'Original Docker Session changed'
    );
  });
  it.each([
    'CLAUDE_CODE_X;CONTROL_SENTINEL',
    'CLAUDE_CODE_X\nCONTROL_SENTINEL',
    'CLAUDE_CODE_X$(CONTROL_SENTINEL)',
    'CLAUDE_CODE_X`CONTROL_SENTINEL`',
    'CLAUDE_CODE_X=VALUE',
    'CLAUDE_CODE_X bad',
    '-CLAUDE_CODE_X',
    'CLAUDE_CODE_雪',
  ])('rejects malformed Docker environment name %j before consuming first-provider authority', (key) => {
    const f = fixture(),
      current = vi.fn(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, current);
    const calls = current.mock.calls.length;
    expect(() => buildDockerLaunchCommand({ ...f.opts, execEnvNames: [key], continuationLaunch: owner })).toThrow(
      'Invalid Docker environment name'
    );
    expect(current).toHaveBeenCalledTimes(calls);
    expect(
      buildDockerLaunchCommand({ ...f.opts, execEnvNames: ['CLAUDE_CODE_TOKEN'], continuationLaunch: owner })
    ).toContain('source-file -');
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
  });
  it('rejects malformed Docker environment map keys and ordinary Docker forwards without a transport effect', () => {
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    expect(() =>
      buildDockerLaunchCommand({
        ...f.opts,
        execEnv: { 'CLAUDE_CODE_X;CONTROL_SENTINEL': 'bounded' },
        continuationLaunch: owner,
      })
    ).toThrow('Invalid Docker environment name');
    expect(() =>
      buildDockerLaunchCommand({
        ...f.opts,
        docker: { ...f.place, continuation: undefined },
        execEnvNames: ['CLAUDE_CODE_X;CONTROL_SENTINEL'],
      })
    ).toThrow('Invalid Docker environment name');
    expect(buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toContain('source-file -');
  });

  function launched(mode: 'claude' | 'hands', canonicalCommand: string, execEnvNames: string[] = []) {
    const f = fixture(mode),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    let argv: readonly string[] = [];
    buildDockerLaunchCommand({
      ...f.opts,
      canonicalCommand,
      execEnvNames,
      continuationLaunch: owner,
      captureExecution: (command) => {
        argv = command.argv;
      },
    });
    const forwarded = argv.flatMap((value, index) => (argv[index - 1] === '--env' ? [value] : []));
    return { f, forwarded, script: argv.at(-1)!, target: 'reverie-dkr-' + sid };
  }
  it('gives a boxed admin harness its declared endpoint names by name only, and the model relay', () => {
    const names = ['REVERIE_HANDS_BASE_URL', 'REVERIE_HANDS_API_KEY', 'REVERIE_HANDS_MODEL'];
    const hands = launched('hands', 'reverie-hands', [...names, 'REVERIE_OWNER_TOKEN', 'REVERIE_DATA_DIR']);
    // A bare name makes the Docker client read the value from the pane's own
    // environment, so no endpoint value or key is ever part of the command.
    for (const name of names) expect(hands.forwarded).toContain(name);
    expect(hands.forwarded.some((value) => /^REVERIE_HANDS_[A-Z_]+=/.test(value))).toBe(false);
    expect(hands.forwarded.some((value) => /^REVERIE_(?:OWNER_TOKEN|DATA_DIR)/.test(value))).toBe(false);
    const relay =
      '{ [ -S /run/reverie-model/default.sock ] && REVERIE_MODEL_SOCKET=/run/reverie-model/default.sock ' +
      '/bin/reverie-model-relay >/dev/null 2>&1 & } ; ';
    expect(hands.script).toContain(
      tmuxSourceCommands([
        ['new-session', '-d', '-s', hands.target, '-c', hands.f.place.containerWorkdir, relay + 'reverie-hands'],
      ])
    );
    // A CLI on a subscription asks for no relay and gets no harness names.
    const claude = launched('claude', 'claude --resume x', names);
    expect(claude.script).not.toContain('reverie-model-relay');
    expect(claude.forwarded.some((value) => value.startsWith('REVERIE_HANDS_'))).toBe(false);
  });
  it('keeps the pane of a provider that dies at once, before that provider can start', () => {
    for (const mode of ['hands', 'claude'] as const) {
      const run = launched(mode, mode === 'hands' ? 'reverie-hands' : 'claude --resume x');
      const evidence = dockerProviderExitEvidenceCommands(run.target).map((command) => tmuxSourceCommands([command]));
      const session = run.script.indexOf('"new-session"');
      expect(session).toBeGreaterThan(0);
      for (const line of evidence) {
        const at = run.script.indexOf(line);
        expect(at, line).toBeGreaterThan(0);
        expect(at).toBeLessThan(session);
      }
    }
    expect(dockerProviderExitEvidenceCommands('reverie-dkr-' + sid)).toEqual([
      ['set-option', '-g', 'remain-on-exit', 'failed'],
      [
        'set-hook',
        '-g',
        'pane-died',
        'if-shell -F "#{e|<:#{e|-:#{pane_dead_time},#{session_created}},' +
          DOCKER_PROVIDER_LAUNCH_WINDOW_SECONDS +
          '}" "run-shell -d ' +
          DOCKER_PROVIDER_EXIT_EVIDENCE_SECONDS +
          " -C 'kill-session -t reverie-dkr-" +
          sid +
          '\'" "kill-session -t reverie-dkr-' +
          sid +
          '"',
      ],
    ]);
    expect(DOCKER_PROVIDER_LAUNCH_WINDOW_SECONDS).toBeGreaterThanOrEqual(60);
    expect(DOCKER_PROVIDER_EXIT_EVIDENCE_SECONDS).toBeLessThanOrEqual(3600);
    for (const target of ['reverie-dkr-x', 'other-' + sid, 'reverie-dkr-' + sid + '"; kill-server'])
      expect(() => dockerProviderExitEvidenceCommands(target)).toThrow('Fixed boxed provider session required');
  });
  it('saved Docker placement cannot admit an existing provider viewer or a first provider', () => {
    const f = fixture();
    expect(() => buildDockerLaunchCommand(f.opts)).toThrow('Original boxed provider view required');
  });
  it('emits a complete unheld API tuple without persisting that observation as authority', () => {
    const f = fixture();
    const wire = JSON.parse(JSON.stringify(f.session.toState()));
    expect(wire).toMatchObject({
      providerDispatchHeld: false,
      providerDispatchHoldKind: null,
      providerInputHeld: false,
    });
    const saved = f.session.toPersistedState();
    expect(Object.hasOwn(saved, 'providerDispatchHeld')).toBe(false);
    expect(Object.hasOwn(saved, 'providerDispatchHoldKind')).toBe(false);
    expect(Object.hasOwn(saved, 'providerInputHeld')).toBe(false);
  });
  it('one actual private Session owner admits canonical provider bytes once', () => {
    const f = fixture(),
      current = vi.fn(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, current);
    f.session.bindDockerContinuationLaunch(owner);
    const command = buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner });
    expect(command).toContain('source-file -');
    expect(command).toContain('preserved');
    expect(command).toContain('REVERIE_DOCKER_OPERATION_ID');
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
    expect(current).toHaveBeenCalled();
  });
  it.each([
    [
      'daemon',
      (value: SessionDocker): void => {
        value.daemonHost = 'unix:///other.sock';
      },
    ],
    [
      'image',
      (value: SessionDocker): void => {
        value.image = 'sha256:' + 'd'.repeat(64);
      },
    ],
    [
      'container',
      (value: SessionDocker): void => {
        value.containerName = 'e'.repeat(64);
      },
    ],
    [
      'workspace',
      (value: SessionDocker): void => {
        value.containerWorkdir = '/different';
      },
    ],
    [
      'network',
      (value: SessionDocker): void => {
        value.network = 'none';
      },
    ],
    [
      'credentials',
      (value: SessionDocker): void => {
        value.mountCredentials = true;
      },
    ],
    [
      'generation',
      (value: SessionDocker): void => {
        value.continuation!.sessionGeneration = 8;
      },
    ],
  ] as const)('rejects changed captured Docker %s without consuming the original owner', (_field, mutate) => {
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    const captured = structuredClone(f.place);
    mutate(captured);
    expect(() => buildDockerLaunchCommand({ ...f.opts, docker: captured, continuationLaunch: owner })).toThrow();
    expect(
      buildDockerLaunchCommand({ ...f.opts, docker: structuredClone(f.place), continuationLaunch: owner })
    ).toContain('source-file -');
    expect(() =>
      buildDockerLaunchCommand({ ...f.opts, docker: structuredClone(f.place), continuationLaunch: owner })
    ).toThrow('already held');
  });
  it('requires current private authority even for an unchanged captured Docker snapshot', () => {
    const f = fixture();
    let current = true;
    const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {
      if (!current) throw Error('owner revoked');
    });
    const captured = structuredClone(f.place);
    current = false;
    expect(() => buildDockerLaunchCommand({ ...f.opts, docker: captured, continuationLaunch: owner })).toThrow(
      'owner revoked'
    );
  });
  it('retains the actual private first-provider owner across public mux option capture', async () => {
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    const manager = new TmuxManager();
    const physical = vi
      .spyOn(
        manager as unknown as {
          _createSession(options: import('../src/mux-interface.js').CreateSessionOptions): Promise<never>;
        },
        '_createSession'
      )
      .mockImplementation(async (options) => {
        expect(options.dockerContinuationLaunch).toBe(owner);
        expect(options.docker).not.toBe(f.session.docker);
        expect(options.docker).toEqual(f.session.docker);
        const command = buildDockerLaunchCommand({
          ...f.opts,
          docker: options.docker!,
          continuationLaunch: options.dockerContinuationLaunch,
        });
        expect(command).toContain('new-session');
        throw Error('physical transport withheld');
      });
    try {
      await expect(
        manager.createSession({
          sessionId: sid,
          workingDir: f.place.containerWorkdir,
          mode: 'claude',
          docker: f.place,
          dockerContinuationLaunch: owner,
        })
      ).rejects.toThrow('physical transport withheld');
      expect(physical).toHaveBeenCalledOnce();
      expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
    } finally {
      physical.mockRestore();
    }
  });
  it.each([
    { method: 'startInteractive' as const, useMux: true },
    { method: 'startInteractive' as const, useMux: false },
    { method: 'startShell' as const, useMux: true },
    { method: 'startShell' as const, useMux: false },
  ])(
    'never falls back to a control-local PTY when a boxed mux is unavailable ($method, mux=$useMux)',
    async ({ method, useMux }) => {
      const f = fixture(),
        owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
      f.session.bindDockerContinuationLaunch(owner);
      Reflect.set(f.session, '_useMux', useMux);
      Reflect.set(f.session, '_mux', new TmuxManager());
      const subject = f.session as unknown as {
        _setupOrAttachMuxSession(): Promise<never>;
        _assertProviderLaunchAdmission(): void;
      };
      const mux = vi
        .spyOn(subject, '_setupOrAttachMuxSession')
        .mockRejectedValue(Error('original boxed mux unavailable'));
      const local = vi.spyOn(subject, '_assertProviderLaunchAdmission').mockImplementation(() => {
        throw Error('control-local PTY reached');
      });
      try {
        await expect(f.session[method]()).rejects.toThrow(
          useMux ? 'original boxed mux unavailable' : 'Boxed Docker provider requires its original multiplexer'
        );
        expect(local).not.toHaveBeenCalled();
        expect(f.session.pid).toBeNull();
      } finally {
        mux.mockRestore();
        local.mockRestore();
      }
    }
  );
  it('refuses an oversized program before consuming its actual first-provider owner', () => {
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    expect(() =>
      buildDockerLaunchCommand({ ...f.opts, canonicalCommand: 'x'.repeat(96 * 1024), continuationLaunch: owner })
    ).toThrow('Bounded exact UTF-8');
    expect(buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toContain('source-file -');
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
  });
  it('keeps the selected account while refusing loader and locale overrides for the managed tmux', () => {
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {});
    const command = buildDockerLaunchCommand({
      ...f.opts,
      continuationLaunch: owner,
      execEnv: {
        GCONV_PATH: '/synthetic/injected',
        OPENSSL_CONF: '/synthetic/private-openssl',
        LOCALE_ARCHIVE: '/synthetic/private-locale',
        CLAUDE_CONFIG_DIR: '/synthetic/account',
      },
      execEnvNames: ['GCONV_PATH', 'LOCALE_ARCHIVE', 'OPENSSL_CONF', 'CLAUDE_CONFIG_DIR'],
    });
    expect(command).not.toContain('/synthetic/injected');
    expect(command).not.toContain('/synthetic/private-locale');
    expect(command).not.toContain('/synthetic/private-openssl');
    expect(command).toContain('/synthetic/account');
    expect(command).toContain('/opt/reverie-worker-tools/share/locale/locale-archive');
    expect(command.match(/GCONV_PATH=/g)).toHaveLength(1);
    expect(command.match(/LOCALE_ARCHIVE=/g)).toHaveLength(1);
  });
  it('revoked currentness and destination substitution cannot consume another provider slot', () => {
    const f = fixture();
    let active = true;
    const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {
      if (!active) throw Error('revoked');
    });
    expect(() =>
      buildDockerLaunchCommand({
        ...f.opts,
        docker: { ...f.place, containerName: 'd'.repeat(64) },
        continuationLaunch: owner,
      })
    ).toThrow();
    active = false;
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('revoked');
    expect(() => Object.create(DockerEmployeeProviderLaunch.prototype).claim(sid, f.place)).toThrow();
  });
  it.each([
    { placement: 'boxed', nativeEnvironment: true, requested: undefined, expected: false },
    { placement: 'boxed', nativeEnvironment: true, requested: false, expected: false },
    { placement: 'boxed', nativeEnvironment: true, requested: true, expected: true },
    { placement: 'boxed', nativeEnvironment: false, requested: true, expected: true },
    { placement: 'ordinary', nativeEnvironment: true, requested: undefined, expected: false },
    { placement: 'ordinary', nativeEnvironment: true, requested: true, expected: false },
    { placement: 'ordinary', nativeEnvironment: false, requested: true, expected: false },
  ])(
    'retains only an explicit boxed viewer fence ($placement, native=$nativeEnvironment, requested=$requested)',
    ({ placement, nativeEnvironment, requested, expected }) => {
      vi.stubEnv('REVERIE_WORKER_SOCKET', nativeEnvironment ? '/synthetic/native.sock' : undefined);
      const place = docker();
      if (placement === 'ordinary') delete place.continuation;
      const session = new Session({
        id: sid,
        workingDir: '/synthetic/work',
        mode: 'claude',
        docker: place,
        viewerInputHeld: requested,
      });
      sessions.push(session);
      expect(session.viewerInputHeld).toBe(expected);
      expect(session.toState().viewerInputHeld).toBe(expected);
      const saved = session.toPersistedState();
      expect(saved.viewerInputHeld).toBe(expected);
      // Actual saved-state reconstruction must retain the boxed fence even when
      // the controller no longer has a global native-worker deployment setting.
      vi.stubEnv('REVERIE_WORKER_SOCKET', undefined);
      const restored = new Session({ ...saved });
      sessions.push(restored);
      expect(restored.viewerInputHeld).toBe(expected);
      expect(restored.toState().viewerInputHeld).toBe(expected);
    }
  );
  it('normal same-thread Session construction keeps the source recipe correlation stable', () => {
    const employee = EmployeeSchema.parse({
      id: eid,
      name: 'Synthetic',
      icon: 'S',
      position: 'Employee',
      expertise: ['testing'],
      sessionId: sid,
      sessionGeneration: 7,
      createdAt: 1,
    });
    const saved = {
      id: sid,
      workingDir: '/synthetic/work',
      mode: 'claude',
      status: 'stopped',
      pid: null,
      createdAt: 1,
      claudeSessionChain: ['55555555-5555-4555-8555-555555555555'],
      __envOverrides: { CLAUDE_CONFIG_DIR: '/synthetic/account' },
    } as unknown as SessionState;
    const target = rebootResumeTarget(saved)!;
    const session = new Session({
      ...saved,
      ...rebootRestoreLaunchConfig(saved, target),
      docker: docker(),
      envOverrides: (saved as never as { __envOverrides: Record<string, string> }).__envOverrides,
    });
    sessions.push(session);
    const source = dockerEmployeeSourceDigest(employee, saved);
    expect(dockerEmployeeSourceDigest(employee, session.toPersistedState())).toBe(source);
    expect(
      dockerEmployeeSourceDigest(employee, { ...saved, claudeSessionChain: ['66666666-6666-4666-8666-666666666666'] })
    ).not.toBe(source);
    expect(
      dockerEmployeeSourceDigest(employee, {
        ...saved,
        __envOverrides: { CLAUDE_CONFIG_DIR: '/foreign/account' },
      } as unknown as SessionState)
    ).not.toBe(source);
  });
});

describe('boxed provider command contract', () => {
  it('pins both actual control invocations and the captured exec vector despite a private provider daemon', () => {
    const privateEndpoint = 'unix:///private-worker/docker.sock';
    vi.stubEnv('DOCKER_HOST', privateEndpoint);
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {}),
      captured = vi.fn<(command: import('../src/docker-viewer-pane.js').DockerViewerCommand) => void>(),
      command = buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner, captureExecution: captured });
    expect(captured).toHaveBeenCalledOnce();
    const actual = captured.mock.calls[0]![0];
    expect(actual.shellCommand).toBe(command);
    expect(actual.argv.slice(0, 7)).toEqual([
      '/bin/docker',
      '--host',
      'unix:///run/reverie-engine/docker.sock',
      'exec',
      '-it',
      '--workdir',
      f.place.containerWorkdir,
    ]);
    const target = actual.argv.indexOf(cid);
    expect(target).toBeGreaterThan(6);
    expect(actual.argv.slice(target, target + 3)).toEqual([cid, 'sh', '-lc']);
    expect(actual.argv.at(-1)).toContain(f.opts.canonicalCommand);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.argv)).toBe(true);
    // The shell's independent image/running/CID check must select the same
    // control Engine and exact container as the actual captured exec request.
    const inspect =
      "'/bin/docker' '--host' 'unix:///run/reverie-engine/docker.sock' inspect -f '{{.Image}} {{.State.Running}} {{.Id}}' '" +
      cid +
      "' | grep -Fx '" +
      image +
      ' true ' +
      cid +
      "'";
    expect(command).toBe(inspect + ' && exec ' + actual.argv.map(shellescape).join(' '));
    expect(command).not.toContain(privateEndpoint);
    expect(actual.argv).not.toContain(privateEndpoint);
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
  });
  it.each(['daemon', 'context'] as const)(
    'refuses a %s redirect before emitting or consuming a boxed command',
    (selection) => {
      const f = fixture(),
        owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {}),
        captured = vi.fn(),
        redirected = structuredClone(f.place);
      if (selection === 'daemon') redirected.daemonHost = 'unix:///private-worker/docker.sock';
      else redirected.context = 'private-worker';
      expect(() =>
        buildDockerLaunchCommand({
          ...f.opts,
          docker: redirected,
          continuationLaunch: owner,
          captureExecution: captured,
        })
      ).toThrow('Fixed boxed Docker command required');
      expect(captured).not.toHaveBeenCalled();
      const command = buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner, captureExecution: captured });
      expect(command).toContain('source-file -');
      expect(captured).toHaveBeenCalledOnce();
      expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow('already held');
    }
  );
  it('folds fixed capsule hooks into the same Claude settings value as advisor/effort without a HOME writer', () => {
    const command = buildSpawnCommand({
      mode: 'claude',
      sessionId: sid,
      resumeSessionId: '55555555-5555-4555-8555-555555555555',
      boxedWorkerHooks: true,
      advisorModel: 'claude-opus-4-6',
    });
    expect(command).toContain('/opt/reverie-worker-client/bin/reverie worker-callback hook-event');
    expect(command).toContain('worker-callback status-telemetry');
    expect(command).not.toMatch(/statusline-exporter.sh|REVERIE_HOOK_SECRET|curl|settings.json/);
    // Two bounded resume candidates plus the fresh branch each render one
    // settings value; the selector executes exactly one candidate.
    expect(command.match(/--settings/g)).toHaveLength(3);
    expect(command.match(/advisorModel/g)).toHaveLength(3);
  });
  it('holds command construction during or after an unconfirmed workspace observation without consuming launch', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    const reader = vi.fn(
      () =>
        new Promise<never>((_, deny) => {
          reject = deny;
        })
    );
    const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {}, reader);
    const preparation = DockerEmployeeProviderLaunch.prototype.prepareCodexWorkspace.call(owner, f.session);
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow(
      'workspace observation held'
    );
    reject(Error('read outcome unknown'));
    await expect(preparation).rejects.toThrow('read outcome unknown');
    expect(() => buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner })).toThrow(
      'workspace observation held'
    );
    await expect(DockerEmployeeProviderLaunch.prototype.prepareCodexWorkspace.call(owner, f.session)).rejects.toThrow(
      'unopened'
    );
    expect(reader).toHaveBeenCalledOnce();
  });
  it('counts the pane of a continued provider as its viewer after the continuation grant has ended', () => {
    const f = fixture();
    let granted = true;
    const owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {
      if (!granted) throw Error('Continuation grant ended');
    });
    f.session.bindDockerContinuationLaunch(owner);
    const issued = (binding = f.binding) =>
      DockerEmployeeProviderLaunch.prototype.issuedFor.call(owner, f.session, binding);
    // Not yet claimed by a pane: nothing was launched.
    expect(issued()).toBe(false);
    buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner });
    expect(issued()).toBe(true);
    // The restoration pass runs after the continuation request has finished and its grant has ended.
    granted = false;
    expect(issued()).toBe(true);
    // Only exactly this binding: another operation, generation or container is not this launch.
    expect(issued({ ...f.binding, operationId: '50000000-0000-4000-8000-000000000005' })).toBe(false);
    expect(issued({ ...f.binding, sessionGeneration: 8 })).toBe(false);
    expect(issued({ ...f.binding, containerId: 'd'.repeat(64) })).toBe(false);
    // The Session reads it only while a pane of its own is open and no separate view stands for it.
    expect(f.session.dockerContinuationLaunchedFor(f.binding)).toBe(false);
    (f.session as unknown as { _muxSession: unknown })._muxSession = { sessionId: sid };
    expect(f.session.dockerContinuationLaunchedFor(f.binding)).toBe(true);
    expect(f.session.dockerContinuationViewCurrent).toBe(false);
    (f.session as unknown as { _viewerClientLost: boolean })._viewerClientLost = true;
    expect(f.session.dockerContinuationLaunchedFor(f.binding)).toBe(false);
    (f.session as unknown as { _viewerClientLost: boolean })._viewerClientLost = false;
    f.place.continuation!.operationId = '50000000-0000-4000-8000-000000000005';
    expect(f.session.dockerContinuationLaunchedFor(f.binding)).toBe(false);
    (f.session as unknown as { _muxSession: unknown })._muxSession = null;
  });
});
