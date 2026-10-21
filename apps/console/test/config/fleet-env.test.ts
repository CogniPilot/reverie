import { describe, expect, it, vi } from 'vitest';
import { applyFleetEnvironment, bothNames, envValue } from '../../src/config/fleet-env.js';

describe('fleet-env', () => {
  it('reads REVERIE_ first and falls back to the older FLEET_ spelling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(envValue({ REVERIE_ZZ_A: 'new', FLEET_ZZ_A: 'old' }, 'ZZ_A')).toBe('new');
    expect(envValue({ FLEET_ZZ_B: 'old' }, 'ZZ_B')).toBe('old');
    expect(envValue({ FLEET_ZZ_B: 'old' }, 'ZZ_B')).toBe('old');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('FLEET_ZZ_B is deprecated; use REVERIE_ZZ_B');
    expect(envValue({ REVERIE_ZZ_C: '', FLEET_ZZ_C: '' }, 'ZZ_C')).toBeUndefined();
    warn.mockRestore();
  });

  it('gives children both names', () => {
    expect(bothNames('ZZ_D', 'v')).toEqual({ REVERIE_ZZ_D: 'v', FLEET_ZZ_D: 'v' });
  });

  it('normalizes an environment: the new name wins and every spelling is filled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { FLEET_ZZ_E: 'old-only', REVERIE_ZZ_F: 'new', FLEET_ZZ_F: 'old' };
    applyFleetEnvironment(env);
    expect(env).toMatchObject({
      REVERIE_ZZ_E: 'old-only',
      FLEET_ZZ_E: 'old-only',
      CODEMAN_ZZ_E: 'old-only',
      REVERIE_ZZ_F: 'new',
      FLEET_ZZ_F: 'new',
      CODEMAN_ZZ_F: 'new',
    });
    warn.mockRestore();
  });
});
