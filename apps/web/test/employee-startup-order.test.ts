import { describe, it, expect } from 'vitest';
import { employeeStartupOrder, heldFirstNotice, runsWithoutSubscription } from '../src/employee-startup-order.js';
import { EmployeeSchema, type CompanyEmployee } from '../src/company-types.js';

const subscription = { id: 'plan-a', label: 'Plan A', provider: 'anthropic' as const };
const endpoint = { endpointId: 'gpu', modelId: 'local-model' };

function employee(id: string, recipe?: Partial<NonNullable<CompanyEmployee['runtimeRecipe']>>): CompanyEmployee {
  return EmployeeSchema.parse({
    id,
    sessionId: 'session-' + id,
    name: id,
    icon: 'E',
    // A title is never read: the one that goes first below is called "Intern".
    position: id === 'local' ? 'Intern' : 'Chief Operating Officer',
    expertise: ['systems'],
    createdAt: 1,
    desiredRunning: true,
    ...(recipe ? { runtimeRecipe: { mode: 'claude', workingDir: '/workspace', ...recipe } } : {}),
  });
}

describe('which employees have no provider sign-in to wait on', () => {
  it('is a selected model endpoint with no subscription account', () => {
    expect(runsWithoutSubscription(employee('local', { mode: 'hands', customModel: endpoint }))).toBe(true);
  });
  it('is not a subscription account, with or without a model endpoint beside it', () => {
    expect(runsWithoutSubscription(employee('plan', { subscriptionProfile: subscription }))).toBe(false);
    expect(
      runsWithoutSubscription(employee('both', { subscriptionProfile: subscription, customModel: endpoint }))
    ).toBe(false);
  });
  it('is not an employee whose recipe is missing or names neither', () => {
    expect(runsWithoutSubscription(employee('unknown'))).toBe(false);
    expect(runsWithoutSubscription(employee('bare', { mode: 'codex' }))).toBe(false);
  });
  it('does not depend on the harness', () => {
    expect(runsWithoutSubscription(employee('other', { mode: 'opencode', customModel: endpoint }))).toBe(true);
  });
});

describe('startup order', () => {
  it('puts employees without a subscription account first and keeps everyone else in the given order', () => {
    const order = employeeStartupOrder([
      employee('a', { subscriptionProfile: subscription }),
      employee('unknown'),
      employee('local', { mode: 'hands', customModel: endpoint }),
      employee('b', { mode: 'codex', subscriptionProfile: { ...subscription, provider: 'openai' } }),
      employee('local-2', { mode: 'hands', customModel: endpoint }),
    ]);
    expect(order.map((e) => e.id)).toEqual(['local', 'local-2', 'a', 'unknown', 'b']);
  });
  it('leaves a company with no such employee exactly as it was', () => {
    const given = [employee('b', { subscriptionProfile: subscription }), employee('a'), employee('c', {})];
    expect(employeeStartupOrder(given)).toEqual(given);
  });
  it('returns a new array of the same employees and does not reorder the input', () => {
    const given = [employee('a', { subscriptionProfile: subscription }), employee('local', { customModel: endpoint })];
    const order = employeeStartupOrder(given);
    expect(given.map((e) => e.id)).toEqual(['a', 'local']);
    expect(order).not.toBe(given);
    expect(order[0]).toBe(given[1]);
    expect(order).toHaveLength(2);
  });
  it('accepts an empty company', () => {
    expect(employeeStartupOrder([])).toEqual([]);
  });
});

describe('saying why the first employee is not up', () => {
  const local = employee('local', { mode: 'hands', customModel: endpoint });
  const held = { employeeId: 'local', state: 'held', code: 'DESTINATION_STOPPED' };

  it('names the employee and the reason, and that the pass continues', () => {
    expect(heldFirstNotice(local, held, undefined)).toBe(
      'employee local has no subscription account and is held (DESTINATION_STOPPED); continuing with the others'
    );
  });
  it('says it again when the reason changes, and not while it stays the same', () => {
    expect(heldFirstNotice(local, held, held)).toBeUndefined();
    expect(heldFirstNotice(local, held, { ...held, code: 'VIEW_UNCONFIRMED' })).toContain('DESTINATION_STOPPED');
    expect(heldFirstNotice(local, held, { employeeId: 'local', state: 'attached' })).toContain('is held');
  });
  it('says nothing for a connected employee, a subscription employee, or the outcome of another employee', () => {
    expect(heldFirstNotice(local, { employeeId: 'local', state: 'attached' }, undefined)).toBeUndefined();
    const plan = employee('plan', { subscriptionProfile: subscription });
    expect(heldFirstNotice(plan, { ...held, employeeId: 'plan' }, undefined)).toBeUndefined();
    expect(heldFirstNotice(local, { ...held, employeeId: 'someone-else' }, undefined)).toBeUndefined();
    expect(heldFirstNotice(local, undefined, undefined)).toBeUndefined();
  });
});
