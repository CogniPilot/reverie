/**
 * @fileoverview RalphStatusParser - RALPH_STATUS block parsing and circuit breaker
 *
 * Parses structured RALPH_STATUS blocks from Claude Code output
 * and manages the circuit breaker state machine.
 *
 * Extracted from ralph-tracker.ts as part of domain splitting.
 *
 * @module ralph-status-parser
 */

import { EventEmitter } from 'node:events';
import type {
  RalphStatusBlock,
  RalphStatusValue,
  RalphTestsStatus,
  RalphWorkType,
  CircuitBreakerStatus,
} from './types.js';
import { createInitialCircuitBreakerStatus } from './types.js';

// ---------- RALPH_STATUS Block Patterns ----------
// Based on Ralph Claude Code structured status reporting

/**
 * Matches the start of a RALPH_STATUS block
 * Pattern: ---RALPH_STATUS---
 */
const RALPH_STATUS_START_PATTERN = /^---RALPH_STATUS---\s*$/;

/**
 * Matches the end of a RALPH_STATUS block
 * Pattern: ---END_RALPH_STATUS---
 */
const RALPH_STATUS_END_PATTERN = /^---END_RALPH_STATUS---\s*$/;

/**
 * Matches STATUS field in RALPH_STATUS block
 * Captures: IN_PROGRESS | COMPLETE | BLOCKED
 */
const RALPH_STATUS_FIELD_PATTERN = /^STATUS:\s*(IN_PROGRESS|COMPLETE|BLOCKED)\s*$/i;

/**
 * Matches TASKS_COMPLETED_THIS_LOOP field
 * Captures: number
 */
const RALPH_TASKS_COMPLETED_PATTERN = /^TASKS_COMPLETED_THIS_LOOP:\s*(\d+)\s*$/i;

/**
 * Matches FILES_MODIFIED field
 * Captures: number
 */
const RALPH_FILES_MODIFIED_PATTERN = /^FILES_MODIFIED:\s*(\d+)\s*$/i;

/**
 * Matches TESTS_STATUS field
 * Captures: PASSING | FAILING | NOT_RUN
 */
const RALPH_TESTS_STATUS_PATTERN = /^TESTS_STATUS:\s*(PASSING|FAILING|NOT_RUN)\s*$/i;

/**
 * Matches WORK_TYPE field
 * Captures: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING
 */
const RALPH_WORK_TYPE_PATTERN = /^WORK_TYPE:\s*(IMPLEMENTATION|TESTING|DOCUMENTATION|REFACTORING)\s*$/i;

/**
 * Matches EXIT_SIGNAL field
 * Captures: true | false
 */
const RALPH_EXIT_SIGNAL_PATTERN = /^EXIT_SIGNAL:\s*(true|false)\s*$/i;

/**
 * Matches RECOMMENDATION field
 * Captures: any text
 */
const RALPH_RECOMMENDATION_PATTERN = /^RECOMMENDATION:\s*(.+)$/i;

// ---------- Completion Indicator Patterns (for dual-condition exit) ----------

/**
 * Patterns that indicate potential completion (natural language)
 * Count >= 2 along with EXIT_SIGNAL: true triggers exit
 */
const COMPLETION_INDICATOR_PATTERNS = [
  /all\s+(?:tasks?|items?|work)\s+(?:are\s+)?(?:completed?|done|finished)/i,
  /(?:completed?|finished)\s+all\s+(?:tasks?|items?|work)/i,
  /nothing\s+(?:left|remaining)\s+to\s+do/i,
  /no\s+more\s+(?:tasks?|items?|work)/i,
  /everything\s+(?:is\s+)?(?:completed?|done)/i,
  /project\s+(?:is\s+)?(?:completed?|done|finished)/i,
];

interface FieldParser<T> {
  pattern: RegExp;
  field: keyof RalphStatusBlock;
  validate: (value: string) => boolean;
  transform: (value: string) => T;
  errorMsg: (value: string) => string;
}

const FIELD_PARSERS: FieldParser<RalphStatusValue | RalphTestsStatus | RalphWorkType | number | boolean | string>[] = [
  {
    pattern: RALPH_STATUS_FIELD_PATTERN,
    field: 'status',
    validate: (v) => ['IN_PROGRESS', 'COMPLETE', 'BLOCKED'].includes(v.toUpperCase()),
    transform: (v) => v.toUpperCase() as RalphStatusValue,
    errorMsg: (v) => `Invalid STATUS value: "${v}". Expected: IN_PROGRESS, COMPLETE, or BLOCKED`,
  },
  {
    pattern: RALPH_TASKS_COMPLETED_PATTERN,
    field: 'tasksCompletedThisLoop',
    validate: (v) => !Number.isNaN(parseInt(v, 10)) && parseInt(v, 10) >= 0,
    transform: (v) => parseInt(v, 10),
    errorMsg: (v) => `Invalid TASKS_COMPLETED_THIS_LOOP value: "${v}". Expected: non-negative integer`,
  },
  {
    pattern: RALPH_FILES_MODIFIED_PATTERN,
    field: 'filesModified',
    validate: (v) => !Number.isNaN(parseInt(v, 10)) && parseInt(v, 10) >= 0,
    transform: (v) => parseInt(v, 10),
    errorMsg: (v) => `Invalid FILES_MODIFIED value: "${v}". Expected: non-negative integer`,
  },
  {
    pattern: RALPH_TESTS_STATUS_PATTERN,
    field: 'testsStatus',
    validate: (v) => ['PASSING', 'FAILING', 'NOT_RUN'].includes(v.toUpperCase()),
    transform: (v) => v.toUpperCase() as RalphTestsStatus,
    errorMsg: (v) => `Invalid TESTS_STATUS value: "${v}". Expected: PASSING, FAILING, or NOT_RUN`,
  },
  {
    pattern: RALPH_WORK_TYPE_PATTERN,
    field: 'workType',
    validate: (v) => ['IMPLEMENTATION', 'TESTING', 'DOCUMENTATION', 'REFACTORING'].includes(v.toUpperCase()),
    transform: (v) => v.toUpperCase() as RalphWorkType,
    errorMsg: (v) =>
      `Invalid WORK_TYPE value: "${v}". Expected: IMPLEMENTATION, TESTING, DOCUMENTATION, or REFACTORING`,
  },
  {
    pattern: RALPH_EXIT_SIGNAL_PATTERN,
    field: 'exitSignal',
    validate: () => true,
    transform: (v) => v.toLowerCase() === 'true',
    errorMsg: () => '',
  },
  {
    pattern: RALPH_RECOMMENDATION_PATTERN,
    field: 'recommendation',
    validate: () => true,
    transform: (v) => v.trim(),
    errorMsg: () => '',
  },
];

/**
 * RalphStatusParser - Parses RALPH_STATUS blocks and manages circuit breaker.
 *
 * Events emitted:
 * - `statusBlockDetected` - When a complete RALPH_STATUS block is parsed
 * - `circuitBreakerUpdate` - When circuit breaker state changes
 * - `exitGateMet` - When dual-condition exit gate is met
 */
export class RalphStatusParser extends EventEmitter {
  /** Circuit breaker state tracking */
  private _circuitBreaker: CircuitBreakerStatus;

  /** Buffer for RALPH_STATUS block lines */
  private _statusBlockBuffer: string[] = [];

  /** Flag indicating we're inside a RALPH_STATUS block */
  private _inStatusBlock: boolean = false;

  /** Last parsed RALPH_STATUS block */
  private _lastStatusBlock: RalphStatusBlock | null = null;

  /** Count of completion indicators detected (for dual-condition exit) */
  private _completionIndicators: number = 0;

  /** Whether dual-condition exit gate has been met */
  private _exitGateMet: boolean = false;

  /** Cumulative files modified across all iterations */
  private _totalFilesModified: number = 0;

  /** Cumulative tasks completed across all iterations */
  private _totalTasksCompleted: number = 0;

  /** Current cycle count (fed by parent) */
  private _cycleCount: number = 0;

  constructor() {
    super();
    this._circuitBreaker = createInitialCircuitBreakerStatus();
  }

  /**
   * Process a line for status block detection and completion indicators.
   * Main entry point - call this for each trimmed line.
   */
  processLine(line: string): void {
    this.processStatusBlockLine(line);
    this.detectCompletionIndicators(line);
  }

  /**
   * Set the current cycle count (fed by parent for circuit breaker tracking).
   */
  setCycleCount(cycleCount: number): void {
    this._cycleCount = cycleCount;
  }

  /**
   * Notify of iteration progress (for circuit breaker reset on progress).
   * Called by parent when iteration count changes.
   */
  notifyIterationProgress(currentIteration: number): void {
    if (
      this._circuitBreaker.state === 'HALF_OPEN' ||
      this._circuitBreaker.consecutiveNoProgress > 0 ||
      this._circuitBreaker.consecutiveSameError > 0 ||
      this._circuitBreaker.consecutiveTestsFailure > 0
    ) {
      this._circuitBreaker.consecutiveNoProgress = 0;
      this._circuitBreaker.consecutiveSameError = 0;
      this._circuitBreaker.lastProgressIteration = currentIteration;
      if (this._circuitBreaker.state === 'HALF_OPEN') {
        this._circuitBreaker.state = 'CLOSED';
        this._circuitBreaker.reason = 'Iteration progress detected';
        this._circuitBreaker.reasonCode = 'progress_detected';
        this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
      }
    }
  }

  /**
   * Get current circuit breaker status.
   */
  get circuitBreakerStatus(): CircuitBreakerStatus {
    return { ...this._circuitBreaker };
  }

  /**
   * Get last parsed RALPH_STATUS block.
   */
  get lastStatusBlock(): RalphStatusBlock | null {
    return this._lastStatusBlock ? { ...this._lastStatusBlock } : null;
  }

  /**
   * Get cumulative stats from status blocks.
   */
  get cumulativeStats(): {
    filesModified: number;
    tasksCompleted: number;
    completionIndicators: number;
  } {
    return {
      filesModified: this._totalFilesModified,
      tasksCompleted: this._totalTasksCompleted,
      completionIndicators: this._completionIndicators,
    };
  }

  /**
   * Whether dual-condition exit gate has been met.
   */
  get exitGateMet(): boolean {
    return this._exitGateMet;
  }

  /**
   * Manually reset circuit breaker to CLOSED state.
   * Use when user acknowledges the issue is resolved.
   *
   * @fires circuitBreakerUpdate
   */
  resetCircuitBreaker(): void {
    this._circuitBreaker = createInitialCircuitBreakerStatus();
    this._circuitBreaker.reason = 'Manual reset';
    this._circuitBreaker.reasonCode = 'manual_reset';
    this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
  }

  /**
   * Reset status parser state (soft reset).
   * Clears status block buffer and completion indicators.
   * Keeps circuit breaker state (it tracks across iterations).
   */
  reset(): void {
    this._statusBlockBuffer = [];
    this._inStatusBlock = false;
    this._lastStatusBlock = null;
    this._completionIndicators = 0;
    this._exitGateMet = false;
    this._totalFilesModified = 0;
    this._totalTasksCompleted = 0;
    // Keep circuit breaker state on soft reset (it tracks across iterations)
  }

  /**
   * Full reset - clears all state including circuit breaker.
   */
  fullReset(): void {
    this.reset();
    this._circuitBreaker = createInitialCircuitBreakerStatus();
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this._statusBlockBuffer.length = 0;
    this.removeAllListeners();
  }

  // ========== Private Methods ==========

  /**
   * Process a line for RALPH_STATUS block detection.
   * Buffers lines between ---RALPH_STATUS--- and ---END_RALPH_STATUS---
   * then parses the complete block.
   *
   * @param line - Single line to process (already trimmed)
   * @fires statusBlockDetected - When a complete block is parsed
   */
  private processStatusBlockLine(line: string): void {
    // Check for block start
    if (RALPH_STATUS_START_PATTERN.test(line)) {
      this._inStatusBlock = true;
      this._statusBlockBuffer = [];
      return;
    }

    // Check for block end
    if (this._inStatusBlock && RALPH_STATUS_END_PATTERN.test(line)) {
      this._inStatusBlock = false;
      this.parseStatusBlock(this._statusBlockBuffer);
      this._statusBlockBuffer = [];
      return;
    }

    // Buffer lines while in block
    if (this._inStatusBlock) {
      this._statusBlockBuffer.push(line);
    }
  }

  /**
   * Parse buffered RALPH_STATUS block lines into structured data.
   *
   * P1-004: Enhanced with schema validation and error recovery
   *
   * @param lines - Array of lines between block markers
   * @fires statusBlockDetected - When parsing succeeds
   */
  private parseStatusBlock(lines: string[]): void {
    const block: Partial<RalphStatusBlock> = {
      parsedAt: Date.now(),
    };
    const parseErrors: string[] = [];
    const unknownFields: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      let matched = false;

      for (const parser of FIELD_PARSERS) {
        const match = trimmedLine.match(parser.pattern);
        if (match) {
          const rawValue = match[1];
          if (parser.validate(rawValue)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (block as any)[parser.field] = parser.transform(rawValue);
          } else {
            parseErrors.push(parser.errorMsg(rawValue));
          }
          matched = true;
          break;
        }
      }

      // Track unknown fields for debugging (only if looks like a field)
      if (!matched && trimmedLine.includes(':')) {
        const fieldName = trimmedLine.split(':')[0].trim().toUpperCase();
        if (fieldName && !['#', '//'].some((c) => fieldName.startsWith(c))) {
          unknownFields.push(fieldName);
        }
      }
    }

    // Log parse errors if any
    if (parseErrors.length > 0) {
      console.warn(`[RalphStatusParser] RALPH_STATUS parse errors:\n  - ${parseErrors.join('\n  - ')}`);
    }

    // Log unknown fields if any
    if (unknownFields.length > 0) {
      console.warn(`[RalphStatusParser] RALPH_STATUS unknown fields: ${unknownFields.join(', ')}`);
    }

    // Validate required field: STATUS
    if (block.status === undefined) {
      console.warn('[RalphStatusParser] RALPH_STATUS block missing required STATUS field, skipping');
      return;
    }

    // Fill in defaults for missing optional fields
    const fullBlock: RalphStatusBlock = {
      status: block.status,
      tasksCompletedThisLoop: block.tasksCompletedThisLoop ?? 0,
      filesModified: block.filesModified ?? 0,
      testsStatus: block.testsStatus ?? 'NOT_RUN',
      workType: block.workType ?? 'IMPLEMENTATION',
      exitSignal: block.exitSignal ?? false,
      recommendation: block.recommendation ?? '',
      parsedAt: block.parsedAt!,
    };

    this._lastStatusBlock = fullBlock;
    this.handleStatusBlock(fullBlock);
  }

  /**
   * Handle a parsed RALPH_STATUS block.
   * Updates circuit breaker, checks exit conditions.
   *
   * @param block - Parsed status block
   * @fires statusBlockDetected - With the block data
   * @fires circuitBreakerUpdate - If state changes
   * @fires exitGateMet - If dual-condition exit triggered
   */
  private handleStatusBlock(block: RalphStatusBlock): void {
    // Update cumulative counts
    this._totalFilesModified += block.filesModified;
    this._totalTasksCompleted += block.tasksCompletedThisLoop;

    // Check for progress (for circuit breaker)
    const hasProgress = block.filesModified > 0 || block.tasksCompletedThisLoop > 0;

    // Update circuit breaker
    this.updateCircuitBreaker(hasProgress, block.testsStatus, block.status);

    // Check completion indicators
    if (block.status === 'COMPLETE') {
      this._completionIndicators++;
    }

    // Check dual-condition exit gate
    if (block.exitSignal && this._completionIndicators >= 2 && !this._exitGateMet) {
      this._exitGateMet = true;
      this.emit('exitGateMet', {
        completionIndicators: this._completionIndicators,
        exitSignal: true,
      });
    }

    // Emit the status block
    this.emit('statusBlockDetected', block);
  }

  /**
   * Update circuit breaker state based on iteration results.
   *
   * @param hasProgress - Whether this iteration made progress
   * @param testsStatus - Current test status
   * @param status - Overall status from RALPH_STATUS
   * @fires circuitBreakerUpdate - If state changes
   */
  private updateCircuitBreaker(hasProgress: boolean, testsStatus: RalphTestsStatus, status: RalphStatusValue): void {
    const prevState = this._circuitBreaker.state;

    if (hasProgress) {
      this._handleProgressDetected();
    } else {
      this._handleNoProgress();
    }

    // Track tests failure
    if (testsStatus === 'FAILING') {
      this._circuitBreaker.consecutiveTestsFailure++;
      if (this._circuitBreaker.consecutiveTestsFailure >= 5 && this._circuitBreaker.state !== 'OPEN') {
        this._circuitBreaker.state = 'OPEN';
        this._circuitBreaker.reason = `Tests failing for ${this._circuitBreaker.consecutiveTestsFailure} iterations`;
        this._circuitBreaker.reasonCode = 'tests_failing_too_long';
      }
    } else {
      this._circuitBreaker.consecutiveTestsFailure = 0;
    }

    // Track blocked status
    if (status === 'BLOCKED' && this._circuitBreaker.state !== 'OPEN') {
      this._circuitBreaker.state = 'OPEN';
      this._circuitBreaker.reason = 'Claude reported BLOCKED status';
      this._circuitBreaker.reasonCode = 'same_error_repeated';
    }

    // Emit if state changed
    if (prevState !== this._circuitBreaker.state) {
      this._circuitBreaker.lastTransitionAt = Date.now();
      this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
    }
  }

  private _handleProgressDetected(): void {
    this._circuitBreaker.consecutiveNoProgress = 0;
    this._circuitBreaker.consecutiveSameError = 0;
    this._circuitBreaker.lastProgressIteration = this._cycleCount;

    if (this._circuitBreaker.state === 'HALF_OPEN') {
      this._circuitBreaker.state = 'CLOSED';
      this._circuitBreaker.reason = 'Progress detected, circuit closed';
      this._circuitBreaker.reasonCode = 'progress_detected';
    }
  }

  private _handleNoProgress(): void {
    this._circuitBreaker.consecutiveNoProgress++;

    if (this._circuitBreaker.state === 'CLOSED') {
      if (this._circuitBreaker.consecutiveNoProgress >= 3) {
        this._circuitBreaker.state = 'OPEN';
        this._circuitBreaker.reason = `No progress for ${this._circuitBreaker.consecutiveNoProgress} iterations`;
        this._circuitBreaker.reasonCode = 'no_progress_open';
      } else if (this._circuitBreaker.consecutiveNoProgress >= 2) {
        this._circuitBreaker.state = 'HALF_OPEN';
        this._circuitBreaker.reason = 'Warning: no progress detected';
        this._circuitBreaker.reasonCode = 'no_progress_warning';
      }
    } else if (this._circuitBreaker.state === 'HALF_OPEN') {
      if (this._circuitBreaker.consecutiveNoProgress >= 3) {
        this._circuitBreaker.state = 'OPEN';
        this._circuitBreaker.reason = `No progress for ${this._circuitBreaker.consecutiveNoProgress} iterations`;
        this._circuitBreaker.reasonCode = 'no_progress_open';
      }
    }
  }

  /**
   * Check line for completion indicators (natural language patterns).
   * Used for dual-condition exit gate.
   *
   * @param line - Line to check
   */
  private detectCompletionIndicators(line: string): void {
    for (const pattern of COMPLETION_INDICATOR_PATTERNS) {
      if (pattern.test(line)) {
        this._completionIndicators++;
        break; // Only count once per line
      }
    }
  }
}
