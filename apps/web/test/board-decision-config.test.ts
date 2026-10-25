/** Decision startup configuration uses persisted settings, with no environment fallback. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decisionWritesEnabled } from '../src/web/decision-config.js';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

describe('decision startup settings', () => {
  it.each([undefined, null, false, true, 1, 'enabled', [], [true], {}])('defaults OFF for %j', (settings) => {
    expect(decisionWritesEnabled(settings)).toBe(false);
  });

  it.each([undefined, null, false, 'enabled', 'true', 1, {}, [], new Boolean(true)])(
    'refuses non-true structuredDecisionWrites value %j',
    (value) => {
      expect(decisionWritesEnabled({ structuredDecisionWrites: value })).toBe(false);
    }
  );

  it('enables only an own boolean true on an ordinary or null-prototype settings record', () => {
    expect(decisionWritesEnabled({ structuredDecisionWrites: true, otherSetting: false })).toBe(true);
    const settings = Object.assign(Object.create(null), { structuredDecisionWrites: true });
    expect(decisionWritesEnabled(settings)).toBe(true);
  });

  it('does not enable arrays, dates, class instances or inherited flags', () => {
    class SettingsLike {
      structuredDecisionWrites = true;
    }
    for (const settings of [
      Object.assign([], { structuredDecisionWrites: true }),
      Object.assign(new Date(0), { structuredDecisionWrites: true }),
      new SettingsLike(),
      Object.create({ structuredDecisionWrites: true }),
    ])
      expect(decisionWritesEnabled(settings)).toBe(false);
  });

  it.each([true, false])('accepts explicit boolean %s through the persisted settings schema', (value) => {
    const settings = SettingsUpdateSchema.parse({ structuredDecisionWrites: value });
    expect(settings.structuredDecisionWrites).toBe(value);
    expect(decisionWritesEnabled(settings)).toBe(value);
  });

  it.each(['enabled', 'true', 1, null, {}, []])('rejects invalid persisted value %j', (value) => {
    expect(SettingsUpdateSchema.safeParse({ structuredDecisionWrites: value }).success).toBe(false);
  });

  it('keeps absent settings OFF and validates the tracked explicit enabled deployment payload', () => {
    expect(decisionWritesEnabled(SettingsUpdateSchema.parse({}))).toBe(false);
    const payload = JSON.parse(
      readFileSync(new URL('../config/board-decisions.enabled.settings.json', import.meta.url), 'utf8')
    );
    expect(payload).toEqual({ structuredDecisionWrites: true });
    expect(decisionWritesEnabled(SettingsUpdateSchema.parse(payload))).toBe(true);
  });

  it('wires one fresh settings read into board registration and removes the old environment switch', () => {
    const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/import\s*\{\s*decisionWritesEnabled\s*\}\s*from\s*['"]\.\/decision-config\.js['"]/);
    expect(server).toMatch(/structuredDecisionWrites:\s*decisionWritesEnabled\(await this\.readSettings\(true\)\)/);
    expect(server.match(/decisionWritesEnabled\s*\(/g)).toHaveLength(1);
    expect(server).not.toContain('REVERIE_BOARD_DECISION_WRITES');
  });
});
