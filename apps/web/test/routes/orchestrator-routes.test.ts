/**
 * @fileoverview Tests for orchestrator-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerOrchestratorRoutes } from '../../src/web/routes/orchestrator-routes.js';

describe('orchestrator-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerOrchestratorRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/orchestrator/status ==========

  describe('GET /api/orchestrator/status', () => {
    it('returns idle when orchestrator is not initialized', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/status',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.state).toBe('idle');
      expect(body.plan).toBeNull();
    });

    it('returns current status when loop exists', async () => {
      const mockLoop = {
        getStatus: vi.fn(() => ({
          state: 'executing',
          plan: { id: 'plan-1', goal: 'test', phases: [] },
          currentPhaseIndex: 0,
          startedAt: Date.now(),
          completedAt: null,
          config: {},
          stats: {},
        })),
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/status',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.state).toBe('executing');
    });
  });

  // ========== GET /api/orchestrator/plan ==========

  describe('GET /api/orchestrator/plan', () => {
    it('returns null plan when not initialized', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.plan).toBeNull();
    });

    it('returns plan and current phase when loop exists', async () => {
      const mockPlan = { id: 'plan-1', goal: 'test', phases: [{ id: 'p1', name: 'Phase 1' }] };
      const mockLoop = {
        getPlan: vi.fn(() => mockPlan),
        getCurrentPhase: vi.fn(() => mockPlan.phases[0]),
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.plan.id).toBe('plan-1');
      expect(body.currentPhase.id).toBe('p1');
    });
  });

  // ========== POST /api/orchestrator/start ==========

  describe('POST /api/orchestrator/start', () => {
    it('rejects empty goal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/start',
        payload: { goal: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing goal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/start',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('initializes loop and starts when valid', async () => {
      const mockLoop = {
        isRunning: vi.fn(() => false),
        start: vi.fn(async () => {}),
        state: 'planning',
        on: vi.fn(),
      };
      harness.ctx.initOrchestratorLoop = vi.fn(() => mockLoop as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/start',
        payload: { goal: 'Build a REST API' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(harness.ctx.initOrchestratorLoop).toHaveBeenCalled();
    });

    it('rejects start when already running', async () => {
      const mockLoop = {
        isRunning: vi.fn(() => true),
        state: 'executing',
        on: vi.fn(),
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/start',
        payload: { goal: 'Another goal' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/orchestrator/stop ==========

  describe('POST /api/orchestrator/stop', () => {
    it('returns error when loop not initialized', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/stop',
      });
      // Should return 503 via thrown error
      expect(res.statusCode).toBe(503);
    });

    it('stops the loop', async () => {
      const mockLoop = {
        stop: vi.fn(async () => {}),
        state: 'idle',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/stop',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(mockLoop.stop).toHaveBeenCalled();
    });
  });

  // ========== POST /api/orchestrator/approve ==========

  describe('POST /api/orchestrator/approve', () => {
    it('returns error when loop not initialized', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/approve',
      });
      expect(res.statusCode).toBe(503);
    });

    it('calls approve on the loop', async () => {
      const mockLoop = {
        approve: vi.fn(async () => {}),
        state: 'approval',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/approve',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
    });
  });

  // ========== POST /api/orchestrator/reject ==========

  describe('POST /api/orchestrator/reject', () => {
    it('rejects missing feedback', async () => {
      const mockLoop = { state: 'approval' };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/reject',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('calls reject with feedback', async () => {
      const mockLoop = {
        reject: vi.fn(async () => {}),
        state: 'approval',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/reject',
        payload: { feedback: 'Add more tests' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
    });
  });

  // ========== POST /api/orchestrator/pause ==========

  describe('POST /api/orchestrator/pause', () => {
    it('calls pause on the loop', async () => {
      const mockLoop = {
        pause: vi.fn(),
        state: 'paused',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/pause',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
    });
  });

  // ========== POST /api/orchestrator/resume ==========

  describe('POST /api/orchestrator/resume', () => {
    it('calls resume on the loop', async () => {
      const mockLoop = {
        resume: vi.fn(async () => {}),
        state: 'executing',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/resume',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
    });
  });

  // ========== POST /api/orchestrator/phase/:id/skip ==========

  describe('POST /api/orchestrator/phase/:id/skip', () => {
    it('calls skipPhase with the phase id', async () => {
      const mockLoop = {
        skipPhase: vi.fn(async () => {}),
        state: 'executing',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/phase/phase-1/skip',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(mockLoop.skipPhase).toHaveBeenCalledWith('phase-1');
    });
  });

  // ========== POST /api/orchestrator/phase/:id/retry ==========

  describe('POST /api/orchestrator/phase/:id/retry', () => {
    it('calls retryPhase with the phase id', async () => {
      const mockLoop = {
        retryPhase: vi.fn(async () => {}),
        state: 'failed',
      };
      (harness.ctx as Record<string, unknown>).orchestratorLoop = mockLoop;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/phase/phase-2/retry',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(mockLoop.retryPhase).toHaveBeenCalledWith('phase-2');
    });
  });
});
