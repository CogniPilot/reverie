/**
 * @fileoverview The one place an employee's Claude model is chosen and applied.
 *
 * - `choose()` records a model (and optionally an effort) for an employee and applies it to the live
 *   session. Owner and granted employees reach it through `PUT /api/company/employees/:id/model`
 *   (employee-model-routes.ts); the route decides who may, this service decides what happens.
 * - `tick()` runs every MODEL_TICK_MS. It keeps each Claude employee on its recorded choice (so a
 *   restart, rebuild or plan move that comes back on another model is switched again at its next
 *   idle moment), moves an employee off a model that reached its per-model usage limit to the
 *   company's fallback model, and switches back after the stated reset time.
 *
 * The model is applied the way a person would: `/model <id>` typed into the pane. It is typed only
 * when the session is not mid-turn, no dialog, menu or start-up screen is up, and the composer reads
 * empty (`paneRefusesCommand`), and the write itself is idle-and-empty gated (`writeViaMux` with
 * `requireIdle` + `requireEmptyComposer`), so nothing is ever typed over a person's draft. Otherwise
 * the choice stays pending and the next tick tries again. Success is read back from the model the
 * CLI reports (statusline) or its own `Set model to …` reply; an unconfirmed switch is retried a
 * bounded number of times, then reported failed until the choice or the session changes.
 *
 * A limit's menu or auto-continue footer is answered with Escape only, never a digit or Enter (one
 * of its options buys usage credits). Escape also clears the footer the chat delivery waited behind
 * (`paneDialog`: its "Esc to cancel" hint reads as an open dialog), and the dialog flag is re-read
 * at once so queued chat flows again.
 *
 * Claude only, through the registry's model capability (`takesModel`), never a mode check.
 *
 * @module employee-model-service
 */
import {
  fallbackNudge,
  fallbackRestoreAt,
  limitPromptSurface,
  modelMatchesDisplay,
  paneRefusesCommand,
  planEmployeeModel,
  readModelConfirmation,
  readModelLimit,
  type ModelFallbackRecord,
  type PaneRefusal,
} from './employee-model-policy.js';
import type {
  EmployeeModelEntry,
  EmployeeModelPreference,
  EmployeeModelStore,
  ModelEffort,
} from './employee-model-store.js';

/** How often every Claude employee is looked at. */
export const MODEL_TICK_MS = 20_000;
/** The first look after boot waits for startup and restore. */
export const MODEL_FIRST_TICK_MS = 60_000;
/** How long a typed `/model` is watched for confirmation before it may be typed again. */
export const MODEL_CONFIRM_MS = 20_000;
/** Unconfirmed tries per session and model before the switch is reported failed. */
export const MODEL_MAX_TRIES = 3;
/** Escape presses at most, per attempt, on a limit menu or footer. */
const MAX_ESCAPES = 2;
const ESCAPE_SETTLE_MS = 800;
/** How long a refused resume nudge is retried. */
const NUDGE_WINDOW_MS = 10 * 60_000;

export class EmployeeModelError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The company fields the service reads. */
export interface ModelEmployee {
  id: string;
  name: string;
  owner?: string;
  sessionId: string;
  onVacation: boolean;
  desiredRunning?: boolean;
  /** The saved launch recipe's CLI, for an employee whose session is not loaded. */
  mode?: string;
}

/** The session calls the service needs; `Session` satisfies it. */
export interface ModelSession {
  readonly id: string;
  readonly mode: string;
  readonly pid: number | null;
  readonly isWorking: boolean;
  readonly providerDispatchHeld: boolean;
  readonly terminalInputHeld: boolean;
  readonly paneDialog?: string | null;
  readonly displayModel?: { model: string };
  readScreen(): string | null;
  readScreenAsync(): Promise<string | null>;
  startupScreen(): unknown;
  refreshPaneDialog?(): void;
  writeViaMux(data: string, options?: { requireIdle?: boolean; requireEmptyComposer?: boolean }): Promise<boolean>;
}

export interface EmployeeModelDeps {
  store: Pick<EmployeeModelStore, 'get' | 'set'>;
  employees(): readonly ModelEmployee[];
  session(sessionId: string): ModelSession | undefined;
  /** Does this CLI take Claude's per-session model and `/model` (registry `model.source`)? */
  takesModel(mode: string): boolean;
  /** The CLI's composer glyph (`capabilities.workDetect.promptGlyph`). */
  glyph(mode: string): string;
  /** The company's fallback model for a per-model limit, or null when it is off. */
  fallbackModel(owner: string | undefined): string | null;
  /** The company's IANA time zone, for the reset time people read. */
  timeZone(owner: string | undefined): string;
  /** Post one line in the company's office room; must not throw. */
  post?(owner: string | undefined, text: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?(line: string): void;
}

export type ModelApplyState = 'applied' | 'pending' | 'failed' | 'none' | 'unsupported';

export interface EmployeeModelStatus {
  employeeId: string;
  name: string;
  /** True when the employee's CLI takes a model this way. */
  supported: boolean;
  preferred?: EmployeeModelPreference;
  /** The model the running CLI reports, if any. */
  live?: string;
  /** The model the office is keeping this employee on now (a fallback wins over the choice). */
  target?: string;
  state: ModelApplyState;
  /** Why a pending or failed switch is not applied yet, in plain words. */
  reason?: string;
  fallback?: ModelFallbackRecord & { restoreAt: number };
}

interface Attempt {
  key: string;
  model: string;
  at: number;
  tries: number;
  state: 'typed' | 'applied' | 'failed';
}

const REFUSAL_TEXT: Readonly<
  Record<PaneRefusal | 'not-running' | 'held' | 'working' | 'startup' | 'write-refused', string>
> = {
  'not-running': 'its session is not running here',
  held: 'its terminal input is held',
  working: 'it is in the middle of a turn',
  startup: 'a start-up screen is showing',
  unreadable: 'its screen could not be read',
  'limit-prompt': 'a usage-limit menu is showing',
  dialog: 'a dialog is open in its terminal',
  'no-composer': 'its composer is not showing',
  'composer-not-empty': 'something is typed in its composer',
  'write-refused': 'its terminal was not idle when the command was about to be typed',
};

export class EmployeeModelService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly waits = new Map<string, string>();
  private readonly busy = new Set<string>();
  private readonly nudgeDue = new Set<string>();
  /** Fallbacks whose resume nudge is still to be typed, and since when. */
  private readonly nudges = new Map<string, number>();
  private readonly effortSent = new Map<string, string>();
  private ticking = false;
  private firstTick: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: EmployeeModelDeps) {}

  start(): void {
    if (this.interval || this.firstTick) return;
    this.firstTick = setTimeout(() => {
      this.firstTick = undefined;
      void this.tick();
      this.interval = setInterval(() => void this.tick(), MODEL_TICK_MS);
      this.interval.unref?.();
    }, MODEL_FIRST_TICK_MS);
    this.firstTick.unref?.();
  }

  stop(): void {
    if (this.firstTick) clearTimeout(this.firstTick);
    if (this.interval) clearInterval(this.interval);
    this.firstTick = undefined;
    this.interval = undefined;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(`[models] ${line}`);
  }

  private supported(employee: ModelEmployee): boolean {
    const mode = this.deps.session(employee.sessionId)?.mode ?? employee.mode;
    return !!mode && this.deps.takesModel(mode);
  }

  /** What the office knows about one employee's model. Read-only. */
  status(employee: ModelEmployee): EmployeeModelStatus {
    const entry = this.deps.store.get(employee.id);
    const session = this.deps.session(employee.sessionId);
    const live = session?.displayModel?.model;
    const supported = this.supported(employee);
    const fallbackActive = entry.fallback && this.now() < fallbackRestoreAt(entry.fallback);
    const target = fallbackActive ? entry.fallback!.to : (entry.preferred?.model ?? entry.fallback?.restore);
    const base: EmployeeModelStatus = {
      employeeId: employee.id,
      name: employee.name,
      supported,
      ...(entry.preferred ? { preferred: entry.preferred } : {}),
      ...(live ? { live } : {}),
      ...(target ? { target } : {}),
      ...(entry.fallback ? { fallback: { ...entry.fallback, restoreAt: fallbackRestoreAt(entry.fallback) } } : {}),
      state: 'none',
    };
    if (!supported)
      return { ...base, state: 'unsupported', reason: 'this employee’s CLI does not take a model this way' };
    if (!target) return base;
    if (modelMatchesDisplay(target, live)) return { ...base, state: 'applied' };
    const attempt = this.attempts.get(employee.id);
    if (attempt?.state === 'failed' && attempt.model === target)
      return {
        ...base,
        state: 'failed',
        reason: `/model ${target} was typed ${attempt.tries} times without the CLI confirming it`,
      };
    const wait = this.waits.get(employee.id);
    return {
      ...base,
      state: 'pending',
      ...(wait ? { reason: wait } : !live ? { reason: 'the CLI has not reported its model yet' } : {}),
    };
  }

  /**
   * Record a model (and optionally an effort) for an employee and try to apply it now. A choice
   * replaces any fallback in force: the person choosing has the last word. The route has already
   * decided the caller may.
   */
  async choose(
    employee: ModelEmployee,
    choice: { model: string; effort?: ModelEffort },
    by: string,
    waitMs = MODEL_CONFIRM_MS
  ): Promise<EmployeeModelStatus> {
    if (!this.supported(employee))
      throw new EmployeeModelError(
        'This employee’s CLI does not take a model this way; only Claude employees can be switched.',
        400
      );
    const preferred: EmployeeModelPreference = {
      model: choice.model,
      ...(choice.effort ? { effort: choice.effort } : {}),
      setAt: this.now(),
      by,
    };
    await this.deps.store.set(employee.id, { preferred });
    this.attempts.delete(employee.id);
    this.effortSent.delete(employee.id);
    this.nudgeDue.delete(employee.id);
    this.nudges.delete(employee.id);
    this.log(`${employee.name}: ${by} chose ${choice.model}${choice.effort ? ` (effort ${choice.effort})` : ''}`);
    await this.reconcile(employee, waitMs);
    return this.status(employee);
  }

  /** One look at every employee; overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const employees = this.deps.employees().filter((e) => !e.onVacation && e.desiredRunning !== false);
      await Promise.all(
        employees.map((employee) =>
          this.reconcile(employee).catch((error) => this.log(`${employee.name}: ${message(error)}`))
        )
      );
    } finally {
      this.ticking = false;
    }
  }

  /** Bring one employee one step closer to its target model. Single-flight per employee. */
  async reconcile(employee: ModelEmployee, waitMs = MODEL_CONFIRM_MS): Promise<void> {
    if (this.busy.has(employee.id)) return;
    const session = this.deps.session(employee.sessionId);
    if (!session || !this.deps.takesModel(session.mode)) return;
    this.busy.add(employee.id);
    try {
      await this.step(employee, session, waitMs);
    } finally {
      this.busy.delete(employee.id);
    }
  }

  private async step(employee: ModelEmployee, session: ModelSession, waitMs: number): Promise<void> {
    const entry = this.deps.store.get(employee.id);
    if (
      this.nudges.has(employee.id) &&
      entry.fallback &&
      modelMatchesDisplay(entry.fallback.to, session.displayModel?.model)
    )
      return this.sendNudge(employee, session, entry.fallback);
    const fallbackModel = this.deps.fallbackModel(employee.owner);
    // A limit leaves the session idle, or parked on its menu or footer (an open dialog to the office).
    const look =
      (fallbackModel !== null || !!entry.fallback) &&
      session.pid !== null &&
      (!session.isWorking || !!session.paneDialog);
    const screen = look ? await session.readScreenAsync() : null;
    const plan = planEmployeeModel({
      preferred: entry.preferred?.model,
      fallback: entry.fallback,
      fallbackModel,
      display: session.displayModel?.model,
      limit: readModelLimit(screen, this.now()),
      now: this.now(),
    });
    switch (plan.kind) {
      case 'fallback':
        return this.fallBack(employee, session, entry, plan.record, plan.escape, waitMs);
      case 'switch': {
        const outcome = await this.switchTo(employee, session, plan.model, plan.reason, waitMs);
        if (outcome === 'applied' && plan.reason === 'fallback')
          await this.afterFallback(employee, session, this.deps.store.get(employee.id).fallback);
        if (outcome === 'applied' && plan.reason === 'restore') await this.clearFallback(employee, true);
        return;
      }
      case 'clear-fallback':
        return this.clearFallback(employee, plan.restored);
      case 'none':
        if (plan.reason === 'nothing-to-do') return this.applyEffort(employee, session, entry);
    }
  }

  /** Why nothing may be typed into this session now, or undefined when it may. Reads the screen. */
  private refusal(session: ModelSession): keyof typeof REFUSAL_TEXT | undefined {
    if (session.pid === null) return 'not-running';
    if (session.providerDispatchHeld || session.terminalInputHeld) return 'held';
    if (session.isWorking) return 'working';
    if (session.startupScreen()) return 'startup';
    return paneRefusesCommand(session.readScreen(), this.deps.glyph(session.mode)) ?? undefined;
  }

  /** Type one slash command if the pane allows it; false (with the reason kept) when it did not. */
  private async typeCommand(employee: ModelEmployee, session: ModelSession, command: string): Promise<boolean> {
    const refused = this.refusal(session);
    if (refused) {
      this.waits.set(employee.id, REFUSAL_TEXT[refused]);
      return false;
    }
    const sent = await session.writeViaMux(`${command}\r`, { requireIdle: true, requireEmptyComposer: true });
    if (!sent) {
      this.waits.set(employee.id, REFUSAL_TEXT['write-refused']);
      return false;
    }
    this.waits.delete(employee.id);
    return true;
  }

  private async switchTo(
    employee: ModelEmployee,
    session: ModelSession,
    model: string,
    why: string,
    waitMs: number
  ): Promise<'applied' | 'pending' | 'failed'> {
    const key = `${session.id}:${session.pid}:${model}`;
    const previous = this.attempts.get(employee.id);
    const same = previous?.key === key;
    if (same && previous.state === 'failed') return 'failed';
    if (same && previous.state === 'typed' && this.now() - previous.at < MODEL_CONFIRM_MS) {
      return (await this.confirmed(session, model, 0)) ? this.markApplied(employee, previous) : 'pending';
    }
    if (!(await this.typeCommand(employee, session, `/model ${model}`))) return 'pending';
    const attempt: Attempt = { key, model, at: this.now(), tries: (same ? previous.tries : 0) + 1, state: 'typed' };
    this.attempts.set(employee.id, attempt);
    this.log(`${employee.name}: typed /model ${model} (${why}, try ${attempt.tries})`);
    if (await this.confirmed(session, model, waitMs)) return this.markApplied(employee, attempt);
    if (attempt.tries >= MODEL_MAX_TRIES) {
      attempt.state = 'failed';
      this.log(
        `${employee.name}: /model ${model} was not confirmed after ${attempt.tries} tries; leaving it until the choice or the session changes`
      );
      return 'failed';
    }
    return 'pending';
  }

  private markApplied(employee: ModelEmployee, attempt: Attempt): 'applied' {
    attempt.state = 'applied';
    this.log(`${employee.name}: now on ${attempt.model}`);
    return 'applied';
  }

  /** Watch for the CLI to report the model, or to answer `Set model to …` naming it. */
  private async confirmed(session: ModelSession, model: string, waitMs: number): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = this.now() + waitMs;
    for (;;) {
      if (modelMatchesDisplay(model, session.displayModel?.model)) return true;
      if (modelMatchesDisplay(model, readModelConfirmation(await session.readScreenAsync()))) return true;
      if (this.now() >= deadline) return false;
      await sleep(1000);
    }
  }

  private async applyEffort(employee: ModelEmployee, session: ModelSession, entry: EmployeeModelEntry): Promise<void> {
    const effort = entry.preferred?.effort;
    if (!effort || entry.fallback) return;
    const key = `${session.id}:${session.pid}:${effort}`;
    if (this.effortSent.get(employee.id) === key) return;
    if (!(await this.typeCommand(employee, session, `/effort ${effort}`))) return;
    this.effortSent.set(employee.id, key);
    this.log(`${employee.name}: typed /effort ${effort}`);
  }

  private async fallBack(
    employee: ModelEmployee,
    session: ModelSession,
    entry: EmployeeModelEntry,
    record: ModelFallbackRecord,
    escape: boolean,
    waitMs: number
  ): Promise<void> {
    if (escape) {
      // Escape only: it closes the menu or cancels the auto-continue footer. Never a digit or Enter.
      for (let i = 0; i < MAX_ESCAPES && limitPromptSurface(await session.readScreenAsync()); i++) {
        await session.writeViaMux('\x1b');
        this.log(`${employee.name}: pressed Escape on the ${record.family} limit prompt`);
        await (this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
          ESCAPE_SETTLE_MS
        );
      }
      session.refreshPaneDialog?.();
      if (limitPromptSurface(await session.readScreenAsync())) {
        this.waits.set(employee.id, REFUSAL_TEXT['limit-prompt']);
        this.log(`${employee.name}: the ${record.family} limit prompt is still showing; trying again later`);
        return;
      }
    }
    // Recorded before anything is typed, so a restart in between still restores.
    await this.deps.store.set(employee.id, { ...entry, fallback: record });
    this.nudgeDue.add(employee.id);
    this.log(
      `${employee.name}: ${record.from ?? record.family} reached its usage limit; switching to ${record.to} until ${this.resetText(employee, record) ?? 'an unknown reset time'}`
    );
    const outcome = await this.switchTo(employee, session, record.to, 'fallback', waitMs);
    if (outcome === 'applied') await this.afterFallback(employee, session, record);
  }

  /** Once the fallback model is confirmed: one office-room line, then the nudge that resumes the turn. */
  private async afterFallback(
    employee: ModelEmployee,
    session: ModelSession,
    record: ModelFallbackRecord | undefined
  ): Promise<void> {
    if (!record || !this.nudgeDue.delete(employee.id)) return;
    const reset = this.resetText(employee, record);
    try {
      this.deps.post?.(
        employee.owner,
        `${employee.name}: ${record.from ?? record.family} reached its usage limit, switched to ${record.to}${reset ? ` until ${reset}` : ''}.`
      );
    } catch {
      /* the log line is the record */
    }
    this.nudges.set(employee.id, this.now());
    await this.sendNudge(employee, session, record);
  }

  /** The resume nudge, typed only like any command; a refused one is tried again at later ticks, for a while. */
  private async sendNudge(employee: ModelEmployee, session: ModelSession, record: ModelFallbackRecord): Promise<void> {
    const since = this.nudges.get(employee.id);
    if (since === undefined) return;
    if (this.now() - since > NUDGE_WINDOW_MS) {
      this.nudges.delete(employee.id);
      this.log(
        `${employee.name}: gave up on the resume nudge; ${this.waits.get(employee.id) ?? 'the pane never allowed it'}`
      );
      return;
    }
    if (
      !(await this.typeCommand(
        employee,
        session,
        fallbackNudge(record.to, record.family, this.resetText(employee, record))
      ))
    )
      return;
    this.nudges.delete(employee.id);
    this.log(`${employee.name}: sent the resume nudge`);
  }

  private async clearFallback(employee: ModelEmployee, restored: boolean): Promise<void> {
    const entry = this.deps.store.get(employee.id);
    if (!entry.fallback) return;
    await this.deps.store.set(employee.id, { ...(entry.preferred ? { preferred: entry.preferred } : {}) });
    this.nudgeDue.delete(employee.id);
    this.nudges.delete(employee.id);
    this.log(
      restored
        ? `${employee.name}: the ${entry.fallback.family} limit has reset; back on ${entry.fallback.restore}`
        : `${employee.name}: the ${entry.fallback.family} limit has reset; nothing to restore, staying on ${entry.fallback.to}`
    );
  }

  private resetText(employee: ModelEmployee, record: ModelFallbackRecord): string | undefined {
    if (record.resetAt === null) return undefined;
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: this.deps.timeZone(employee.owner),
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(record.resetAt);
    } catch {
      return new Date(record.resetAt).toISOString();
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
