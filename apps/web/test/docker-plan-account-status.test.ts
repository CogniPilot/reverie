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
    expect(() => dockerPlanAccountStatusArguments(selection, 'foreign' as never)).toThrow();
    expect(dockerPlanAccountStatusArguments({ ...selection, provider: 'openai' }, 'initial').slice(-2)).toEqual([
      'openai',
      'initial',
    ]);
  });
});
describe.runIf(process.platform === 'linux')(
  'actual fixed Node stock-status adapter over private executable fixtures',
  () => {
    function run(provider: string, body: string, mode?: 'initial', prepare?: (dir: string) => void) {
      const dir = fs.mkdtempSync(join(tmpdir(), 'plan-status-'));
      paths.push(dir);
      fs.chmodSync(dir, 0o700);
      fs.mkdirSync(join(dir, 'bin'), { mode: 0o700 });
      fs.mkdirSync(join(dir, 'config'), { mode: 0o700 });
      fs.writeFileSync(join(dir, 'config/auth.json'), 'SYNTHETIC_AUTH_UNCHANGED', { mode: 0o600 });
      const elf = join(
        dir,
        'tools/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
      );
      fs.mkdirSync(join(elf, '..'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o555 });
      fs.writeFileSync(
        join(dir, 'bin', provider === 'openai' ? 'codex' : 'claude'),
        '#!' + process.execPath + '\n' + body,
        { mode: 0o700 }
      );
      prepare?.(dir);
      return {
        ...spawnSync(
          process.execPath,
          ['--input-type=commonjs', '-e', DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM, '--', provider, ...(mode ? [mode] : [])],
          {
            encoding: 'utf8',
            timeout: 12000,
            env: {
              PATH: join(dir, 'bin') + delimiter + (process.env.PATH ?? ''),
              HOME: dir,
              CODEX_HOME: join(dir, 'config'),
              REVERIE_DATA: dir,
            },
          }
        ),
        dir,
      };
    }
    const bootstrap = String.raw`
const fs=require('node:fs'),p=require('node:path');
const base=process.env.CODEX_HOME+'/tmp/arg0-linux/codex-arg0AbCd12';
const elf=process.env.REVERIE_DATA+'/tools/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
fs.mkdirSync(base,{recursive:true,mode:0o700});fs.writeFileSync(base+'/.lock','',{mode:0o600});
for(const n of ['apply_patch','applypatch','codex-linux-sandbox'])fs.symlinkSync(elf,base+'/'+n);
`;
    it('removes only its newly-created closed Codex arg0 tree before initial verification', () => {
      const r = run('openai', bootstrap + `process.stderr.write('Logged in using ChatGPT\\n');`, 'initial');
      expect(r.status, r.stderr).toBe(0);
      expect(DockerPlanAccountStatus.parse(JSON.parse(r.stdout)).authenticated).toBe(true);
      expect(fs.existsSync(join(r.dir, 'config/tmp'))).toBe(false);
      expect(fs.readFileSync(join(r.dir, 'config/auth.json'), 'utf8')).toBe('SYNTHETIC_AUTH_UNCHANGED');
    });
    it('leaves live-mode preexisting caches untouched', () => {
      const r = run('openai', `process.stderr.write('Logged in using ChatGPT\\n');`, undefined, (dir) => {
        fs.mkdirSync(join(dir, 'config/tmp'));
        fs.writeFileSync(join(dir, 'config/tmp/retained'), 'KEEP');
      });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(join(r.dir, 'config/tmp/retained'), 'utf8')).toBe('KEEP');
    });
    it('refuses preexisting tmp before invoking the provider and preserves it', () => {
      const r = run(
        'openai',
        `require('node:fs').writeFileSync(process.env.HOME+'/provider-called','bad');process.stderr.write('Logged in\\n');`,
        'initial',
        (dir) => {
          fs.mkdirSync(join(dir, 'config/tmp'));
          fs.writeFileSync(join(dir, 'config/tmp/retained'), 'KEEP');
        }
      );
      expect(r.status).toBe(1);
      expect(fs.existsSync(join(r.dir, 'provider-called'))).toBe(false);
      expect(fs.readFileSync(join(r.dir, 'config/tmp/retained'), 'utf8')).toBe('KEEP');
    });
    it.each([
      `fs.writeFileSync(base+'/unexpected','KEEP');`,
      `fs.unlinkSync(base+'/apply_patch');fs.symlinkSync(process.env.HOME+'/foreign',base+'/apply_patch');`,
      `fs.unlinkSync(base+'/.lock');fs.writeFileSync(process.env.HOME+'/foreign','');fs.linkSync(process.env.HOME+'/foreign',base+'/.lock');`,
      `fs.writeFileSync(process.env.CODEX_HOME+'/auth.json','CHANGED');`,
      `fs.chmodSync(elf,0o755);fs.writeFileSync(elf,Buffer.from([0x7f,0x45,0x4c,0x46,1]));fs.chmodSync(elf,0o555);`,
      `fs.renameSync(process.env.CODEX_HOME,process.env.CODEX_HOME+'-retained');fs.mkdirSync(process.env.CODEX_HOME,{mode:0o700});`,
    ])('refuses unknown side effects before deleting any bootstrap entry (%s)', (mutation) => {
      const r = run('openai', bootstrap + mutation + `process.stderr.write('Logged in using ChatGPT\\n');`, 'initial');
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      const retained = fs.existsSync(join(r.dir, 'config-retained')) ? 'config-retained' : 'config';
      expect(fs.existsSync(join(r.dir, retained, 'tmp/arg0-linux/codex-arg0AbCd12/applypatch'))).toBe(true);
    });
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
    it('keeps initial Claude observation free of Codex bootstrap handling', () => {
      const r = run(
        'anthropic',
        `process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}));`,
        'initial'
      );
      expect(r.status, r.stderr).toBe(0);
      expect(DockerPlanAccountStatus.parse(JSON.parse(r.stdout)).provider).toBe('anthropic');
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
