/**
 * @fileoverview Orchestrator Loop prompt templates.
 *
 * Templates for phase execution, team delegation, verification, and replanning.
 * Placeholders use {VARIABLE} syntax and are replaced at runtime.
 *
 * @module prompts/orchestrator
 */

/**
 * Phase execution prompt — tells Claude what to accomplish in this phase.
 *
 * Placeholders:
 * - {PHASE_NUMBER}: Phase index (1-based)
 * - {PHASE_NAME}: Human-readable phase name
 * - {GOAL}: Original user goal
 * - {COMPLETED_PHASES}: Summary of previously completed phases
 * - {TASK_LIST}: Numbered task list for this phase
 * - {VERIFICATION_CRITERIA}: What will be checked after this phase
 * - {COMPLETION_PHRASE}: The phrase to output when done
 */
export const PHASE_EXECUTION_PROMPT = `You are executing {PHASE_NAME} of a larger project.

OVERALL GOAL: {GOAL}

COMPLETED SO FAR:
{COMPLETED_PHASES}

YOUR TASKS FOR THIS PHASE:
{TASK_LIST}

Complete each task thoroughly. Run tests after each change to catch issues early.

VERIFICATION (will be checked after you finish):
{VERIFICATION_CRITERIA}

When ALL tasks in this phase are complete and verified, output: <promise>{COMPLETION_PHRASE}</promise>`;

/**
 * Team lead delegation prompt — instructs a lead to coordinate teammates.
 *
 * Placeholders:
 * - {PHASE_NAME}: Phase name
 * - {TASK_LIST}: Numbered task list
 * - {TEAMMATE_HINTS}: Suggested teammate specializations
 * - {COMPLETION_PHRASE}: Phrase for when all work is done
 */
export const TEAM_LEAD_PROMPT = `You are the team lead for {PHASE_NAME}.

Create teammates and delegate the following tasks for parallel execution:

{TASK_LIST}

Suggested teammate roles:
{TEAMMATE_HINTS}

Each teammate should focus on their assigned task area. Monitor their progress.
When ALL tasks are complete and you've verified the results, output: <promise>{COMPLETION_PHRASE}</promise>`;

/**
 * Replan prompt — gives failure context and asks for recovery.
 *
 * Placeholders:
 * - {PHASE_NAME}: Phase name
 * - {ATTEMPT_NUMBER}: Current retry attempt
 * - {MAX_ATTEMPTS}: Maximum attempts allowed
 * - {FAILURE_SUMMARY}: What went wrong
 * - {SUGGESTIONS}: Recovery suggestions from verification
 * - {ORIGINAL_TASKS}: The original task list
 * - {COMPLETION_PHRASE}: Phrase for when recovery is done
 */
export const REPLAN_PROMPT = `Phase "{PHASE_NAME}" verification failed (attempt {ATTEMPT_NUMBER}/{MAX_ATTEMPTS}).

WHAT WENT WRONG:
{FAILURE_SUMMARY}

SUGGESTIONS:
{SUGGESTIONS}

ORIGINAL TASKS:
{ORIGINAL_TASKS}

Fix the issues identified above. Focus on making the verification criteria pass.
When the fixes are complete, output: <promise>{COMPLETION_PHRASE}</promise>`;

/**
 * Single-task execution prompt — for phases with a single task.
 *
 * Placeholders:
 * - {TASK}: The task description
 * - {GOAL}: Original user goal
 * - {CONTEXT}: Any relevant context
 * - {COMPLETION_PHRASE}: Phrase for when done
 */
export const SINGLE_TASK_PROMPT = `{TASK}

Context: This is part of a larger project — {GOAL}
{CONTEXT}

When done, output: <promise>{COMPLETION_PHRASE}</promise>`;
