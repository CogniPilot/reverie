import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const fake = vi.hoisted(() => ({ execute: vi.fn(), probe: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFileSync: fake.execute }));
vi.mock('../src/daemon-control.js', async (original) => ({ ...await original<typeof import('../src/daemon-control.js')>(), probeServer: fake.probe }));

import { controlService, installService, uninstallService, serviceLogs, unitPathFor } from '../src/service-installer.js';
import { SYSTEMD_UNIT } from '../src/config/service-names.js';

const options = { host: '127.0.0.1', port: 3000, https: false };

describe('native service lifecycle with an owned fake home and manager', () => {
  beforeEach(() => {
    fake.execute.mockReset(); fake.probe.mockReset();
    fake.execute.mockReturnValue(''); fake.probe.mockResolvedValue({ up: false });
    rmSync(unitPathFor('systemd'), { force: true });
  });
  afterEach(() => { rmSync(unitPathFor('systemd'), { force: true }); });

  it('refuses a second native website beside an already responding container/unmanaged server', async () => {
    fake.probe.mockResolvedValue({ up: true });
    const result = await installService(options);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('existing deployment');
    expect(existsSync(unitPathFor('systemd'))).toBe(false);
    expect(fake.execute.mock.calls.some(([, args]) => args.includes('enable'))).toBe(false);
  });

  it('does not overwrite an active installed unit', async () => {
    const path = unitPathFor('systemd'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'keep existing');
    fake.execute.mockReturnValue('active');
    expect((await installService(options)).ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('keep existing');
  });

  it('installs one native unit without changing host linger policy or invoking an employee API', async () => {
    fake.probe.mockResolvedValueOnce({ up: false }).mockResolvedValue({ up: true });
    const result = await installService(options);
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(' ')).toContain('login session');
    expect(readFileSync(unitPathFor('systemd'), 'utf8')).toContain('KillMode=process');
    const calls = fake.execute.mock.calls;
    expect(calls.some(([command, args]) => command === 'loginctl' && args.includes('enable-linger'))).toBe(false);
    expect(calls.every(([command]) => command === 'systemctl' || command === 'loginctl')).toBe(true);
  });

  it('starts/stops only the existing native unit and reports manager refusal', () => {
    const calls: [string, string[]][] = [];
    const run = (command: string, args: string[]) => { calls.push([command, args]); return { ok: true, output: '' }; };
    expect(controlService('start', run).ok).toBe(false);
    const path = unitPathFor('systemd'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'owned fixture');
    expect(controlService('start', run).ok).toBe(true);
    expect(controlService('stop', run).ok).toBe(true);
    expect(calls).toEqual([['systemctl', ['--user', 'start', SYSTEMD_UNIT]], ['systemctl', ['--user', 'stop', SYSTEMD_UNIT]]]);
    expect(controlService('start', () => ({ ok: false, output: 'refused' })).ok).toBe(false);
  });

  it('bounds log requests and never evaluates their input as commands', () => {
    const calls: [string, string[]][] = [];
    const run = (command: string, args: string[]) => { calls.push([command, args]); return { ok: true, output: 'synthetic log' }; };
    expect(serviceLogs(Number.NaN, run).ok).toBe(false);
    expect(serviceLogs(1001, run).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(serviceLogs(20, run).message).toBe('synthetic log');
    expect(calls).toEqual([['journalctl', ['--user', '--unit', SYSTEMD_UNIT, '--lines', '20', '--no-pager']]]);
  });

  it('retains the installed file when the real manager contract refuses uninstall', () => {
    const path = unitPathFor('systemd'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'keep until stopped');
    fake.execute.mockImplementation(() => { throw new Error('synthetic manager refusal'); });
    expect(uninstallService().ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('keep until stopped');
  });
});
