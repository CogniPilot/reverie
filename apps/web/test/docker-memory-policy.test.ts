import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerMemoryFlags, validateDockerMemory } from '../src/docker-memory-policy.js';
import {
  buildDockerCreateArgs,
  buildDockerMemoryCheck,
  dockerConfigHash,
  toSessionDocker,
} from '../src/docker-hosts.js';
import { DockerHostSchema } from '../src/web/schemas.js';
import type { DockerCreateContext } from '../src/docker-hosts.js';
import type { DockerResourceLimits } from '../src/types.js';

const profile = { id: 'local', label: 'Local', image: 'reverie/agent:base' };

function context(resources: DockerResourceLimits): DockerCreateContext {
  return {
    docker: toSessionDocker(
      { ...profile, resources },
      {
        name: 'project',
        type: 'docker',
        hostId: 'local',
        hostWorkspacePath: '/work/project',
      }
    ),
    sessionId: '12345678-1111-2222-3333-444444444444',
    instance: '',
    userArgs: ['--user', '1000:0'],
    credentialMounts: [],
    extraMounts: [],
    envCreate: {},
    addHostGateway: false,
    gatewayAlias: 'host.docker.internal',
  };
}

describe('ordinary laptop memory policy', () => {
  it('preserves the complete legacy fixed-RAM/no-swap argument pair', () => {
    expect(dockerMemoryFlags({ memory: '4g' })).toEqual(['--memory', '4g', '--memory-swap', '4g']);
    expect(dockerMemoryFlags({ memory: '4g' }, true)).toEqual(['--memory', '4g']);
    expect(dockerMemoryFlags({})).toEqual([]);
  });

  it('issues a distinct normal share, borrowing ceiling and bounded 16-GiB backup', () => {
    expect(dockerMemoryFlags({ memory: '32g', memoryReservation: '1536m' })).toEqual([
      '--memory',
      '32g',
      '--memory-reservation',
      '1536m',
      '--memory-swap',
      '51539607552',
    ]);
  });

  it('treats explicit swap as total RAM plus swap, including an explicit no-swap choice', () => {
    expect(dockerMemoryFlags({ memory: '32g', memoryReservation: '4g', memorySwap: '40g' }).slice(-2)).toEqual([
      '--memory-swap',
      '40g',
    ]);
    expect(dockerMemoryFlags({ memory: '32g', memorySwap: '32g' }).slice(-2)).toEqual(['--memory-swap', '32g']);
  });

  it('retains explicitly selected compatibility mode without pretending an explicit bound was enforced', () => {
    expect(dockerMemoryFlags({ memory: '32g', memoryReservation: '4g' }, true)).toEqual([
      '--memory',
      '32g',
      '--memory-reservation',
      '4g',
    ]);
    expect(() => dockerMemoryFlags({ memory: '32g', memoryReservation: '4g', memorySwap: '48g' }, true)).toThrow(
      'cannot be enforced'
    );
  });

  it.each<DockerResourceLimits>([
    { memoryReservation: '4g' },
    { memorySwap: '8g' },
    { memory: '4g', memoryReservation: '4096m' },
    { memory: '4g', memoryReservation: '8g' },
    { memory: '4g', memorySwap: '4095m' },
    { memory: '0' },
    { memory: '5m' },
    { memory: '1025g' },
    { memory: '1024g', memoryReservation: '4g' },
    { memory: '4g', memorySwap: '-1' },
    { memory: '4g', memoryReservation: '0m' },
    { memory: '4g', memoryReservation: '5m' },
    { memory: '4g; printf unsafe' },
    { memory: '4g', memorySwap: '8g$(id)' },
    { memory: '4g', memoryReservation: '1.5g' },
    { memory: '4g', memoryReservation: '1g\n' },
  ])('refuses invalid or ambiguous memory policy before command assembly: %j', (resources) => {
    expect(() => validateDockerMemory(resources)).toThrow();
    expect(() => buildDockerCreateArgs(context(resources))).toThrow();
  });

  it('compares mixed units exactly and accepts integer MiB sizes for fractional GiB shares', () => {
    expect(() =>
      validateDockerMemory({ memory: '04G', memoryReservation: '4095m', memorySwap: '4294967296b' })
    ).not.toThrow();
  });

  it('round-trips the new resource fields through the actual host API schema and session projection', () => {
    const resources = { memory: '32g', memoryReservation: '1536m', memorySwap: '48g' };
    const host = DockerHostSchema.parse({ ...profile, resources });
    expect(host.resources).toEqual(resources);
    expect(context(host.resources!).docker.resources).toEqual(resources);
    expect(
      DockerHostSchema.safeParse({ ...profile, resources: { memory: '4g', memoryReservation: '4g' } }).success
    ).toBe(false);
  });

  it('passes numeric policy values as exact shell tokens in the real create command builder', () => {
    const args = buildDockerCreateArgs(context({ memory: '32g', memoryReservation: '1536m', memorySwap: '48g' }));
    // Parse only with shell builtins; no engine, container, host policy or provider runs.
    const tokens = execFileSync('bash', ['-c', `set -- ${args.join(' ')}; printf '%s\\0' "$@"`])
      .toString()
      .split('\0')
      .slice(0, -1);
    for (const [flag, value] of [
      ['--memory', '32g'],
      ['--memory-reservation', '1536m'],
      ['--memory-swap', '48g'],
    ]) {
      expect(tokens.filter((token) => token === flag)).toHaveLength(1);
      expect(tokens[tokens.indexOf(flag) + 1]).toBe(value);
    }
    expect(tokens).not.toContain('--oom-kill-disable');
    expect(tokens).not.toContain('--privileged');
    expect(tokens).not.toContain('--cgroup-conf');
  });

  it('marks changes to either new field as drift instead of silently reusing a fixed-cap laptop', () => {
    const current = context({ memory: '32g' }).docker;
    expect(dockerConfigHash({ ...current, resources: { memory: '32g', memoryReservation: '4g' } })).not.toBe(
      dockerConfigHash(current)
    );
    expect(dockerConfigHash({ ...current, resources: { memory: '32g', memorySwap: '48g' } })).not.toBe(
      dockerConfigHash(current)
    );
  });

  it('executes the launch readback against a fake engine and refuses ignored limits, extra lines and failed inspect', () => {
    // Nix provides Bash on PATH without requiring /bin/bash or /bin/sh.
    // Use that exact interpreter for both the check and its executable fixture.
    const bash = execFileSync('bash', ['-c', 'printf "%s" "$BASH"'], { encoding: 'utf8' });
    const directory = mkdtempSync(join(tmpdir(), 'laptop-memory-check-'));
    try {
      writeFileSync(
        join(directory, 'docker'),
        `#!${bash}\nprintf "%s\\n" "$FAKE_MEMORY_ROW"\nexit "$FAKE_MEMORY_EXIT"\n`,
        { mode: 0o700 }
      );
      const docker = context({ memory: '32g', memoryReservation: '4g', memorySwap: '48g' }).docker;
      const check = buildDockerMemoryCheck(docker);
      for (const [row, code, success] of [
        ['34359738368:4294967296:51539607552', '0', true],
        ['4294967296:0:4294967296', '0', false],
        ['34359738368:0:51539607552', '0', false],
        ['34359738368:4294967296:-1', '0', false],
        ['34359738368:4294967296:51539607552\nextra', '0', false],
        ['34359738368:4294967296:51539607552', '1', false],
        ['', '0', false],
      ] as const) {
        const result = spawnSync(bash, ['-c', check], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            FAKE_MEMORY_ROW: row,
            FAKE_MEMORY_EXIT: code,
          },
        });
        expect(result.error, JSON.stringify({ row, code, error: result.error?.message })).toBeUndefined();
        expect(result.status === 0, JSON.stringify({ row, code, stderr: result.stderr })).toBe(success);
      }
      // Legacy and adopted containers keep their existing paths; this is not
      // permission to change a container the owner adopted from elsewhere.
      expect(buildDockerMemoryCheck(context({ memory: '4g' }).docker)).toBe('');
      expect(buildDockerMemoryCheck({ ...docker, owned: false })).toBe('');
      expect(check).not.toContain('$');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
