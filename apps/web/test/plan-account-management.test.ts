import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
const actions = html.slice(html.indexOf('function planActions('), html.indexOf('function wirePlanActions('));
describe('plan account management', () => {
  it('offers removal for a configured default account, like every other configured account', () => {
    const result = vm.runInNewContext(`${actions}; planActions(row)`, { row: { id: 'anthropic-default', profileId: 'anthropic-default', isDefault: true, signedIn: false }, planEdit: null, planErr: {}, esc: String });
    expect(result).toContain('data-remove="anthropic-default"');
    expect(result).toContain('>Sign in</button>');
  });
  it('retains Add account when the account list is empty', () => {
    const source = html.slice(html.indexOf('function plans()'), html.indexOf('function planMemberHtml('));
    const target = { innerHTML: '' }, add = { hidden: true };
    vm.runInNewContext(`${source}; plans()`, { B: { planBurn: [] }, localPlans: [], document: { getElementById: (id: string) => id === 'plans' ? target : id === 'addAcct' ? add : {} } });
    expect(add.hidden).toBe(false);
    expect(target.innerHTML).toContain('Add an account');
  });
});
