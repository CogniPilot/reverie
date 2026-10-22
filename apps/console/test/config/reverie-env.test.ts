import { describe, expect, it } from 'vitest';
import { environmentEntry, envValue } from '../../src/config/reverie-env.js';

describe('reverie-env', () => {
  it('reads a nonempty Reverie setting', () => {
    expect(envValue({ REVERIE_ZZ_A: 'value' }, 'ZZ_A')).toBe('value');
    expect(envValue({ REVERIE_ZZ_A: '' }, 'ZZ_A')).toBeUndefined();
    expect(envValue({}, 'ZZ_A')).toBeUndefined();
  });

  it('gives children the Reverie name', () => {
    expect(environmentEntry('ZZ_D', 'v')).toEqual({ REVERIE_ZZ_D: 'v' });
  });
});
