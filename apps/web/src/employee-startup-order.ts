/**
 * @fileoverview The order in which a startup or recovery pass attends to employees.
 *
 * A provider CLI on a subscription plan can stop at a screen the office does not answer (a first-run
 * chooser, a trust or permissions notice, a sign-in or usage-limit screen). An employee whose recipe
 * selects a model endpoint and no subscription account has no provider sign-in to wait on, so a pass
 * reaches it first: it is then connected while the others are still being brought back.
 *
 * Order only. Nobody waits on anybody: a pass that fails for one employee reports that and goes on to
 * the next, exactly as before. The order is read from the owner-selected runtime recipe, never from a
 * name or a title, and it grants nothing.
 */
import type { CompanyEmployee } from './company-types.js';

/** Recipe data only: a selected model endpoint and no subscription account. No recipe means unknown, so false. */
export function runsWithoutSubscription(employee: Pick<CompanyEmployee, 'runtimeRecipe'>): boolean {
  const recipe = employee.runtimeRecipe;
  return !!recipe?.customModel && !recipe.subscriptionProfile;
}

/**
 * Employees without a subscription account first, then the rest; inside each group everyone keeps the
 * order they were given in. Returns a new array; the input is not changed.
 */
export function employeeStartupOrder<T extends Pick<CompanyEmployee, 'runtimeRecipe'>>(employees: readonly T[]): T[] {
  return [...employees.filter(runsWithoutSubscription), ...employees.filter((e) => !runsWithoutSubscription(e))];
}

/** What a pass recorded for one employee: connected, or held with the reason. */
export interface StartupOutcome {
  readonly employeeId: string;
  readonly state: string;
  readonly code?: string;
}

/**
 * The line to log when an employee the pass reaches first is held, or undefined when there is nothing
 * new to say: it is not held, it is not one of the first group, or the last pass held it for the same
 * reason. The pass goes on to the others either way; this only says why the first one is not up.
 */
export function heldFirstNotice(
  employee: Pick<CompanyEmployee, 'id' | 'runtimeRecipe'>,
  outcome: StartupOutcome | undefined,
  prior: StartupOutcome | undefined
): string | undefined {
  if (outcome?.employeeId !== employee.id || outcome.state !== 'held' || !runsWithoutSubscription(employee))
    return undefined;
  if (prior?.state === 'held' && prior.code === outcome.code) return undefined;
  return `employee ${employee.id} has no subscription account and is held (${outcome.code ?? 'no reason given'}); continuing with the others`;
}
