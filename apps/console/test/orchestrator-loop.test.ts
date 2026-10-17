/**
 * @fileoverview Deep integration tests for OrchestratorLoop state machine.
 *
 * Tests the full lifecycle: start → plan → approve → execute → verify → complete.
 * Uses mocked dependencies (SessionManager, TaskQueue, StateStore, Planner, Verifier)
 * to exercise state transitions, event emissions, error handling, and edge cases.
 *
 * Port: N/A (no HTTP)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ═══════════════════════════════════════════════════════════════
// Mock Setup — must be before imports
// ═══════════════════════════════════════════════════════════════

// Mock session
function createMockSession(id = 'session-1') {
  const session = new EventEmitter() as EventEmitter & {
    id: string;
    sendInput: ReturnType<typeof vi.fn>;
    assignTask: ReturnType<typeof vi.fn>;
    clearTask: ReturnType<typeof vi.fn>;
    writeViaMux: ReturnType<typeof vi.fn>;
    isIdle: ReturnType<typeof vi.fn>;
    isBusy: ReturnType<typeof vi.fn>;
  };
  session.id = id;
  session.sendInput = vi.fn(async () => {});
  session.assignTask = vi.fn();
  session.clearTask = vi.fn();
  session.writeViaMux = vi.fn(async () => true);
  session.isIdle = vi.fn(() => true);
  session.isBusy = vi.fn(() => false);
  return session;
}

// Mock session manager
const mockSessionManager = new EventEmitter() as EventEmitter & {
  getIdleSessions: ReturnType<typeof vi.fn>;
  getAllSessions: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
};
mockSessionManager.getIdleSessions = vi.fn(() => [createMockSession()]);
mockSessionManager.getAllSessions = vi.fn(() => [createMockSession()]);
mockSessionManager.getSession = vi.fn(() => createMockSession());

vi.mock('../src/session-manager.js', () => ({
  getSessionManager: () => mockSessionManager,
  SessionManager: vi.fn(),
}));

// Mock task queue with real Task-like objects
let taskIdCounter = 0;
function createMockTask(options: { prompt: string; completionPhrase?: string }) {
  const id = `task-${++taskIdCounter}`;
  let status = 'pending' as string;
  let assignedSessionId: string | null = null;
  let error: string | null = null;
  return {
    id,
    prompt: options.prompt,
    completionPhrase: options.completionPhrase,
    status,
    assignedSessionId,
    error,
    assign(sessionId: string) {
      status = 'running';
      assignedSessionId = sessionId;
      this.status = status;
      this.assignedSessionId = assignedSessionId;
    },
    fail(err?: string) {
      status = 'failed';
      error = err || 'Unknown error';
      this.status = status;
      this.error = error;
    },
    complete() {
      status = 'completed';
      this.status = status;
    },
    isCompleted() {
      return this.status === 'completed';
    },
    isFailed() {
      return this.status === 'failed';
    },
    isPending() {
      return this.status === 'pending';
    },
  };
}

const mockTaskQueue = new EventEmitter() as EventEmitter & {
  addTask: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  _tasks: Map<string, ReturnType<typeof createMockTask>>;
};
mockTaskQueue._tasks = new Map();
mockTaskQueue.addTask = vi.fn((options) => {
  const task = createMockTask(options);
  mockTaskQueue._tasks.set(task.id, task);
  return task;
});
mockTaskQueue.getTask = vi.fn((id: string) => mockTaskQueue._tasks.get(id));
mockTaskQueue.next = vi.fn(() => null);
mockTaskQueue.updateTask = vi.fn();

vi.mock('../src/task-queue.js', () => ({
  getTaskQueue: () => mockTaskQueue,
  TaskQueue: vi.fn(),
}));

// Mock state store
const mockStore = {
  getOrchestratorState: vi.fn(() => null),
  setOrchestratorState: vi.fn(),
  clearOrchestratorState: vi.fn(),
};

vi.mock('../src/state-store.js', () => ({
  getStore: () => mockStore,
  StateStore: vi.fn(),
}));

// Mock planner & verifier — vi.hoisted() so they exist when vi.mock factories run
const { mockPlannerInstance, mockVerifierInstance } = vi.hoisted(() => ({
  mockPlannerInstance: {
    generatePlan: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  },
  mockVerifierInstance: {
    verifyPhase: vi.fn(),
  },
}));

vi.mock('../src/orchestrator-planner.js', () => ({
  OrchestratorPlanner: vi.fn().mockImplementation(function () {
    return mockPlannerInstance;
  }),
}));

vi.mock('../src/orchestrator-verifier.js', () => ({
  OrchestratorVerifier: vi.fn().mockImplementation(function () {
    return mockVerifierInstance;
  }),
}));

// ═══════════════════════════════════════════════════════════════
// Import after mocks
// ═══════════════════════════════════════════════════════════════

import { OrchestratorLoop } from '../src/orchestrator-loop.js';
import type { OrchestratorPlan } from '../src/types.js';

// ═══════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════

function createTestPlan(overrides?: Partial<OrchestratorPlan>): OrchestratorPlan {
  return {
    id: 'plan-1',
    goal: 'Build a REST API',
    createdAt: Date.now(),
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1: Setup',
        description: 'Setup the project',
        order: 0,
        status: 'pending',
        tasks: [
          {
            id: 'phase-1-task-1',
            phaseId: 'phase-1',
            prompt: 'Create project structure',
            status: 'pending',
            assignedSessionId: null,
            queueTaskId: null,
            parallel: false,
            completionPhrase: 'ORCH_P1_T1',
            timeoutMs: 600000,
            startedAt: null,
            completedAt: null,
            error: null,
            retries: 0,
          },
        ],
        verificationCriteria: [],
        testCommands: [],
        maxAttempts: 3,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        teamStrategy: { type: 'single' },
      },
      {
        id: 'phase-2',
        name: 'Phase 2: Implementation',
        description: 'Implement the API',
        order: 1,
        status: 'pending',
        tasks: [
          {
            id: 'phase-2-task-1',
            phaseId: 'phase-2',
            prompt: 'Implement endpoints',
            status: 'pending',
            assignedSessionId: null,
            queueTaskId: null,
            parallel: false,
            completionPhrase: 'ORCH_P2_T1',
            timeoutMs: 600000,
            startedAt: null,
            completedAt: null,
            error: null,
            retries: 0,
          },
        ],
        verificationCriteria: ['All endpoints respond with 200'],
        testCommands: ['npm test'],
        maxAttempts: 3,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        teamStrategy: { type: 'single' },
      },
    ],
    metadata: {
      totalTasks: 2,
      estimatedComplexity: 'low',
      modelUsed: 'opus',
      planDurationMs: 1000,
    },
    ...overrides,
  };
}

function createMockMux() {
  return {
    createSession: vi.fn(),
    killSession: vi.fn(),
    listSessions: vi.fn(() => []),
    sendInput: vi.fn(async () => true),
  } as never;
}

// Wait for a specific event to be emitted
function waitForEvent(emitter: EventEmitter, event: string, timeout = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for event "${event}"`)), timeout);
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('OrchestratorLoop', () => {
  let loop: OrchestratorLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    taskIdCounter = 0;
    mockTaskQueue._tasks.clear();
    mockStore.getOrchestratorState.mockReturnValue(null);
    mockSessionManager.getIdleSessions.mockReturnValue([createMockSession()]);
    loop = new OrchestratorLoop(createMockMux(), '/test/dir');
  });

  afterEach(() => {
    loop.destroy();
  });

  // ═══════════════════════════════════════════════════════════════
  // Initial State
  // ═══════════════════════════════════════════════════════════════

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(loop.state).toBe('idle');
      expect(loop.isRunning()).toBe(false);
    });

    it('has no plan', () => {
      expect(loop.getPlan()).toBeNull();
      expect(loop.getCurrentPhase()).toBeNull();
    });

    it('has zeroed stats', () => {
      const stats = loop.getStats();
      expect(stats.phasesCompleted).toBe(0);
      expect(stats.phasesFailed).toBe(0);
      expect(stats.totalTasksCompleted).toBe(0);
      expect(stats.totalTasksFailed).toBe(0);
    });

    it('reports full status', () => {
      const status = loop.getStatus();
      expect(status.state).toBe('idle');
      expect(status.plan).toBeNull();
      expect(status.currentPhaseIndex).toBe(0);
      expect(status.startedAt).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // start() — Planning
  // ═══════════════════════════════════════════════════════════════

  describe('start()', () => {
    it('transitions to planning state', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const stateChanges: string[] = [];
      loop.on('stateChanged', (state) => stateChanges.push(state));

      await loop.start('Build a REST API');

      expect(stateChanges).toContain('planning');
      expect(stateChanges).toContain('approval');
      expect(loop.state).toBe('approval');
    });

    it('stores the generated plan', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Build a REST API');

      expect(loop.getPlan()).toBeTruthy();
      expect(loop.getPlan()!.goal).toBe('Build a REST API');
      expect(loop.getPlan()!.phases).toHaveLength(2);
    });

    it('emits planReady event', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const planReadyPromise = waitForEvent(loop, 'planReady');
      await loop.start('Build a REST API');
      const [emittedPlan] = await planReadyPromise;

      expect(emittedPlan).toBeTruthy();
    });

    it('persists state during planning', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Build a REST API');

      expect(mockStore.setOrchestratorState).toHaveBeenCalled();
    });

    it('auto-approves when configured', async () => {
      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });

      const plan = createTestPlan({ phases: [] }); // Empty phases = immediate completion
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Quick task');

      // Should skip approval and go straight to executing then completed
      expect(loop.state).toBe('completed');
    });

    it('transitions to failed on planner error', async () => {
      mockPlannerInstance.generatePlan.mockRejectedValue(new Error('Planner crashed'));

      // Must listen for 'error' events — Node throws unhandled 'error' events on EventEmitters
      const errors: Error[] = [];
      loop.on('error', (err) => errors.push(err));

      await loop.start('Bad goal');

      expect(loop.state).toBe('failed');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Planner crashed');
    });

    it('rejects start from invalid states', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      // Now in 'approval' state

      await expect(loop.start('Another goal')).rejects.toThrow('Cannot start from state');
    });

    it('allows restart from failed state', async () => {
      mockPlannerInstance.generatePlan.mockRejectedValue(new Error('Failed'));
      loop.on('error', () => {}); // Suppress unhandled error throw
      await loop.start('Fail');
      expect(loop.state).toBe('failed');

      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Retry');
      expect(loop.state).toBe('approval');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // approve() / reject()
  // ═══════════════════════════════════════════════════════════════

  describe('approve()', () => {
    it('transitions from approval to executing', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      expect(loop.state).toBe('approval');

      // approve starts execution asynchronously
      const approvePromise = loop.approve();

      // Need to wait for the first phase to start executing
      await approvePromise;

      expect(loop.state).toBe('executing');
      expect(loop.isRunning()).toBe(true);
    });

    it('rejects approve from non-approval state', async () => {
      await expect(loop.approve()).rejects.toThrow('Expected state "approval"');
    });
  });

  describe('reject()', () => {
    it('transitions back to planning with feedback', async () => {
      const plan1 = createTestPlan({ id: 'plan-1' });
      const plan2 = createTestPlan({ id: 'plan-2' });
      mockPlannerInstance.generatePlan.mockResolvedValueOnce(plan1).mockResolvedValueOnce(plan2);

      await loop.start('Goal');
      expect(loop.state).toBe('approval');

      await loop.reject('Add more tests');

      expect(loop.state).toBe('approval');
      // Planner should be called with goal + feedback
      expect(mockPlannerInstance.generatePlan).toHaveBeenCalledTimes(2);
      const secondCallGoal = mockPlannerInstance.generatePlan.mock.calls[1][0];
      expect(secondCallGoal).toContain('Add more tests');
    });

    it('rejects reject from non-approval state', async () => {
      await expect(loop.reject('feedback')).rejects.toThrow('Expected state "approval"');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase Execution
  // ═══════════════════════════════════════════════════════════════

  describe('phase execution', () => {
    it('creates task queue entries for phase tasks', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      // addTask should have been called for the first phase's task
      expect(mockTaskQueue.addTask).toHaveBeenCalled();
      const addTaskCall = mockTaskQueue.addTask.mock.calls[0][0];
      expect(addTaskCall.completionPhrase).toBe('ORCH_P1_T1');
    });

    it('emits phaseStarted event', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');

      const phaseStartedPromise = waitForEvent(loop, 'phaseStarted');
      await loop.approve();
      const [phase] = await phaseStartedPromise;

      expect((phase as { id: string }).id).toBe('phase-1');
    });

    it('increments phase attempts', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      const currentPhase = loop.getCurrentPhase();
      expect(currentPhase).toBeTruthy();
      expect(currentPhase!.attempts).toBe(1);
      expect(currentPhase!.status).toBe('executing');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // pause() / resume()
  // ═══════════════════════════════════════════════════════════════

  describe('pause()', () => {
    it('transitions to paused state', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();
      expect(loop.state).toBe('executing');

      loop.pause();
      expect(loop.state).toBe('paused');
      expect(loop.isRunning()).toBe(true); // Still "running" in broader sense
    });

    it('is a no-op from idle/completed/failed', () => {
      loop.pause(); // Should not throw
      expect(loop.state).toBe('idle');
    });

    it('cleans up listeners on pause', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      // Listeners should be active
      const listenerCount = mockSessionManager.listenerCount('sessionCompletion');

      loop.pause();

      // After pause, listener should be removed
      expect(mockSessionManager.listenerCount('sessionCompletion')).toBeLessThan(listenerCount);
    });

    it('cancels pending verify timer on pause', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]]; // No verification criteria
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      // Tasks complete immediately — triggers post-phase delay timer
      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      await loop.start('Goal');
      await loop.approve();

      // Wait for poll to detect completion (2s) but pause before verify runs (1s delay)
      await new Promise((resolve) => setTimeout(resolve, 2500));
      loop.pause();
      expect(loop.state).toBe('paused');

      // Wait past where verify would have fired — state should still be paused
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(loop.state).toBe('paused');
    });
  });

  describe('resume()', () => {
    it('resumes executing state', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();
      loop.pause();
      expect(loop.state).toBe('paused');

      await loop.resume();
      expect(loop.state).toBe('executing');
    });

    it('rejects resume when not paused', async () => {
      await expect(loop.resume()).rejects.toThrow('Not paused');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // stop()
  // ═══════════════════════════════════════════════════════════════

  describe('stop()', () => {
    it('returns to idle state', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.stop();

      expect(loop.state).toBe('idle');
      expect(loop.isRunning()).toBe(false);
    });

    it('cancels planner', async () => {
      await loop.stop();
      expect(mockPlannerInstance.cancel).toHaveBeenCalled();
    });

    it('clears persisted state', async () => {
      await loop.stop();
      expect(mockStore.clearOrchestratorState).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // skipPhase() / retryPhase()
  // ═══════════════════════════════════════════════════════════════

  describe('skipPhase()', () => {
    it('marks phase as skipped', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      await loop.skipPhase('phase-1');

      const phase = loop.getPlan()!.phases[0];
      expect(phase.status).toBe('skipped');
      expect(phase.completedAt).toBeTruthy();
    });

    it('throws for unknown phase', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');

      await expect(loop.skipPhase('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('retryPhase()', () => {
    it('resets phase tasks and re-executes', async () => {
      const plan = createTestPlan();
      plan.phases[0].status = 'failed';
      plan.phases[0].tasks[0].status = 'failed';
      plan.phases[0].tasks[0].error = 'Something broke';
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      // The phase was pre-failed, so retrying should work
      await loop.retryPhase('phase-1');

      const phase = loop.getPlan()!.phases[0];
      expect(phase.tasks[0].status).not.toBe('failed');
      expect(phase.tasks[0].error).toBeNull();
    });

    it('rejects from invalid states', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      // In approval state — can't retry

      await expect(loop.retryPhase('phase-1')).rejects.toThrow('Cannot retry from state');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Verification Flow
  // ═══════════════════════════════════════════════════════════════

  describe('verification', () => {
    it('skips verification for phases with no criteria', async () => {
      // Phase 1 has no verificationCriteria, so it should pass automatically
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]]; // Only phase 1 (no criteria)

      // Mock immediate task completion via pollPhaseStatus
      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete(); // Immediately complete
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      // Create a fresh auto-approve loop
      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });

      await loop.start('Goal');

      // Wait for poll (2s) + post-phase delay (1s) + buffer
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Phase 1 has no criteria → should pass without verification
      expect(loop.state).toBe('completed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // State Persistence & Recovery
  // ═══════════════════════════════════════════════════════════════

  describe('persistence', () => {
    it('restores failed state on crash recovery', () => {
      mockStore.getOrchestratorState.mockReturnValue({
        state: 'executing',
        plan: createTestPlan(),
        currentPhaseIndex: 0,
        startedAt: Date.now() - 10000,
        completedAt: null,
        config: {
          plannerModel: 'opus',
          autoApprove: false,
          maxPhaseRetries: 3,
          phaseTimeoutMs: 1800000,
          enableTeamAgents: true,
          maxParallelSessions: 3,
          verificationMode: 'moderate',
          compactBetweenPhases: true,
          researchEnabled: true,
        },
        stats: {
          phasesCompleted: 0,
          phasesFailed: 0,
          totalTasksCompleted: 0,
          totalTasksFailed: 0,
          totalDurationMs: 0,
          replanCount: 0,
        },
      });

      const recovered = new OrchestratorLoop(createMockMux(), '/test/dir');
      expect(recovered.state).toBe('failed'); // Executing at crash → failed
      expect(recovered.getPlan()).toBeTruthy();
      recovered.destroy();
    });

    it('clears planning state on crash recovery', () => {
      mockStore.getOrchestratorState.mockReturnValue({
        state: 'planning',
        plan: null,
        currentPhaseIndex: 0,
        startedAt: Date.now(),
        completedAt: null,
        config: {
          plannerModel: 'opus',
          autoApprove: false,
          maxPhaseRetries: 3,
          phaseTimeoutMs: 1800000,
          enableTeamAgents: true,
          maxParallelSessions: 3,
          verificationMode: 'moderate',
          compactBetweenPhases: true,
          researchEnabled: true,
        },
        stats: {
          phasesCompleted: 0,
          phasesFailed: 0,
          totalTasksCompleted: 0,
          totalTasksFailed: 0,
          totalDurationMs: 0,
          replanCount: 0,
        },
      });

      const recovered = new OrchestratorLoop(createMockMux(), '/test/dir');
      expect(recovered.state).toBe('idle'); // Planning at crash → idle
      expect(mockStore.clearOrchestratorState).toHaveBeenCalled();
      recovered.destroy();
    });

    it('preserves completed state on recovery', () => {
      mockStore.getOrchestratorState.mockReturnValue({
        state: 'completed',
        plan: createTestPlan(),
        currentPhaseIndex: 2,
        startedAt: Date.now() - 60000,
        completedAt: Date.now(),
        config: {
          plannerModel: 'opus',
          autoApprove: false,
          maxPhaseRetries: 3,
          phaseTimeoutMs: 1800000,
          enableTeamAgents: true,
          maxParallelSessions: 3,
          verificationMode: 'moderate',
          compactBetweenPhases: true,
          researchEnabled: true,
        },
        stats: {
          phasesCompleted: 2,
          phasesFailed: 0,
          totalTasksCompleted: 2,
          totalTasksFailed: 0,
          totalDurationMs: 60000,
          replanCount: 0,
        },
      });

      const recovered = new OrchestratorLoop(createMockMux(), '/test/dir');
      expect(recovered.state).toBe('completed');
      expect(recovered.getPlan()).toBeTruthy();
      expect(recovered.getStats().phasesCompleted).toBe(2);
      recovered.destroy();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Event Emissions
  // ═══════════════════════════════════════════════════════════════

  describe('event emissions', () => {
    it('emits stateChanged for every transition', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const transitions: Array<{ state: string; prevState: string }> = [];
      loop.on('stateChanged', (state, prevState) => {
        transitions.push({ state, prevState });
      });

      await loop.start('Goal');

      // idle → planning → approval
      expect(transitions).toEqual([
        { state: 'planning', prevState: 'idle' },
        { state: 'approval', prevState: 'planning' },
      ]);
    });

    it('emits error event on failure', async () => {
      mockPlannerInstance.generatePlan.mockRejectedValue(new Error('Boom'));

      const errorPromise = waitForEvent(loop, 'error');
      await loop.start('Fail');
      const [error] = await errorPromise;

      expect((error as Error).message).toBe('Boom');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Team Phase Execution
  // ═══════════════════════════════════════════════════════════════

  describe('team phase execution', () => {
    it('sends team lead prompt for team strategy phases', async () => {
      const plan = createTestPlan();
      plan.phases[0].teamStrategy = {
        type: 'team',
        config: {
          leadPrompt: 'Lead prompt',
          suggestedTeammates: ['Specialist 1', 'Specialist 2'],
          maxTeammates: 2,
        },
      };
      plan.phases[0].tasks.push({
        id: 'phase-1-task-2',
        phaseId: 'phase-1',
        prompt: 'Second task',
        status: 'pending',
        assignedSessionId: null,
        queueTaskId: null,
        parallel: true,
        completionPhrase: 'ORCH_P1_T2',
        timeoutMs: 600000,
        startedAt: null,
        completedAt: null,
        error: null,
        retries: 0,
      });

      const mockSession = createMockSession();
      mockSessionManager.getIdleSessions.mockReturnValue([mockSession]);
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      // Should have sent a team lead prompt to the session
      expect(mockSession.sendInput).toHaveBeenCalled();
      const sentPrompt = mockSession.sendInput.mock.calls[0][0];
      expect(sentPrompt).toContain('team lead');
    });

    it('throws when no idle sessions for team phase', async () => {
      const plan = createTestPlan();
      plan.phases[0].teamStrategy = {
        type: 'team',
        config: {
          leadPrompt: 'Lead prompt',
          suggestedTeammates: ['Specialist'],
          maxTeammates: 1,
        },
      };

      mockSessionManager.getIdleSessions.mockReturnValue([]);
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      // Should fail because no sessions available
      // Wait for state to settle
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(loop.state).toBe('failed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Complete Lifecycle
  // ═══════════════════════════════════════════════════════════════

  describe('complete lifecycle (auto-approve, single phase, no verification)', () => {
    it('runs start → plan → execute → complete', async () => {
      const plan = createTestPlan();
      // Single phase with no verification criteria
      plan.phases = [plan.phases[0]];

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });

      // Make tasks complete immediately
      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const completedPromise = waitForEvent(loop, 'completed', 10000);
      await loop.start('Simple goal');

      const [stats] = await completedPromise;
      expect(loop.state).toBe('completed');
      expect((stats as { phasesCompleted: number }).phasesCompleted).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles empty plan (no phases)', async () => {
      const plan = createTestPlan({ phases: [] });
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });

      await loop.start('Empty');

      expect(loop.state).toBe('completed');
    });

    it('destroy cleans up timers', async () => {
      const plan = createTestPlan();
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      await loop.start('Goal');
      await loop.approve();

      // Should not throw
      loop.destroy();
    });

    it('multiple stop calls are safe', async () => {
      await loop.stop();
      await loop.stop();
      await loop.stop();
      expect(loop.state).toBe('idle');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Task Failure & Retry (handleTaskFailed)
  // ═══════════════════════════════════════════════════════════════

  describe('task failure & retry', () => {
    it('retries a failed task when retries < 2', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]]; // Single phase
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      // First addTask returns a task that will "fail" on the first poll
      let callCount = 0;
      mockTaskQueue.addTask.mockImplementation((options) => {
        callCount++;
        const task = createMockTask(options);
        if (callCount === 1) {
          // First task: mark as failed
          task.fail('Transient error');
        } else {
          // Retry: mark as completed
          task.complete();
        }
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {}); // Suppress unhandled errors

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for poll to detect failure, increment retries, re-queue, and detect completion
      await new Promise((resolve) => setTimeout(resolve, 8000));

      // The task should have been retried (addTask called more than once)
      expect(callCount).toBeGreaterThan(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase Error Retry (handlePhaseError auto-retry)
  // ═══════════════════════════════════════════════════════════════

  describe('phase error auto-retry', () => {
    it('retries phase when task fails and retries exhaust within a phase', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]];
      plan.phases[0].maxAttempts = 3;
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      // Task always fails — this triggers task retries (up to 2), then phase error
      // Phase error handler sees attempts(1) < maxAttempts(3), resets tasks, re-executes
      let addTaskCallCount = 0;
      mockTaskQueue.addTask.mockImplementation((options) => {
        addTaskCallCount++;
        const task = createMockTask(options);
        // First few calls: always fail. After enough calls: succeed (so test eventually ends)
        if (addTaskCallCount <= 4) {
          task.fail('Persistent error');
        } else {
          task.complete();
        }
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {});

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for: task fail × 3 (retry twice) → phase error → phase retry → task fail × 1 → finally succeed
      await new Promise((resolve) => setTimeout(resolve, 20000));

      // addTask should have been called multiple times (initial + retries + phase retry)
      expect(addTaskCallCount).toBeGreaterThan(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Verification with Criteria
  // ═══════════════════════════════════════════════════════════════

  describe('verification with criteria', () => {
    it('runs verifier when phase has criteria and passes', async () => {
      const plan = createTestPlan();
      // Use phase 2 which has verification criteria
      plan.phases = [plan.phases[1]];
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      // Tasks complete immediately
      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      // Verifier passes
      mockVerifierInstance.verifyPhase.mockResolvedValue({
        passed: true,
        summary: 'All checks passed',
        checks: [],
        suggestions: [],
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });

      const events: string[] = [];
      loop.on('stateChanged', (state: string) => events.push(state));

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for poll + verification
      await new Promise((resolve) => setTimeout(resolve, 8000));

      expect(mockVerifierInstance.verifyPhase).toHaveBeenCalled();
      expect(events).toContain('verifying');
      expect(loop.state).toBe('completed');
    });

    it('replans on verification failure', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[1]]; // Phase with criteria
      plan.phases[0].maxAttempts = 3;
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      let addTaskCalls = 0;
      mockTaskQueue.addTask.mockImplementation((options) => {
        addTaskCalls++;
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      // First verification fails, second passes
      mockVerifierInstance.verifyPhase
        .mockResolvedValueOnce({
          passed: false,
          summary: 'Tests failing',
          checks: [{ name: 'npm test', passed: false, output: 'FAIL' }],
          suggestions: ['Fix the failing test'],
        })
        .mockResolvedValueOnce({
          passed: true,
          summary: 'All passed',
          checks: [],
          suggestions: [],
        });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {});

      const states: string[] = [];
      loop.on('stateChanged', (state: string) => states.push(state));

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for: execute → verify → fail → replan → re-execute → verify → pass
      await new Promise((resolve) => setTimeout(resolve, 15000));

      expect(states).toContain('replanning');
      expect(mockVerifierInstance.verifyPhase).toHaveBeenCalledTimes(2);
      expect(loop.getStats().replanCount).toBeGreaterThanOrEqual(1);
    });

    it('fails phase after max verification attempts', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[1]];
      plan.phases[0].maxAttempts = 1; // Only 1 attempt allowed
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      mockVerifierInstance.verifyPhase.mockResolvedValue({
        passed: false,
        summary: 'Permanently broken',
        checks: [],
        suggestions: [],
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {});

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      await new Promise((resolve) => setTimeout(resolve, 8000));

      expect(loop.state).toBe('failed');
      expect(loop.getStats().phasesFailed).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Multi-Phase Advancement & Compact
  // ═══════════════════════════════════════════════════════════════

  describe('multi-phase advancement', () => {
    it('advances through multiple phases sequentially', async () => {
      const plan = createTestPlan();
      // Both phases have no verification criteria
      plan.phases[1].verificationCriteria = [];
      plan.phases[1].testCommands = [];
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', {
        autoApprove: true,
        compactBetweenPhases: false,
      });

      const phasesStarted: string[] = [];
      loop.on('phaseStarted', (phase: { id: string }) => phasesStarted.push(phase.id));

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for both phases: 2 × (2s poll + 1s post-phase delay) + buffer
      await new Promise((resolve) => setTimeout(resolve, 12000));

      expect(phasesStarted).toContain('phase-1');
      expect(phasesStarted).toContain('phase-2');
      expect(loop.state).toBe('completed');
      expect(loop.getStats().phasesCompleted).toBe(2);
    });

    it('compacts between phases when configured', async () => {
      const plan = createTestPlan();
      plan.phases[1].verificationCriteria = [];
      plan.phases[1].testCommands = [];
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      const mockSession = createMockSession();
      mockSessionManager.getIdleSessions.mockReturnValue([mockSession]);

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', {
        autoApprove: true,
        compactBetweenPhases: true,
      });

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for both phases + compact delay
      await new Promise((resolve) => setTimeout(resolve, 14000));

      // writeViaMux('/compact') should have been called between phases
      expect(mockSession.writeViaMux).toHaveBeenCalledWith('/compact', { opencodeGuard: true });
      expect(loop.state).toBe('completed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Persistence Recovery Edge Cases
  // ═══════════════════════════════════════════════════════════════

  describe('persistence recovery edge cases', () => {
    const fullConfig = {
      plannerModel: 'opus' as const,
      autoApprove: false,
      maxPhaseRetries: 3,
      phaseTimeoutMs: 1800000,
      enableTeamAgents: true,
      maxParallelSessions: 3,
      verificationMode: 'moderate' as const,
      compactBetweenPhases: true,
      researchEnabled: true,
    };
    const zeroStats = {
      phasesCompleted: 0,
      phasesFailed: 0,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
      totalDurationMs: 0,
      replanCount: 0,
    };

    it('recovers verifying state as failed', () => {
      mockStore.getOrchestratorState.mockReturnValue({
        state: 'verifying',
        plan: createTestPlan(),
        currentPhaseIndex: 0,
        startedAt: Date.now() - 5000,
        completedAt: null,
        config: fullConfig,
        stats: zeroStats,
      });

      const recovered = new OrchestratorLoop(createMockMux(), '/test/dir');
      expect(recovered.state).toBe('failed');
      expect(recovered.getPlan()).toBeTruthy();
      recovered.destroy();
    });

    it('recovers replanning state as failed', () => {
      mockStore.getOrchestratorState.mockReturnValue({
        state: 'replanning',
        plan: createTestPlan(),
        currentPhaseIndex: 1,
        startedAt: Date.now() - 30000,
        completedAt: null,
        config: fullConfig,
        stats: { ...zeroStats, replanCount: 1 },
      });

      const recovered = new OrchestratorLoop(createMockMux(), '/test/dir');
      expect(recovered.state).toBe('failed');
      expect(recovered.getStats().replanCount).toBe(1);
      recovered.destroy();
    });

    it('recovers paused state as idle (paused is transient)', () => {
      mockStore.getOrchestratorState.mockReturnValue({
        state: 'paused',
        plan: createTestPlan(),
        currentPhaseIndex: 0,
        startedAt: Date.now() - 10000,
        completedAt: null,
        config: fullConfig,
        stats: zeroStats,
      });

      const recovered = new OrchestratorLoop(createMockMux(), '/test/dir');
      // 'paused' is not handled by restore — falls through, stays idle
      expect(recovered.state).toBe('idle');
      recovered.destroy();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Prompt Generation
  // ═══════════════════════════════════════════════════════════════

  describe('prompt generation', () => {
    it('uses single-task prompt for single-task phases', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]]; // Phase 1 has 1 task
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const mockSession = createMockSession();
      mockSessionManager.getIdleSessions.mockReturnValue([mockSession]);

      // Capture the prompt from addTask
      let capturedPrompt = '';
      mockTaskQueue.addTask.mockImplementation((options) => {
        capturedPrompt = options.prompt;
        const task = createMockTask(options);
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });
      mockTaskQueue.next.mockImplementation(() => {
        const tasks = Array.from(mockTaskQueue._tasks.values());
        return tasks.find((t) => t.isPending()) || null;
      });

      await loop.start('Goal');
      await loop.approve();

      // Single-task prompt should contain the task description and completion phrase
      expect(capturedPrompt).toContain('Create project structure');
      expect(capturedPrompt).toContain('ORCH_P1_T1');
      expect(capturedPrompt).toContain('<promise>');
      // Should NOT contain multi-task markers
      expect(capturedPrompt).not.toContain('YOUR TASKS FOR THIS PHASE');
    });

    it('uses multi-task prompt for multi-task phases', async () => {
      const plan = createTestPlan();
      plan.phases[0].tasks.push({
        id: 'phase-1-task-2',
        phaseId: 'phase-1',
        prompt: 'Write unit tests',
        status: 'pending',
        assignedSessionId: null,
        queueTaskId: null,
        parallel: false,
        completionPhrase: 'ORCH_P1_T2',
        timeoutMs: 600000,
        startedAt: null,
        completedAt: null,
        error: null,
        retries: 0,
      });
      plan.phases = [plan.phases[0]]; // Only phase 1 (now with 2 tasks)
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const capturedPrompts: string[] = [];
      mockTaskQueue.addTask.mockImplementation((options) => {
        capturedPrompts.push(options.prompt);
        const task = createMockTask(options);
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      await loop.start('Goal');
      await loop.approve();

      // Multi-task prompt should contain the phase execution template markers
      expect(capturedPrompts.length).toBeGreaterThanOrEqual(2);
      expect(capturedPrompts[0]).toContain('YOUR TASKS FOR THIS PHASE');
      expect(capturedPrompts[0]).toContain('VERIFICATION');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Team Phase Error Handling
  // ═══════════════════════════════════════════════════════════════

  describe('team phase error handling', () => {
    it('fails phase when session.sendInput throws', async () => {
      const plan = createTestPlan();
      plan.phases[0].teamStrategy = {
        type: 'team',
        config: {
          leadPrompt: 'Lead prompt',
          suggestedTeammates: ['Specialist'],
          maxTeammates: 1,
        },
      };
      plan.phases = [plan.phases[0]];
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const mockSession = createMockSession();
      mockSession.sendInput.mockRejectedValue(new Error('Session write failed'));
      mockSessionManager.getIdleSessions.mockReturnValue([mockSession]);

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {});

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for the error to propagate
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Phase should have failed or be retrying
      const phase = loop.getPlan()!.phases[0];
      expect(phase.attempts).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Verification Session Retrieval
  // ═══════════════════════════════════════════════════════════════

  describe('verification session handling', () => {
    it('skips verification when no sessions become available', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[1]]; // Phase with criteria
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      // Track state: once we enter 'verifying', stop returning sessions
      let inVerification = false;
      const mockSession = createMockSession();
      mockSessionManager.getIdleSessions.mockImplementation(() => {
        if (inVerification) return []; // No sessions for verification
        return [mockSession];
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {});
      loop.on('stateChanged', (state: string) => {
        if (state === 'verifying') inVerification = true;
      });

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      // Wait for poll + verification attempt + 10s session wait + fallback
      await new Promise((resolve) => setTimeout(resolve, 18000));

      // Should still complete (skip verification when no sessions)
      expect(loop.state).toBe('completed');
      // Verifier should NOT have been called (no sessions to verify with)
      expect(mockVerifierInstance.verifyPhase).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Event Coverage
  // ═══════════════════════════════════════════════════════════════

  describe('event coverage', () => {
    it('emits taskAssigned when task is assigned to session', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]];
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      const mockSession = createMockSession();
      mockSessionManager.getIdleSessions.mockReturnValue([mockSession]);

      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });
      mockTaskQueue.next.mockImplementation(() => {
        const tasks = Array.from(mockTaskQueue._tasks.values());
        return tasks.find((t) => t.isPending()) || null;
      });

      const assigned: Array<{ task: unknown; sessionId: string }> = [];
      loop.on('taskAssigned', (task: unknown, sessionId: string) => {
        assigned.push({ task, sessionId });
      });

      await loop.start('Goal');
      await loop.approve();

      // Task assignment happens during assignQueuedTasksToSessions
      expect(assigned.length).toBeGreaterThanOrEqual(1);
      expect(assigned[0].sessionId).toBe('session-1');
    });

    it('emits phaseCompleted on successful phase', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]]; // No verification criteria
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.complete();
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });

      const completedPhases: string[] = [];
      loop.on('phaseCompleted', (phase: { id: string }) => completedPhases.push(phase.id));

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      await new Promise((resolve) => setTimeout(resolve, 6000));

      expect(completedPhases).toContain('phase-1');
    });

    it('emits phaseFailed when phase exhausts retries', async () => {
      const plan = createTestPlan();
      plan.phases = [plan.phases[0]];
      plan.phases[0].maxAttempts = 1;
      mockPlannerInstance.generatePlan.mockResolvedValue(plan);

      // All tasks always fail
      mockTaskQueue.addTask.mockImplementation((options) => {
        const task = createMockTask(options);
        task.fail('Permanent failure');
        mockTaskQueue._tasks.set(task.id, task);
        return task;
      });

      loop.destroy();
      loop = new OrchestratorLoop(createMockMux(), '/test/dir', { autoApprove: true });
      loop.on('error', () => {});

      const failedPhases: Array<{ id: string; reason: string }> = [];
      loop.on('phaseFailed', (phase: { id: string }, reason: string) => {
        failedPhases.push({ id: phase.id, reason });
      });

      mockPlannerInstance.generatePlan.mockResolvedValue(plan);
      await loop.start('Goal');

      await new Promise((resolve) => setTimeout(resolve, 8000));

      expect(loop.state).toBe('failed');
      expect(failedPhases.length).toBeGreaterThanOrEqual(1);
    });
  });
});
