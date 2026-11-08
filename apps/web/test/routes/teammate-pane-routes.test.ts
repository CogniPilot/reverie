/**
 * @fileoverview Tests for teammate-pane-routes: reading and typing into a teammate's own tmux pane.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerTeammatePaneRoutes } from '../../src/web/routes/teammate-pane-routes.js';

const SESSION = 'test-session-1';

const TEAM = {
  name: 'zorblat-team',
  leadSessionId: SESSION,
  members: [
    { agentId: 'lead@zorblat-team', name: 'team-lead', agentType: 'team-lead', tmuxPaneId: '%1' },
    { agentId: 'tester@zorblat-team', name: 'tester', agentType: 'general-purpose', tmuxPaneId: '%7' },
    { agentId: 'inline@zorblat-team', name: 'inline', agentType: 'general-purpose', tmuxPaneId: 'in-process' },
  ],
};

type AuthUser = { username: string; role: 'admin' | 'user' };

async function setup(opts: { team?: unknown; authUser?: AuthUser } = {}) {
  const harness = await createRouteTestHarness(registerTeammatePaneRoutes, { authUser: opts.authUser });
  const team = 'team' in opts ? opts.team : TEAM;
  const mux = harness.ctx.mux as Record<string, unknown>;
  mux.capturePaneBuffer = vi.fn(() => 'pane text\r\n');
  mux.sendInputToPane = vi.fn(() => true);
  (harness.ctx.teamWatcher as Record<string, unknown>).getTeamForSession = vi.fn((id: string) =>
    id === SESSION ? team : undefined
  );
  return {
    harness,
    mux: mux as { capturePaneBuffer: ReturnType<typeof vi.fn>; sendInputToPane: ReturnType<typeof vi.fn> },
  };
}

const bufferUrl = (pane: string, session = SESSION) =>
  `/api/sessions/${session}/teammate-pane-buffer/${encodeURIComponent(pane)}`;

const sendInput = (harness: RouteTestHarness, payload: unknown, session = SESSION) =>
  harness.app.inject({ method: 'POST', url: `/api/sessions/${session}/teammate-pane-input`, payload });

describe('teammate-pane-routes', () => {
  let harness: RouteTestHarness;

  afterEach(async () => {
    delete process.env.REVERIE_MULTIUSER;
    await harness?.app.close();
  });

  describe('GET /api/sessions/:id/teammate-pane-buffer/:paneTarget', () => {
    it("returns a teammate pane's buffer from the lead's tmux session", async () => {
      const s = await setup();
      harness = s.harness;
      const res = await harness.app.inject({ method: 'GET', url: bufferUrl('%7') });
      const body = JSON.parse(res.body);
      expect(body).toEqual({ success: true, data: { buffer: 'pane text\r\n' } });
      const session = harness.ctx.sessions.get(SESSION)!;
      expect(s.mux.capturePaneBuffer).toHaveBeenCalledWith(session.muxName, '%7');
    });

    it("refuses the lead's own pane, an in-process teammate and an unlisted pane", async () => {
      const s = await setup();
      harness = s.harness;
      for (const pane of ['%1', 'in-process', '%8', '7', '%7;ls']) {
        const body = JSON.parse((await harness.app.inject({ method: 'GET', url: bufferUrl(pane) })).body);
        expect(body.success, pane).toBe(false);
      }
      expect(s.mux.capturePaneBuffer).not.toHaveBeenCalled();
    });

    it('refuses when the session leads no team', async () => {
      const s = await setup({ team: undefined });
      harness = s.harness;
      const body = JSON.parse((await harness.app.inject({ method: 'GET', url: bufferUrl('%7') })).body);
      expect(body.success).toBe(false);
      expect(s.mux.capturePaneBuffer).not.toHaveBeenCalled();
    });

    it("multi-user: another user's session reads as not found", async () => {
      process.env.REVERIE_MULTIUSER = '1';
      const s = await setup({ authUser: { username: 'bob', role: 'user' } });
      harness = s.harness;
      harness.ctx.sessions.get(SESSION)!.owner = 'alice';
      const res = await harness.app.inject({ method: 'GET', url: bufferUrl('%7') });
      expect(res.statusCode).toBe(404);
      expect(s.mux.capturePaneBuffer).not.toHaveBeenCalled();
    });

    it('reports a pane that could not be read', async () => {
      const s = await setup();
      harness = s.harness;
      s.mux.capturePaneBuffer.mockReturnValue(null);
      const body = JSON.parse((await harness.app.inject({ method: 'GET', url: bufferUrl('%7') })).body);
      expect(body.success).toBe(false);
    });
  });

  describe('POST /api/sessions/:id/teammate-pane-input', () => {
    it('types into a teammate pane', async () => {
      const s = await setup();
      harness = s.harness;
      const body = JSON.parse((await sendInput(harness, { paneTarget: '%7', input: 'yes\r' })).body);
      expect(body).toEqual({ success: true });
      const session = harness.ctx.sessions.get(SESSION)!;
      expect(s.mux.sendInputToPane).toHaveBeenCalledWith(session.muxName, '%7', 'yes\r');
    });

    it("refuses the lead's own pane, an in-process teammate and an unlisted pane", async () => {
      const s = await setup();
      harness = s.harness;
      for (const paneTarget of ['%1', 'in-process', '%8', '7']) {
        const body = JSON.parse((await sendInput(harness, { paneTarget, input: 'x' })).body);
        expect(body.success, paneTarget).toBe(false);
      }
      expect(s.mux.sendInputToPane).not.toHaveBeenCalled();
    });

    it('refuses empty input and unknown fields', async () => {
      const s = await setup();
      harness = s.harness;
      for (const payload of [
        { paneTarget: '%7', input: '' },
        { paneTarget: '%7', input: 'x', extra: 1 },
        { paneTarget: '%7' },
      ]) {
        const res = await sendInput(harness, payload);
        expect(JSON.parse(res.body).success).toBe(false);
      }
      expect(s.mux.sendInputToPane).not.toHaveBeenCalled();
    });

    it("multi-user: another user's session reads as not found", async () => {
      process.env.REVERIE_MULTIUSER = '1';
      const s = await setup({ authUser: { username: 'bob', role: 'user' } });
      harness = s.harness;
      harness.ctx.sessions.get(SESSION)!.owner = 'alice';
      const res = await sendInput(harness, { paneTarget: '%7', input: 'x' });
      expect(res.statusCode).toBe(404);
      expect(s.mux.sendInputToPane).not.toHaveBeenCalled();
    });

    it('reports input that did not reach the pane', async () => {
      const s = await setup();
      harness = s.harness;
      s.mux.sendInputToPane.mockReturnValue(false);
      const body = JSON.parse((await sendInput(harness, { paneTarget: '%7', input: 'x' })).body);
      expect(body.success).toBe(false);
    });
  });
});
