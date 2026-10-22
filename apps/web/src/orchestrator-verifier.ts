/**
 * @fileoverview Orchestrator phase verification.
 *
 * Runs verification checks after each phase completes:
 * - Test commands (shell commands via session)
 * - AI review (ask Claude to evaluate phase results)
 *
 * Three verification modes:
 * - strict: ALL test commands must pass AND AI review must approve
 * - moderate: Test commands must pass, AI review is advisory
 * - lenient: At least one test command passes, AI review skipped
 *
 * Key exports:
 * - `OrchestratorVerifier` class — phase verification engine
 *
 * @dependencies types (OrchestratorPhase, VerificationResult, VerificationCheck, OrchestratorConfig)
 * @consumedby orchestrator-loop
 *
 * @module orchestrator-verifier
 */

import type { Session } from './session.js';
import {
  getErrorMessage,
  type OrchestratorPhase,
  type OrchestratorConfig,
  type VerificationResult,
  type VerificationCheck,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Timeout for individual test command execution (2 minutes) */
const TEST_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** Timeout for AI review (3 minutes) */
const AI_REVIEW_TIMEOUT_MS = 3 * 60 * 1000;

/** Completion phrase for AI verification pass */
const VERIFY_PASS_PHRASE = 'ORCH_VERIFY_PASS';

/** Completion phrase for AI verification fail */
const VERIFY_FAIL_PHRASE = 'ORCH_VERIFY_FAIL';

// ═══════════════════════════════════════════════════════════════
// OrchestratorVerifier
// ═══════════════════════════════════════════════════════════════

export class OrchestratorVerifier {
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  /**
   * Run all verification checks for a completed phase.
   *
   * @param phase - The phase to verify
   * @param session - Session to use for running commands/reviews
   * @returns Verification result with pass/fail and suggestions
   */
  async verifyPhase(phase: OrchestratorPhase, session: Session): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const mode = this.config.verificationMode;

    // Skip verification entirely in lenient mode with no test commands
    if (mode === 'lenient' && phase.testCommands.length === 0 && phase.verificationCriteria.length === 0) {
      return {
        passed: true,
        checks: [],
        summary: 'Verification skipped (lenient mode, no checks defined)',
        suggestions: [],
      };
    }

    // Run test commands if any are defined
    if (phase.testCommands.length > 0) {
      const testChecks = await this.runTestCommands(phase.testCommands, session);
      checks.push(...testChecks);
    }

    // Run AI review in strict and moderate modes
    if (mode !== 'lenient' && phase.verificationCriteria.length > 0) {
      const aiCheck = await this.aiReview(phase, session);
      checks.push(aiCheck);
    }

    // Determine pass/fail based on mode
    const passed = this.evaluateChecks(checks, mode);

    // Generate suggestions for failed checks
    const suggestions = this.generateSuggestions(checks, phase);

    const passedCount = checks.filter((c) => c.passed).length;
    const summary =
      checks.length === 0 ? 'No verification checks defined' : `${passedCount}/${checks.length} checks passed`;

    return { passed, checks, summary, suggestions };
  }

  // ═══════════════════════════════════════════════════════════════
  // Test Command Execution
  // ═══════════════════════════════════════════════════════════════

  private async runTestCommands(commands: string[], session: Session): Promise<VerificationCheck[]> {
    const checks: VerificationCheck[] = [];

    for (const command of commands) {
      try {
        const check = await this.runSingleTestCommand(command, session);
        checks.push(check);
      } catch (err) {
        checks.push({
          type: 'test_command',
          description: `Run: ${command}`,
          passed: false,
          output: getErrorMessage(err),
        });
      }
    }

    return checks;
  }

  private async runSingleTestCommand(command: string, session: Session): Promise<VerificationCheck> {
    // Send the test command to the session and wait for completion
    // We use a unique marker to detect when the command finishes
    const marker = `ORCH_TEST_${Date.now()}`;
    const wrappedCommand = `${command} && echo ${marker}_PASS || echo ${marker}_FAIL`;

    const result = await this.sendAndWaitForMarker(session, wrappedCommand, marker, TEST_COMMAND_TIMEOUT_MS);

    return {
      type: 'test_command',
      description: `Run: ${command}`,
      passed: result.includes(`${marker}_PASS`),
      output: result.slice(0, 2000), // Truncate output
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // AI Review
  // ═══════════════════════════════════════════════════════════════

  private async aiReview(phase: OrchestratorPhase, session: Session): Promise<VerificationCheck> {
    const prompt = this.buildVerificationPrompt(phase);

    try {
      const result = await this.sendAndWaitForMarker(
        session,
        prompt,
        VERIFY_PASS_PHRASE,
        AI_REVIEW_TIMEOUT_MS,
        VERIFY_FAIL_PHRASE
      );

      const passed = result.includes(VERIFY_PASS_PHRASE);

      return {
        type: 'ai_review',
        description: `AI review of "${phase.name}"`,
        passed,
        output: result.slice(0, 3000),
      };
    } catch (err) {
      return {
        type: 'ai_review',
        description: `AI review of "${phase.name}"`,
        passed: false,
        output: `AI review timed out or failed: ${getErrorMessage(err)}`,
      };
    }
  }

  private buildVerificationPrompt(phase: OrchestratorPhase): string {
    const criteria = phase.verificationCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

    return [
      `Review the work done in "${phase.name}". Check these criteria:`,
      '',
      criteria,
      '',
      `If ALL criteria are met, respond with: ${VERIFY_PASS_PHRASE}`,
      `If ANY criteria fail, respond with: ${VERIFY_FAIL_PHRASE} and explain what failed.`,
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // Evaluation
  // ═══════════════════════════════════════════════════════════════

  private evaluateChecks(checks: VerificationCheck[], mode: OrchestratorConfig['verificationMode']): boolean {
    if (checks.length === 0) return true;

    const testChecks = checks.filter((c) => c.type === 'test_command');
    const aiChecks = checks.filter((c) => c.type === 'ai_review');

    switch (mode) {
      case 'strict':
        // ALL checks must pass
        return checks.every((c) => c.passed);

      case 'moderate':
        // All test commands must pass; AI review is advisory
        return testChecks.length === 0 || testChecks.every((c) => c.passed);

      case 'lenient':
        // At least one test passes (AI review skipped in lenient mode)
        return testChecks.length === 0 || testChecks.some((c) => c.passed);

      default:
        return aiChecks.every((c) => c.passed) && testChecks.every((c) => c.passed);
    }
  }

  private generateSuggestions(checks: VerificationCheck[], phase: OrchestratorPhase): string[] {
    const suggestions: string[] = [];
    const failedChecks = checks.filter((c) => !c.passed);

    if (failedChecks.length === 0) return suggestions;

    for (const check of failedChecks) {
      if (check.type === 'test_command') {
        suggestions.push(`Fix failing test: ${check.description}`);
      } else if (check.type === 'ai_review' && check.output) {
        // Extract failure reasons from AI review output
        suggestions.push(`Address AI review feedback for "${phase.name}"`);
      }
    }

    return suggestions;
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Communication
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a prompt to a session and wait for a marker phrase in the output.
   *
   * @param session - Session to send to
   * @param input - Prompt/command to send
   * @param marker - Primary marker to watch for
   * @param timeoutMs - Maximum wait time
   * @param altMarker - Alternative marker (for pass/fail detection)
   * @returns Captured output containing the marker
   */
  private sendAndWaitForMarker(
    session: Session,
    input: string,
    marker: string,
    timeoutMs: number,
    altMarker?: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let output = '';
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Timeout waiting for marker "${marker}" after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const handler = (data: string) => {
        if (resolved) return;
        output += data;

        if (output.includes(marker) || (altMarker && output.includes(altMarker))) {
          resolved = true;
          cleanup();
          resolve(output);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        session.off('terminal', handler);
      };

      session.on('terminal', handler);

      // Send the input
      session.sendInput(input).catch((err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });
    });
  }
}
