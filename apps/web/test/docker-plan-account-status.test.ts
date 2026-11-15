import fs from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM,
  DockerPlanAccountStatus,
  dockerPlanAccountStatusArguments,
} from '../src/docker-plan-account-status.js';
import { DOCKER_PROVIDER_VIEW_ENV } from '../src/docker-employee-provider-view-native.js';
const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
const selection = {
  operationId: '10000000-0000-4000-8000-000000000001',
  projectionDigest: 'a'.repeat(64),
  containerId: 'b'.repeat(64),
  provider: 'anthropic' as const,
};
describe('fixed selected-account observer argv', () => {
  it('keeps existing environment argument pairs exactly once instead of nesting --env as a value', () => {
    const args = dockerPlanAccountStatusArguments(selection);
    expect(args.slice(1, 1 + DOCKER_PROVIDER_VIEW_ENV.length)).toEqual(DOCKER_PROVIDER_VIEW_ENV);
    for (let i = 1; i < args.indexOf('--workdir'); i += 2) {
      expect(args[i]).toBe('--env');
      expect(args[i + 1]).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
    }
    expect(args).toContain(
      'CLAUDE_CONFIG_DIR=/home/agent/.reverie/plan-moves/' +
        selection.operationId +
        '/generation-' +
        selection.projectionDigest +
        '/claude'
    );
    expect(args).toContain('/opt/reverie-worker-client/bin/node');
    expect(args.at(-1)).toBe('anthropic');
  });
  it('refuses unrecognized generation selectors before any command', () => {
    expect(() => dockerPlanAccountStatusArguments({ ...selection, containerId: 'b' })).toThrow();
    expect(() => dockerPlanAccountStatusArguments({ ...selection, provider: 'foreign' as never })).toThrow();
  });
});
describe.runIf(process.platform === 'linux')(
  'actual fixed Node stock-status adapter over private executable fixtures',
  () => {
    function run(provider: string, body: string) {
      const dir = fs.mkdtempSync(join(tmpdir(), 'plan-status-'));
      paths.push(dir);
      fs.chmodSync(dir, 0o700);
      fs.mkdirSync(join(dir, 'bin'), { mode: 0o700 });
      fs.writeFileSync(
        join(dir, 'bin', provider === 'openai' ? 'codex' : 'claude'),
        '#!' + process.execPath + '\n' + body,
        { mode: 0o700 }
      );
      return spawnSync(
        process.execPath,
        ['--input-type=commonjs', '-e', DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM, '--', provider],
        {
          encoding: 'utf8',
          timeout: 12000,
          env: { PATH: join(dir, 'bin') + delimiter + (process.env.PATH ?? ''), HOME: dir },
        }
      );
    }
    it('accepts actual Claude JSON status without emitting any extra private fields', () => {
      const r = run(
        'anthropic',
        `process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty',email:'synthetic@example.invalid',private:'SYNTHETIC_PRIVATE'}));`
      );
      expect(r.status).toBe(0);
      expect(DockerPlanAccountStatus.parse(JSON.parse(r.stdout))).toEqual({
        version: 1,
        purpose: 'reverie-plan-account-status-v1',
        provider: 'anthropic',
        authenticated: true,
      });
      expect(r.stdout + r.stderr).not.toContain('SYNTHETIC_PRIVATE');
    });
    it('handles real Codex-style successful status on stderr', () => {
      const r = run('openai', `process.stderr.write('Logged in using ChatGPT\\n');`);
      expect(r.status).toBe(0);
      expect(DockerPlanAccountStatus.parse(JSON.parse(r.stdout)).provider).toBe('openai');
    });
    it.each([
      `process.stdout.write(JSON.stringify({loggedIn:false,authMethod:'oauth_token',apiProvider:'firstParty'}));`,
      `process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'bedrock'}));`,
      `process.stdout.write('SYNTHETIC_PRIVATE malformed');`,
      `process.stderr.write('SYNTHETIC_PRIVATE refused');process.exitCode=1;`,
    ])('refuses status without forwarding provider errors or account data (%s)', (body) => {
      const r = run('anthropic', body);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('Native selected account status unconfirmed\n');
    });
    it('refuses Codex logged-out status even when its process exits zero', () => {
      const r = run('openai', `process.stderr.write('Not logged in\\n');`);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
    });
  }
);
