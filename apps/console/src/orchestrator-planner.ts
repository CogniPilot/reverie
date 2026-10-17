/**
 * @fileoverview Orchestrator plan generation — converts goals into phased plans.
 *
 * Wraps PlanOrchestrator for AI-powered plan generation, then groups the
 * resulting PlanItems into sequential phases with team strategies and
 * verification criteria.
 *
 * Phase grouping algorithm:
 * 1. Topological sort by dependencies (Kahn's algorithm)
 * 2. Group into dependency layers
 * 3. Sub-group by TDD phase within layers
 * 4. Merge small adjacent phases
 * 5. Assign team strategies based on parallelism potential
 *
 * Key exports:
 * - `OrchestratorPlanner` class — plan generation + phase grouping
 *
 * @dependencies plan-orchestrator (AI plan generation), types (OrchestratorPlan, PlanItem)
 * @consumedby orchestrator-loop
 *
 * @module orchestrator-planner
 */

import { v4 as uuidv4 } from 'uuid';
import { PlanOrchestrator, type DetailedPlanResult, type ProgressCallback } from './plan-orchestrator.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import type {
  PlanItem,
  TddPhase,
  OrchestratorPlan,
  OrchestratorPhase,
  OrchestratorTask,
  OrchestratorConfig,
  TeamStrategy,
  PhaseStatus,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Maximum number of phases (prevents runaway plans) */
const MAX_PHASES = 10;

/** Maximum total tasks across all phases */
const MAX_TOTAL_TASKS = 50;

/** Default task timeout (10 minutes) */
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** Minimum tasks in a phase before it gets merged with adjacent */
const MIN_PHASE_TASKS = 2;

/** TDD phase ordering for grouping */
const TDD_PHASE_ORDER: Record<TddPhase, number> = {
  setup: 0,
  test: 1,
  impl: 2,
  verify: 3,
  review: 4,
};

// ═══════════════════════════════════════════════════════════════
// OrchestratorPlanner
// ═══════════════════════════════════════════════════════════════

export class OrchestratorPlanner {
  private mux: TerminalMultiplexer;
  private workingDir: string;
  private config: OrchestratorConfig;
  private orchestrator: PlanOrchestrator | null = null;

  constructor(mux: TerminalMultiplexer, workingDir: string, config: OrchestratorConfig) {
    this.mux = mux;
    this.workingDir = workingDir;
    this.config = config;
  }

  /**
   * Generate a phased plan from a user goal.
   *
   * Uses PlanOrchestrator for AI plan generation, then groups results into phases.
   */
  async generatePlan(goal: string, onProgress?: ProgressCallback): Promise<OrchestratorPlan> {
    const startTime = Date.now();

    // Create a PlanOrchestrator for this plan generation
    this.orchestrator = new PlanOrchestrator(this.mux, this.workingDir, undefined, {
      defaultModel: this.config.plannerModel,
    });

    try {
      onProgress?.('planning', 'Generating detailed plan...');

      const result: DetailedPlanResult = await this.orchestrator.generateDetailedPlan(goal, onProgress);

      if (!result.success || !result.items || result.items.length === 0) {
        throw new Error(result.error || 'Plan generation returned no items');
      }

      // Cap total tasks
      const items = result.items.slice(0, MAX_TOTAL_TASKS);

      onProgress?.('grouping', 'Organizing plan into phases...');

      // Group items into phases
      const phases = this.groupIntoPhases(items, goal);

      // Assign team strategies
      this.assignTeamStrategies(phases);

      // Generate unique completion phrases
      this.generateCompletionPhrases(phases);

      const plan: OrchestratorPlan = {
        id: uuidv4(),
        goal,
        createdAt: Date.now(),
        phases,
        metadata: {
          totalTasks: phases.reduce((sum, p) => sum + p.tasks.length, 0),
          estimatedComplexity: this.estimateComplexity(items),
          modelUsed: this.config.plannerModel,
          planDurationMs: Date.now() - startTime,
        },
      };

      return plan;
    } finally {
      this.orchestrator = null;
    }
  }

  /** Cancel in-progress plan generation. */
  async cancel(): Promise<void> {
    if (this.orchestrator) {
      await this.orchestrator.cancel();
      this.orchestrator = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase Grouping
  // ═══════════════════════════════════════════════════════════════

  /**
   * Group PlanItems into sequential phases.
   *
   * Algorithm:
   * 1. Build dependency graph and assign IDs to items without them
   * 2. Topological sort into dependency layers (Kahn's algorithm)
   * 3. Sub-group within each layer by TDD phase
   * 4. Merge small phases with their neighbors
   */
  private groupIntoPhases(items: PlanItem[], _goal: string): OrchestratorPhase[] {
    // Ensure all items have IDs
    const indexedItems = items.map((item, i) => ({
      ...item,
      id: item.id || `task-${i}`,
    }));

    // Build adjacency and in-degree for Kahn's algorithm
    const idSet = new Set(indexedItems.map((item) => item.id!));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // id → items that depend on it

    for (const item of indexedItems) {
      inDegree.set(item.id!, 0);
      dependents.set(item.id!, []);
    }

    for (const item of indexedItems) {
      const deps = (item.dependencies || []).filter((d) => idSet.has(d));
      inDegree.set(item.id!, deps.length);
      for (const dep of deps) {
        dependents.get(dep)!.push(item.id!);
      }
    }

    // Kahn's algorithm — produce dependency layers
    const layers: PlanItem[][] = [];
    const remaining = new Set(indexedItems.map((item) => item.id!));

    while (remaining.size > 0) {
      // Find items with no remaining dependencies (in-degree 0)
      const layer: PlanItem[] = [];
      for (const id of remaining) {
        if (inDegree.get(id)! === 0) {
          layer.push(indexedItems.find((item) => item.id === id)!);
        }
      }

      if (layer.length === 0) {
        // Circular dependency — add all remaining items as a single layer
        for (const id of remaining) {
          layer.push(indexedItems.find((item) => item.id === id)!);
        }
      }

      layers.push(layer);

      // Remove this layer's items and update in-degrees
      for (const item of layer) {
        remaining.delete(item.id!);
        for (const dep of dependents.get(item.id!) || []) {
          if (remaining.has(dep)) {
            inDegree.set(dep, Math.max(0, inDegree.get(dep)! - 1));
          }
        }
      }
    }

    // Sub-group each layer by TDD phase
    const rawPhases: PlanItem[][] = [];
    for (const layer of layers) {
      const byPhase = new Map<string, PlanItem[]>();
      for (const item of layer) {
        const phase = item.tddPhase || 'impl';
        if (!byPhase.has(phase)) byPhase.set(phase, []);
        byPhase.get(phase)!.push(item);
      }

      // Sort sub-groups by TDD phase order
      const sorted = [...byPhase.entries()].sort(
        ([a], [b]) => (TDD_PHASE_ORDER[a as TddPhase] ?? 2) - (TDD_PHASE_ORDER[b as TddPhase] ?? 2)
      );

      for (const [, items] of sorted) {
        rawPhases.push(items);
      }
    }

    // Merge small phases with their previous neighbor
    const mergedPhases: PlanItem[][] = [];
    for (const phase of rawPhases) {
      if (mergedPhases.length > 0 && phase.length < MIN_PHASE_TASKS) {
        const prev = mergedPhases[mergedPhases.length - 1];
        if (prev.length < MIN_PHASE_TASKS) {
          // Merge with previous
          prev.push(...phase);
          continue;
        }
      }
      mergedPhases.push([...phase]);
    }

    // Cap at MAX_PHASES by merging tail phases
    while (mergedPhases.length > MAX_PHASES) {
      const last = mergedPhases.pop()!;
      mergedPhases[mergedPhases.length - 1].push(...last);
    }

    // Convert to OrchestratorPhase objects
    return mergedPhases.map((phaseItems, index) => this.createPhase(phaseItems, index));
  }

  private createPhase(items: PlanItem[], order: number): OrchestratorPhase {
    // Derive phase name from TDD phases and priorities
    const tddPhases = [...new Set(items.map((i) => i.tddPhase).filter(Boolean))];
    const name = this.generatePhaseName(items, tddPhases as TddPhase[], order);
    const description = items.map((i) => i.content).join('; ');

    const tasks: OrchestratorTask[] = items.map((item, i) => ({
      id: `phase-${order + 1}-task-${i + 1}`,
      phaseId: `phase-${order + 1}`,
      prompt: item.content,
      status: 'pending' as const,
      assignedSessionId: null,
      queueTaskId: null,
      parallel: items.length > 1, // Tasks within a phase are parallel by default
      completionPhrase: '', // Assigned later
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      startedAt: null,
      completedAt: null,
      error: null,
      retries: 0,
    }));

    // Extract verification criteria and test commands from items
    const verificationCriteria = items
      .map((i) => i.verificationCriteria)
      .filter((v): v is string => v != null && v.length > 0);

    const testCommands = items.map((i) => i.testCommand).filter((t): t is string => t != null && t.length > 0);

    return {
      id: `phase-${order + 1}`,
      name,
      description,
      order,
      status: 'pending' as PhaseStatus,
      tasks,
      verificationCriteria,
      testCommands,
      maxAttempts: this.config.maxPhaseRetries,
      attempts: 0,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      teamStrategy: { type: 'single' }, // Assigned later
    };
  }

  private generatePhaseName(items: PlanItem[], tddPhases: TddPhase[], order: number): string {
    // Try to create a meaningful name based on content
    const priorities = [...new Set(items.map((i) => i.priority).filter(Boolean))];

    if (tddPhases.length === 1) {
      const phaseNames: Record<TddPhase, string> = {
        setup: 'Setup & Configuration',
        test: 'Test Definition',
        impl: 'Implementation',
        verify: 'Verification',
        review: 'Review & Polish',
      };
      return `Phase ${order + 1}: ${phaseNames[tddPhases[0]]}`;
    }

    if (priorities.includes('P0') && priorities.length === 1) {
      return `Phase ${order + 1}: Critical Foundation`;
    }

    return `Phase ${order + 1}: ${items.length > 1 ? 'Parallel Tasks' : items[0].content.slice(0, 50)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Team Strategy Assignment
  // ═══════════════════════════════════════════════════════════════

  private assignTeamStrategies(phases: OrchestratorPhase[]): void {
    for (const phase of phases) {
      phase.teamStrategy = this.computeTeamStrategy(phase);
    }
  }

  private computeTeamStrategy(phase: OrchestratorPhase): TeamStrategy {
    const taskCount = phase.tasks.length;
    const parallelTasks = phase.tasks.filter((t) => t.parallel).length;

    // Single task or no parallel potential → single session
    if (taskCount <= 2 || parallelTasks <= 1) {
      return { type: 'single' };
    }

    // If team agents are disabled, use parallel sessions instead
    if (!this.config.enableTeamAgents) {
      return {
        type: 'parallel',
        maxSessions: Math.min(parallelTasks, this.config.maxParallelSessions),
      };
    }

    // 4+ parallel tasks with team agents enabled → team mode
    if (parallelTasks >= 4) {
      return {
        type: 'team',
        config: {
          leadPrompt: this.buildTeamLeadPrompt(phase),
          suggestedTeammates: phase.tasks.slice(0, 4).map((t) => `Specialist for: ${t.prompt.slice(0, 80)}`),
          maxTeammates: Math.min(parallelTasks, 4),
        },
      };
    }

    // 3 parallel tasks → parallel sessions
    return {
      type: 'parallel',
      maxSessions: Math.min(parallelTasks, this.config.maxParallelSessions),
    };
  }

  private buildTeamLeadPrompt(phase: OrchestratorPhase): string {
    const taskList = phase.tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join('\n');

    return [
      `You are the team lead for "${phase.name}".`,
      `Create teammates and delegate the following tasks for parallel execution:`,
      '',
      taskList,
      '',
      `Each teammate should focus on one task area.`,
      `When all tasks are complete, verify the results and output: <promise>${phase.id.toUpperCase()}_COMPLETE</promise>`,
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // Completion Phrases
  // ═══════════════════════════════════════════════════════════════

  private generateCompletionPhrases(phases: OrchestratorPhase[]): void {
    for (const phase of phases) {
      for (const task of phase.tasks) {
        // Generate a unique, deterministic completion phrase per task
        task.completionPhrase = `ORCH_P${phase.order + 1}_T${phase.tasks.indexOf(task) + 1}`;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════

  private estimateComplexity(items: PlanItem[]): 'low' | 'medium' | 'high' {
    const total = items.length;
    const highComplexity = items.filter((i) => i.complexity === 'high').length;
    const p0Count = items.filter((i) => i.priority === 'P0').length;

    if (total > 20 || highComplexity > 5 || p0Count > 8) return 'high';
    if (total > 10 || highComplexity > 2 || p0Count > 4) return 'medium';
    return 'low';
  }
}
