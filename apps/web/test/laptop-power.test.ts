import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerLaptopPowerRoutes } from '../src/web/routes/laptop-power-routes.js';

vi.mock('../src/web/route-helpers.js', () => ({ requireAdmin: () => true }));
afterEach(() => vi.unstubAllEnvs());
describe('office power controls', () => {
  async function setup(fail = false) {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/private/broker.sock');
    const events: string[] = [];
    const app = Fastify();
    const power = vi.fn(async (action: string, caller?: string) => {
      events.push(action + (caller ? ':' + caller : ''));
      if (fail) throw new Error('private engine diagnostic');
      return { success: true };
    });
    registerLaptopPowerRoutes(app, { ...({ stopIntent: async () => { events.push('stop-intent'); }, power }), verifiedOwner: trustedFixtureOwner });
    await app.ready();
    return { app, events, power };
  }
  it('records intentional stops before stopping laptops and shutting down', async () => {
    const { app, events } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/system/shutdown', payload: { confirmed: true } });
      expect(response.statusCode).toBe(200);
      expect(events).toEqual(['stop-intent', 'shutdown']);
    } finally { await app.close(); }
  });
  it('maintenance restart leaves running intentions and laptop lifetimes alone', async () => {
    const { app, events } = await setup();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/system/restart-website', headers: { 'x-reverie-parent-session': 'caller' }, payload: { confirmed: true } })).statusCode).toBe(200);
      expect(events).toEqual(['restart-website:caller']);
    } finally { await app.close(); }
  });
  it('agents cannot stop colleagues or shut down the office', async () => {
    const { app, events } = await setup();
    try {
      for (const action of ['shutdown', 'stop-laptops']) {
        expect((await app.inject({ method: 'POST', url: '/api/system/'+action, headers: { 'x-reverie-parent-session': 'caller' }, payload: { confirmed: true } })).statusCode).toBe(403);
      }
      expect(events).toEqual([]);
    } finally { await app.close(); }
  });
  it('requires confirmation and reports failures without claiming work stopped', async () => {
    const { app, events } = await setup(true);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/system/shutdown', payload: {} })).statusCode).toBe(400);
      expect(events).toEqual([]);
      const response = await app.inject({ method: 'POST', url: '/api/system/shutdown', payload: { confirmed: true } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private engine diagnostic');
    } finally { await app.close(); }
  });
});
