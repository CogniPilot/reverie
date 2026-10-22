import { describe, it, expect, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

function serverFixture() {
  const markClosing = vi.fn();
  const save = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const runtime = { markClosing };
  const server = Object.assign(Object.create(WebServer.prototype), {
    cleaningUp: new Set(),
    killingSessions: new Set(),
    sessions: new Map([['runtime', runtime]]),
    companyService: { setDesiredRunning: save },
    _doCleanupSession: stop,
  });
  return { server, save, stop, markClosing };
}
describe('company recovery server stop boundary', () => {
  it('durably commits intentional stop before any process termination', async () => {
    const f = serverFixture();
    const order: string[] = [];
    f.save.mockImplementation(async () => {
      order.push('saved');
    });
    f.stop.mockImplementation(async () => {
      order.push('terminated');
    });
    await f.server.cleanupSession('runtime', true);
    expect(order).toEqual(['saved', 'terminated']);
    expect(f.save).toHaveBeenCalledWith('runtime', false);
  });
  it('refuses process termination if the stop ledger cannot be committed', async () => {
    const f = serverFixture();
    f.save.mockRejectedValue(new Error('disk full'));
    await expect(f.server.cleanupSession('runtime', true)).rejects.toThrow('disk full');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.server.cleaningUp.size).toBe(0);
    expect(f.markClosing).toHaveBeenLastCalledWith(false);
  });
  it('normal console shutdown preserves running intent for the next outer-supervisor start', async () => {
    const f = serverFixture();
    await f.server.cleanupSession('runtime', false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledWith('runtime', false, undefined);
  });
});
