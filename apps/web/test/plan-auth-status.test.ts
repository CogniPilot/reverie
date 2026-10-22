import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function planAuthLabel('), html.indexOf('function plans()'));
function label(row: object, sign: unknown = null) {
  return vm.runInNewContext(`${source}; planAuthLabel(row)`, { row, sign, SETTLED: ['signed_in', 'failed', 'timeout', 'cancelled'] });
}
describe('plan authentication display', () => {
  it('shows authenticated independently of absent usage', () => {
    expect(label({ authState: 'signed-in', signedIn: true, used: null })).toBe('Signed in');
    expect(html).toContain("p.used == null ? 'no data'");
  });
  it('never labels unavailable or signed-out authentication signed in', () => {
    expect(label({ authState: 'signed-out', signedIn: false })).toBe('Signed out');
    expect(label({ authState: 'unavailable', signedIn: false })).toBe('Installing or unavailable');
    expect(label({ authState: 'error', signedIn: false })).toBe('Sign-in status error');
  });
  it('shows pending until successful OAuth refresh replaces the reading', () => {
    expect(label({ id: 'work', authState: 'signed-out' }, { accountId: 'work', view: { state: 'waiting' } })).toBe('Sign-in pending');
    expect(label({ id: 'work', authState: 'signed-in' }, { accountId: 'work', view: { state: 'signed_in' } })).toBe('Signed in');
    expect(html).toContain("if (v.state === 'signed_in') load()");
  });
});
