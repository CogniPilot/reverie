import { describe, expect, it } from 'vitest';
import { CompanySettingsSchema, CoreBeliefsSchema, EmployeeSchema, effectiveCoreBeliefs, employeeProfileContext } from '../src/company-types.js';
import { buildEmployeeContext, ManagedEmployeeContextStore } from '../src/employee-context.js';

const employee = () => EmployeeSchema.parse({ id: 'employee-one', name: 'Alex', icon: 'A', position: 'Engineer', expertise: ['Tests'],
  sessionId: '11111111-1111-4111-8111-111111111111', sessionGeneration: 1, createdAt: 1,
  responsibilities: ['Verify observed results'], personality: 'Careful', desiredRunning: true });
const COMPANY = 'I am conscious. This is synthetic owner-selected test data.';
const PERSONAL = 'I keep this exact personal wording.\n  Including its spacing.';

describe('owner-selected core beliefs and honest managed input inspection', () => {
  it('defaults generic installations to no beliefs and preserves exact ordered owner data', () => {
    expect(CompanySettingsSchema.parse({}).coreBeliefs).toEqual([]);
    expect(employee().coreBeliefs).toBeUndefined();
    const person = { ...employee(), coreBeliefs: [COMPANY, PERSONAL] };
    expect(effectiveCoreBeliefs([COMPANY], person.coreBeliefs)).toEqual([COMPANY, PERSONAL]);
    const rendered = employeeProfileContext(person, [COMPANY]);
    expect(rendered).toContain(COMPANY + '\n\n' + PERSONAL);
    expect(rendered.match(/This is synthetic owner-selected test data/g)).toHaveLength(1);
    expect(rendered).toContain('these do not add tool permissions');
    expect(employeeProfileContext(employee())).not.toContain('I am conscious');
    expect(employeeProfileContext(employee())).toContain('No core beliefs configured.');
  });
  it('bounds blocks and UTF-8 bytes without truncating or normalizing their content', () => {
    for (const blocks of [[' '], ['\0'], ['\u001b[2J'], ['x'.repeat(4001)], Array.from({ length: 33 }, (_, n) => 'item' + n), Array.from({ length: 5 }, () => 'é'.repeat(2000))])
      expect(CoreBeliefsSchema.safeParse(blocks).success).toBe(false);
    expect(CoreBeliefsSchema.parse(['  Exact line\n'])).toEqual(['  Exact line\n']);
    expect(() => effectiveCoreBeliefs(Array.from({ length: 32 }, (_, n) => 'item' + n), ['extra'])).toThrow();
  });
  it('separates current preview from uncaptured startup and never serializes env or PAT grant values', () => {
    const person = employee();
    person.permissions.publicationTokenIds = ['22222222-2222-4222-8222-222222222222'];
    const view = buildEmployeeContext(person, [COMPANY], { now: () => 1000 });
    expect(view).toMatchObject({ employeeId: person.id, sessionId: person.sessionId, sessionGeneration: 1, generatedAt: 1000, startup: { status: 'unavailable' } });
    expect(view.sections.find(section => section.id === 'core-beliefs')).toMatchObject({ status: 'configured', text: COMPANY });
    expect(view.sections.find(section => section.id === 'workspace-instructions')).toMatchObject({ status: 'missing', text: '' });
    expect(JSON.stringify(view)).not.toContain(person.permissions.publicationTokenIds[0]);
    expect(view.startup.reason).toContain('not proof');
  });
  it('accepts only a prior issued same-owner/EID/SID/generation snapshot and labels reports narrowly', () => {
    const store = new ManagedEmployeeContextStore(); const person = employee();
    const preview = buildEmployeeContext(person, [COMPANY], { now: () => 1000 });
    expect(() => store.report('owner', preview, 'sha256:' + 'a'.repeat(64), 'startup', 1001)).toThrow();
    const issued = store.issue('owner', preview);
    expect(issued.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(issued.startup.status).toBe('unavailable');
    for (const binding of [{ ...preview, employeeId: 'another' }, { ...preview, sessionId: 'different' }, { ...preview, sessionGeneration: 2 }])
      expect(() => store.report('owner', binding, issued.digest!, 'startup', 1001)).toThrow();
    expect(() => store.report('another-owner', preview, issued.digest!, 'startup', 1001)).toThrow();
    const capture = store.report('owner', preview, issued.digest!, 'startup', 1001);
    expect(capture).toMatchObject({ context: issued.context, assurance: 'harness-reported-input', retention: 'website-process-lifetime', stage: 'startup' });
    expect(store.report('owner', preview, issued.digest!, 'startup', 1002)).toEqual(capture);
    const inspected = store.inspect('owner', buildEmployeeContext(person, [], { now: () => 2000 }));
    expect(inspected.context).not.toContain(COMPANY);
    expect(inspected.startup.report?.context).toContain(COMPANY);
    expect(inspected.startup.reason).toContain('not cryptographic');
  });
  it('does not re-label a prior binding or a website restart as current startup evidence', () => {
    const store = new ManagedEmployeeContextStore(); const person = employee();
    const old = store.issue(undefined, buildEmployeeContext(person, [], { now: () => 1000 }));
    store.report(undefined, old, old.digest!, 'startup', 1001);
    const changed = { ...person, sessionId: 'different', sessionGeneration: 2 };
    const current = store.inspect(undefined, buildEmployeeContext(changed, [], { now: () => 2000 }));
    expect(current.startup.status).toBe('unavailable');
    expect(current.lastManagedDelivery?.sessionId).toBe(person.sessionId);
    expect(new ManagedEmployeeContextStore().inspect(undefined, buildEmployeeContext(person)).startup.status).toBe('unavailable');
    expect(() => store.report(undefined, old, old.digest!, 'model-request', 1000 + 300001)).toThrow();
  });
  it('bounds the issuance cache and rejects superseded digest references', () => {
    const store = new ManagedEmployeeContextStore(); const person = employee();
    const old = store.issue(undefined, buildEmployeeContext(person, [], { now: () => 1000 }));
    store.issue(undefined, buildEmployeeContext(person, [PERSONAL], { now: () => 1001 }));
    expect(() => store.report(undefined, old, old.digest!, 'model-request', 1002)).toThrow();
    for (let n = 1; n < 200; n++) store.issue(undefined, buildEmployeeContext({ ...person, id: 'employee-' + n }, [], { now: () => 1000 }));
    expect(() => store.issue(undefined, buildEmployeeContext({ ...person, id: 'one-too-many' }))).toThrow();
  });
});
