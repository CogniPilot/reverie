import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { EmployeeSchema, type CompanyEmployee } from '../src/company-types.js';

describe('transactional employee hierarchy', () => {
  let directory: string;
  let store: CompanyStore;
  let service: CompanyService;
  const sessions = new Map<string, { id: string; name: string; owner?: string }>();
  const hire = async (name: string, owner?: string, reportsTo?: string) => {
    sessions.set(name, { id: name, name, owner });
    return service.hire({ name, owner, reportsTo, sessionId: name, icon: '🦉', position: 'Engineer', expertise: ['systems'], researchEnabled: false });
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'company-hierarchy-'));
    store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    sessions.clear();
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), setStatus: vi.fn() },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('strictly parses the optional owner/employee reference and preserves legacy employees', async () => {
    const employee = await hire('lead');
    expect(EmployeeSchema.parse(employee).reportsTo).toBeUndefined();
    expect(EmployeeSchema.parse({ ...employee, reportsTo: 'owner' }).reportsTo).toBe('owner');
    for (const reportsTo of ['', ' '.repeat(2), 12, null, {}, 'x'.repeat(101)])
      expect(EmployeeSchema.safeParse({ ...employee, reportsTo }).success).toBe(false);
    expect(EmployeeSchema.safeParse({ ...employee, arbitraryAuthority: true }).success).toBe(false);
  });

  it('persists owner -> CTO -> lead -> specialist across reload, retaining disconnected employees', async () => {
    const chief = await hire('chief', undefined, 'owner');
    const lead = await hire('lead');
    const specialist = await hire('specialist');
    await service.update(lead.id, undefined, { reportsTo: chief.id });
    await service.update(specialist.id, undefined, { reportsTo: lead.id });
    sessions.delete('chief');
    await service.update(lead.id, undefined, { reportsTo: chief.id });
    const reload = new CompanyStore(store.file); await reload.init();
    expect(reload.snapshot().employees.map((e) => e.reportsTo)).toEqual(['owner', chief.id, lead.id]);
    expect(service.view().employees).toHaveLength(3);
  });

  it('rejects nonexistent, foreign-owner, retired and self parents without mutating disk', async () => {
    const lead = await hire('lead');
    const foreign = await hire('foreign', 'other-owner');
    const retired = await hire('retired');
    sessions.delete('retired'); await service.retire(retired.id, undefined);
    const before = await readFile(store.file, 'utf8');
    for (const reportsTo of ['missing', foreign.id, retired.id, lead.id])
      await expect(service.update(lead.id, undefined, { reportsTo })).rejects.toThrow();
    await expect(service.update(lead.id, 'other-owner', { reportsTo: 'owner' })).rejects.toThrow('Unknown employee');
    await expect(hire('invalid-new', undefined, foreign.id)).rejects.toThrow('same company');
    expect(await readFile(store.file, 'utf8')).toBe(before);
  });

  it('rejects indirect cycles and cycles through the rendered implicit CTO parent', async () => {
    const chief = await hire('chief', undefined, 'owner');
    const lead = await hire('lead', undefined, chief.id);
    const specialist = await hire('specialist', undefined, lead.id);
    await expect(service.update(chief.id, undefined, { reportsTo: specialist.id })).rejects.toThrow('cycle');
    await service.configure(undefined, { coordinatorEmployeeId: chief.id } as never);
    const implicit = await hire('implicit');
    await expect(service.update(chief.id, undefined, { reportsTo: implicit.id })).rejects.toThrow('cycle');
    expect(store.snapshot().employees.find((e) => e.id === chief.id)?.reportsTo).toBe('owner');
  });

  it('serializes concurrent opposite edits so only one commits and the reloaded graph stays acyclic', async () => {
    const a = await hire('a'); const b = await hire('b');
    const results = await Promise.allSettled([
      service.update(a.id, undefined, { reportsTo: b.id }),
      service.update(b.id, undefined, { reportsTo: a.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reload = new CompanyStore(store.file); await reload.init();
    expect(reload.snapshot().employees.map((e) => e.reportsTo)).toEqual([b.id, undefined]);
  });

  it('captures each audit before/after inside the serialized edit rather than before the transaction', async () => {
    const a = await hire('a'); const b = await hire('b');
    const audit = vi.fn(async (_before: CompanyEmployee, _after: CompanyEmployee) => {});
    await Promise.all([
      service.update(a.id, undefined, { reportsTo: b.id }, audit),
      service.update(a.id, undefined, { reportsTo: 'owner' }, audit),
    ]);
    expect(audit.mock.calls).toHaveLength(2);
    expect(audit.mock.calls[0][0]).toMatchObject({ id: a.id });
    expect((audit.mock.calls as unknown[][])[0][1]).toMatchObject({ reportsTo: b.id });
    expect((audit.mock.calls as unknown[][])[1][0]).toMatchObject({ reportsTo: b.id });
    expect((audit.mock.calls as unknown[][])[1][1]).toMatchObject({ reportsTo: 'owner' });
  });

  it('prevents concurrent retirement from leaving a newly assigned manager inactive', async () => {
    const manager = await hire('manager'); const report = await hire('report');
    sessions.delete('manager');
    const results = await Promise.allSettled([
      service.update(report.id, undefined, { reportsTo: manager.id }),
      service.retire(manager.id, undefined),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.snapshot().employees.some((e) => e.id === manager.id)).toBe(true);
  });
});
