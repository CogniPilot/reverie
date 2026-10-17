/**
 * Plans "Usage resets" block and the banked-resets read: the block shows used %, reset and
 * run-out in ET, the projection and, for Codex, the banked count ("unknown" when unread). It
 * is read-only: no redeem control exists, and nothing under src/ names the consume call.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const plansJs = readFileSync(join(SRC, 'web/public/plans-ui.js'), 'utf8');

function load() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
  const { document } = dom.window;
  class CodemanApp {}
  const sandbox = { document, CodemanApp, Object, Date, Math, setInterval, clearInterval };
  vm.runInNewContext(plansJs, sandbox);
  const app = new (CodemanApp as unknown as new () => Record<string, (...a: unknown[]) => HTMLElement>)();
  (app as unknown as Record<string, unknown>)._plansEls = {
    el: (tag: string, cls?: string, text?: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    },
  };
  return app;
}

const RESET = Date.UTC(2026, 9, 18, 16, 0, 0); // Sun 12:00 ET
const row = (provider: string, bankedResets: unknown) => ({
  provider,
  bankedResets,
  pace: { weekly: 41.6, weekReset: RESET, projected: 88.2, runsOutAt: RESET - 3600_000 },
});

describe('Usage resets block', () => {
  it('shows used, reset and run-out in ET and the projection', () => {
    const text = load()._planResets(row('anthropic', null)).textContent!;
    expect(text).toContain('Usage resets');
    expect(text).toContain('used 42%');
    expect(text).toContain('projected 88%');
    expect(text).toMatch(/resets Sun,? 12:00 PM ET/);
    expect(text).toMatch(/runs out Sun,? 11:00 AM ET/);
    expect(text).not.toContain('banked');
  });

  it('shows the Codex banked count with its earliest expiry, or unknown when unread', () => {
    const app = load();
    const known = app._planResets(row('openai', { availableCount: 2, earliestExpiresAt: RESET })).textContent!;
    expect(known).toMatch(/banked resets 2 \(earliest expiry Sun,? 12:00 PM ET\)/);
    expect(app._planResets(row('openai', null)).textContent).toContain('banked resets unknown');
  });

  it('has no button or other control', () => {
    const box = load()._planResets(row('openai', { availableCount: 1, earliestExpiresAt: null }));
    expect(box.querySelector('button, a, input')).toBeNull();
  });
});

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
