import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { EmployeeSchema } from '../src/company-types.js';
import { dockerEmployeeSourceDigest } from '../src/docker-employee-store.js';
import {
  captureDockerEmployeeProviderLaunch,
  DockerEmployeeProviderLaunch,
} from '../src/docker-employee-provider-launch.js';
import { TmuxManager, buildDockerLaunchCommand, buildSpawnCommand } from '../src/tmux-manager.js';
import { rebootRestoreLaunchConfig, rebootResumeTarget } from '../src/utils/native-thread-profile.js';
import type { SessionDocker, SessionState } from '../src/types.js';
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
function fixture() {
  const place = docker(),
    session = new Session({ id: sid, workingDir: place.containerWorkdir, mode: 'claude', docker: place });
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
    mode: 'claude' as const,
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
  it('saved Docker placement cannot admit an existing provider viewer or a first provider', () => {
    const f = fixture();
    expect(() => buildDockerLaunchCommand(f.opts)).toThrow('Original boxed provider view required');
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
        const command = buildDockerLaunchCommand({ ...f.opts, continuationLaunch: options.dockerContinuationLaunch });
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
  it('explicit Docker binding does not inherit a globally configured native viewer hold', () => {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic/native.sock');
    const session = new Session({
      id: sid,
      workingDir: '/synthetic/work',
      mode: 'claude',
      docker: docker(),
      viewerInputHeld: true,
    });
    sessions.push(session);
    expect(session.toState().viewerInputHeld).not.toBe(true);
  });
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
  it('pins the control Engine even when the provider environment selects a private nested daemon', () => {
    vi.stubEnv('DOCKER_HOST', 'unix:///private-worker/docker.sock');
    const f = fixture(),
      owner = captureDockerEmployeeProviderLaunch(f.session, f.binding, () => {}),
      command = buildDockerLaunchCommand({ ...f.opts, continuationLaunch: owner });
    expect(command.split('unix:///run/reverie-engine/docker.sock').slice(1)).toHaveLength(2);
    expect(command.match(/-H /g)).toHaveLength(2);
    expect(command).not.toContain('/private-worker');
  });
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
});
