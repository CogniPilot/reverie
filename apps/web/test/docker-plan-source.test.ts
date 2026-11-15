import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { DOCKER_PLAN_INIT_PROGRAM } from '../src/docker-plan-source.js';
import { dockerPlanSourceFixture as fixture } from './helpers/docker-plan-source-fixture.js';
const hex = (c: string) => c.repeat(64),
  uuid = (n: number) => n.toString().padStart(8, '0') + '-0000-4000-8000-000000000001';
describe('native plan source observation independent of disposable viewer', () => {
  it('permits explicit force when actual bound init is healthy and viewer is absent', async () => {
    const f = fixture();
    const proof = await f.reader.capture(f.row, f.binding, () => {}, true);
    expect(proof.observation(f.row, f.binding)).toEqual({
      kind: 'running',
      init: { pid: 100, startTicks: '123' },
      provider: { kind: 'unobserved' },
    });
    expect(f.qualifyImage).toHaveBeenCalledOnce();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.command.run)
        .mock.calls.every(([a]) => ['exec', 'container'].includes(a[0]!) && a[1] !== 'start' && a[1] !== 'stop')
    ).toBe(true);
  });
  it('accepts a genuinely stopped CID for force without inventing a birth or viewer', async () => {
    const f = fixture(false),
      proof = await f.reader.capture(f.row, f.binding, () => {}, true);
    expect(proof.observation(f.row, f.binding)).toMatchObject({
      kind: 'stopped',
      terminalStateDigest: expect.any(String),
    });
    expect(f.view).not.toHaveBeenCalled();
    expect(vi.mocked(f.command.run).mock.calls.every(([a]) => a[0] === 'container' && a[1] === 'inspect')).toBe(true);
  });
  it.each([true, false])(
    'refuses cooperative move when source has no genuine busy/idle provider proof (running=%s)',
    async (running) => {
      const f = fixture(running);
      await expect(f.reader.capture(f.row, f.binding, () => {}, false)).rejects.toThrow();
    }
  );
  it.each([
    'CID',
    'operation',
    'generation',
    'image',
    'home',
    'restart',
    'manifest',
    'malformed',
    'init-change',
  ] as const)('refuses changed actual %s without effects', async (change) => {
    const f = fixture();
    if (change === 'CID') f.raw.Id = hex('0');
    if (change === 'operation') f.raw.Config.Labels!['reverie.boxed.operation'] = uuid(7);
    if (change === 'generation') f.raw.Config.Labels!['reverie.boxed.generation'] = '2';
    if (change === 'image') f.raw.Image = 'sha256:' + hex('0');
    if (change === 'home') f.raw.Mounts[0]!.Source = '/foreign';
    if (change === 'restart') f.raw.HostConfig.RestartPolicy = { Name: 'always' };
    if (change === 'manifest') f.raw.Config.Labels!['org.reverie.worker-client.manifest'] = hex('0');
    if (change === 'malformed') f.raw.State.Pid = 'unknown';
    if (change === 'init-change') f.afterInit(() => f.ticks('456'));
    await expect(f.reader.capture(f.row, f.binding, () => {}, true)).rejects.toThrow();
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('cannot downgrade a revocation during failed view capture to force authority', async () => {
    const f = fixture();
    let current = true;
    f.view.mockImplementation(async () => {
      current = false;
      throw Error('viewer absent');
    });
    await expect(
      f.reader.capture(
        f.row,
        f.binding,
        () => {
          if (!current) throw Error('revoked');
        },
        true
      )
    ).rejects.toThrow('revoked');
  });
  it('uses actual bound source image and revokes a retained proof when canonical scope changes', async () => {
    const f = fixture();
    let current = true;
    const proof = await f.reader.capture(
      f.row,
      f.binding,
      () => {
        if (!current) throw Error('changed');
      },
      true
    );
    current = false;
    expect(() => proof.require(f.row, f.binding)).toThrow('changed');
    current = true;
    expect(() => proof.require(f.row, f.binding)).toThrow();
  });
});
describe('fixed init read program', () => {
  function run(change?: string) {
    let reads = 0,
      output = '';
    const fs = {
      statfsSync: () => ({ type: change === 'proc' ? 0 : 0x9fa0 }),
      lstatSync: (path: string) => ({
        uid: 0,
        mode: path.endsWith('/node') ? 0o555 : 0o755,
        isDirectory: () => !path.endsWith('/node'),
        isFile: () => path.endsWith('/node'),
      }),
      readFileSync: (path: string) => {
        if (path.endsWith('/status'))
          return (
            'NoNewPrivs:\t' +
            (change === 'nnp' ? '0' : '1') +
            '\n' +
            ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']
              .map((k) => k + ':\t' + (change === 'caps' ? '1' : '0000000000000000'))
              .join('\n')
          );
        reads++;
        return (
          '1 (init) ' + ['S', ...Array<string>(18).fill('0'), change === 'birth' && reads > 1 ? '456' : '123'].join(' ')
        );
      },
    };
    vm.runInNewContext(DOCKER_PLAN_INIT_PROGRAM, {
      require: (name: string) => {
        if (name !== 'node:fs') throw Error('unexpected import');
        return fs;
      },
      process: {
        stdout: {
          write: (s: string) => {
            output += s;
          },
        },
      },
    });
    return output;
  }
  it('reads exact procfs init birth twice without writes, tmux or provider dispatch', () => {
    expect(run()).toBe('{"startTicks":"123"}\n');
  });
  it.each(['proc', 'nnp', 'caps', 'birth'])('refuses %s mismatch with no receipt', (change) => {
    expect(() => run(change)).toThrow();
  });
});
