/** @fileoverview Startup restoration must gate destructive tab-layout reconciliation. */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema } from '../src/company-types.js';
import { StateStore } from '../src/state-store.js';
import { TabLayoutService } from '../src/tab-layout-service.js';
import { WebServer } from '../src/web/server.js';

describe('tab layout restore gate', () => {
  it('does not unlock pruning, cleanup stale state, or reconcile after a failed restore', async () => {
    const markRestorationComplete = vi.fn();
    const markRestorationFailed = vi.fn();
    const reconcileAfterRestoration = vi.fn(async () => {});
    const cleanupStaleSessions = vi.fn(async () => 0);
    const server = Object.create(WebServer.prototype) as {
      tabLayouts: {
        markRestorationComplete: typeof markRestorationComplete;
        markRestorationFailed: typeof markRestorationFailed;
        reconcileAfterRestoration: typeof reconcileAfterRestoration;
      };
      cleanupStaleSessions: typeof cleanupStaleSessions;
      mux: { reconcileSessions(): Promise<never> };
      restoreMuxSessions(): Promise<boolean>;
      finalizeRestoredState(restored: boolean): Promise<void>;
    };
    server.tabLayouts = { markRestorationComplete, markRestorationFailed, reconcileAfterRestoration };
    server.cleanupStaleSessions = cleanupStaleSessions;
    server.mux = { reconcileSessions: vi.fn(async () => Promise.reject(new Error('mux unavailable'))) };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await server.restoreMuxSessions();
    await server.finalizeRestoredState(restored);

    expect(restored).toBe(false);
    expect(markRestorationComplete).not.toHaveBeenCalled();
    expect(markRestorationFailed).toHaveBeenCalledTimes(1);
    expect(cleanupStaleSessions).not.toHaveBeenCalled();
    expect(reconcileAfterRestoration).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith('[Server] Failed to restore mux sessions:', expect.any(Error));
  });

  it('unlocks cleanup and reconciliation only after successful restoration', async () => {
    const order: string[] = [];
    const server = Object.create(WebServer.prototype) as {
      tabLayouts: {
        markRestorationComplete(): void;
        markRestorationFailed(): void;
        reconcileAfterRestoration(): Promise<void>;
      };
      cleanupStaleSessions(): Promise<number>;
      finalizeRestoredState(restored: boolean): Promise<void>;
    };
    server.tabLayouts = {
      markRestorationComplete: () => order.push('complete'),
      markRestorationFailed: () => order.push('failed'),
      reconcileAfterRestoration: async () => {
        order.push('reconcile');
      },
    };
    server.cleanupStaleSessions = async () => (order.push('cleanup'), 0);

    await server.finalizeRestoredState(true);

    expect(order).toEqual(['complete', 'cleanup', 'reconcile']);
  });

  it.each([false, true])(
    'keeps every unpinned OFF employee on boot with vacation=%s, while pruning orphans',
    async (onVacation) => {
      const directory = mkdtempSync(join(tmpdir(), 'reverie-employee-stale-state-'));
      const file = join(directory, 'state.json');
      const store = new StateStore(file);
      try {
        const companyStore = new CompanyStore(join(directory, 'company.json'));
        await companyStore.init();
        const employees = Array.from({ length: 12 }, (_, index) =>
          EmployeeSchema.parse({
            id: `employee-${index}`,
            sessionId: `session-${index}`,
            name: `Employee ${index}`,
            icon: '🌱',
            position: 'Specialist',
            expertise: ['testing'],
            createdAt: index,
            desiredRunning: false,
            onVacation,
          })
        );
        await companyStore.update((state) => {
          state.employees = employees;
        });
        for (const id of [...employees.map((employee) => employee.sessionId), 'orphan']) {
          store.setSession(id, {
            id,
            workingDir: directory,
            status: 'idle',
            pid: 0,
            createdAt: 1,
            caseName: 'retained-native-state',
            mode: 'codex',
            pinned: false,
            codexConfig: { model: 'test-model', resumeSessionId: `thread-${id}` },
          });
        }
        const before = structuredClone(store.getSessions());
        const companyService = new CompanyService(companyStore, {
          getSession: vi.fn(),
          chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), setStatus: vi.fn() },
          research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
        });
        const sessions = new Map();
        const tabLayouts = new TabLayoutService({
          store,
          sessions,
          readWebviews: async () => [],
          broadcast: vi.fn(),
          broadcastSessionOrder: vi.fn(),
        });
        const server = Object.assign(Object.create(WebServer.prototype), {
          store,
          sessions,
          companyService,
          tabLayouts,
        }) as { finalizeRestoredState(restored: boolean): Promise<void> };

        await server.finalizeRestoredState(true);
        store.flush();

        const reloaded = new StateStore(file);
        expect(Object.keys(reloaded.getSessions()).sort()).toEqual(
          employees.map((employee) => employee.sessionId).sort()
        );
        for (const employee of employees)
          expect(reloaded.getSession(employee.sessionId)).toEqual(before[employee.sessionId]);
        expect(reloaded.getSession('orphan')).toBeNull();
        expect(companyStore.snapshot().employees).toEqual(employees);
        expect(
          companyService
            .registeredEmployees()
            .every((employee) => employee.desiredRunning === false && employee.onVacation === onVacation)
        ).toBe(true);
      } finally {
        store.flush();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
