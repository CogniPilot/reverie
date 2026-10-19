import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

describe('consume is not in the code path', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|js|mjs|json)$/.test(name)) files.push(full);
    }
  };
  walk(SRC);

  const CONSUME_NAME = /(consume|redeem)[\w/.:-]*(reset|credit)|(reset|credit)[\w/.:-]*(consume|redeem)/i;
  it('the guard catches the realistic names for the call', () => {
    for (const name of [
      'account/rateLimitResetCredits/consume',
      'account/resetCredits/redeem',
      'redeemRateLimitResetCredit',
      'consumeResetCredit',
    ])
      expect(CONSUME_NAME.test(name), name).toBe(true);
  });
  it('no source file names the reset-credit consume call', () => {
    const offenders = files.filter((f) => CONSUME_NAME.test(readFileSync(f, 'utf8')));
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
