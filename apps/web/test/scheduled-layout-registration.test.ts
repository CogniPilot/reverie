import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';

describe('scheduled session layout registration', () => {
  it('registers the layout before lifecycle work and rolls back a rejected tentative session', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'scheduled-layout-owner-'));
    const server = new WebServer(0, false, true);
    const session = new Session({ id: 'scheduled-session', owner: 'alice', mode: 'shell', workingDir, useMux: false });
    const sessions = server['sessions'],
      layouts = server['tabLayouts'],
      store = server['store'];
    const beforeLayout = store.getTabLayout('alice'),
      beforeOrder = [...store.getSessionOrder()];
    const persist = vi.fn(server['persistSessionState'].bind(server));
    const listeners = vi.fn(server['setupSessionListeners'].bind(server));
    server['persistSessionState'] = persist;
    server['setupSessionListeners'] = listeners;
    let registeredBeforeFailure = false;
    const failure = new Error('layout unavailable');
    // Keep the real owner lock, registration callback and rollback. Refuse
    // only their actual synchronous layout-publication boundary.
    const publication = vi.spyOn(store, 'commitTabLayoutProjection').mockImplementationOnce((next) => {
      registeredBeforeFailure = sessions.get(session.id) === session;
      expect(layouts['ownerQueues'].has('alice')).toBe(true);
      expect(Object.keys(next)).toEqual(['alice']);
      expect(next.alice.ungrouped).toContainEqual({ kind: 'session', id: session.id });
      expect(persist).not.toHaveBeenCalled();
      expect(listeners).not.toHaveBeenCalled();
      throw failure;
    });
    try {
      expect(sessions.has(session.id)).toBe(false);
      await expect(server['registerSessionWithLayout'](session)).rejects.toBe(failure);
      expect(publication).toHaveBeenCalledOnce();
      expect(registeredBeforeFailure).toBe(true);
      expect(sessions.has(session.id)).toBe(false);
      expect(store.getTabLayout('alice')).toEqual(beforeLayout);
      expect(store.getSessionOrder()).toEqual(beforeOrder);
      expect(persist).not.toHaveBeenCalled();
      expect(listeners).not.toHaveBeenCalled();
      expect(session.pid).toBeNull();
    } finally {
      publication.mockRestore();
      await session.stop(false);
      await server.stop();
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('uses the shared registration helper in the scheduled loop before persistence and listeners', () => {
    const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    const loop = source.slice(
      source.indexOf('private async runScheduledLoop'),
      source.indexOf('private async stopScheduledRun')
    );

    expect(loop).toContain('await this.registerSessionWithLayout(session);');
    expect(loop.indexOf('await this.registerSessionWithLayout(session);')).toBeLessThan(
      loop.indexOf('this.store.incrementSessionsCreated();')
    );
    expect(loop.indexOf('await this.registerSessionWithLayout(session);')).toBeLessThan(
      loop.indexOf('await this.setupSessionListeners(session);')
    );
  });
});
