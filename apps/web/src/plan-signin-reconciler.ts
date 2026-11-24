/**
 * @fileoverview Keeps every copy of one plan sign-in current (the driver).
 *
 * For each Claude plan that a running laptop uses, it reads what the office's copy and each laptop's copy say
 * (never their tokens), asks the pure decision (`plan-signin-sync.ts`) which copy should replace which, and moves
 * exactly those bytes through the holders' own ports. A copy travels from one holder to another inside this
 * process only; a log line names holders, a reason and the first characters of a digest.
 *
 * Bounds it keeps itself:
 * - one pass at a time; a request for one plan waits for the pass that is running;
 * - a write replaces exactly the file that was read (the holder refuses when it changed in between);
 * - a copy that a client emptied its file over is remembered as refused and never placed again;
 * - it reads about once a minute, and every few seconds only around the moment a shared sign-in is renewed or
 *   while a copy is still being put right.
 */
import {
  planSignInSync,
  type SignInHolder,
  type SignInState,
  type SignInTransfer,
  type SignInView,
} from './plan-signin-sync.js';

/** `changed`: the file is no longer the one that was read. `busy`: its client is renewing right now. */
export type SignInWriteOutcome = 'written' | 'changed' | 'busy' | 'refused';

/** One place a plan's sign-in is kept, as the reconciler reaches it. */
export interface SignInHolderPort {
  readonly id: string;
  readonly office: boolean;
  /** Who it is, for the log: "the office" or an employee's name. */
  readonly label: string;
  /** What the copy says without its tokens. `undefined`: there is no such holder, or it cannot be read now. */
  observe(): Promise<SignInView | undefined>;
  /** The copy's bytes, only while it still has this digest. */
  read(digest: string): Promise<string | undefined>;
  /** Replace the copy that `expected` describes with `text`. */
  write(text: string, expected: SignInView): Promise<SignInWriteOutcome>;
}

export interface PlanSignInGroup {
  readonly accountId: string;
  readonly holders: readonly SignInHolderPort[];
}

export interface PlanSignInReconcilerPorts {
  now(): number;
  /** The office has restored its sessions and its laptop runtime is current. */
  ready(): boolean;
  /** Every plan with at least one laptop holder, and all of its holders. */
  plans(): Promise<readonly PlanSignInGroup[]>;
  log(line: string): void;
}

export interface PlanSignInLimits {
  /** How often every plan is read when nothing is happening. */
  readonly idleMs: number;
  /** How often while a shared sign-in is about to be renewed, or a copy was just replaced or could not be. */
  readonly fastMs: number;
  /** A client renews within five minutes of its access token's end. Reading speeds up this long before it. */
  readonly renewalLeadMs: number;
  readonly renewalTailMs: number;
}
export const PLAN_SIGN_IN_LIMITS: PlanSignInLimits = {
  idleMs: 60_000,
  fastMs: 5_000,
  renewalLeadMs: 7 * 60_000,
  renewalTailMs: 2 * 60_000,
};

export interface PlanSignInReport {
  readonly accountId: string;
  readonly checkedAt: number;
  /** Some holder has a sign-in that can be used. */
  readonly usable: boolean;
  /** Each holder as it stands after this pass. */
  readonly holders: readonly { readonly id: string; readonly state: SignInState }[];
  readonly transfers: readonly (SignInTransfer & { readonly outcome: SignInWriteOutcome | 'source-changed' })[];
}

/** The holder id of one employee's laptop within its plan. */
export function laptopSignInHolderId(employeeId: string): string {
  return 'laptop:' + employeeId;
}

const short = (digest: string | undefined) => (digest ? digest.slice(0, 12) : 'none');

export class PlanSignInReconciler {
  /** The usable copy each holder was last seen with (or given), by plan and holder. */
  readonly #held = new Map<string, string>();
  /** Digests of copies a client emptied its file over: the provider refused them. In memory only. */
  readonly #dead = new Set<string>();
  readonly #reports = new Map<string, PlanSignInReport>();
  readonly #said = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();
  #nextAt = 0;
  #closed = false;

  constructor(
    private readonly ports: PlanSignInReconcilerPorts,
    private readonly limits: PlanSignInLimits = PLAN_SIGN_IN_LIMITS
  ) {}

  close(): void {
    this.#closed = true;
  }

  /** The last pass over one plan. DATA only. */
  report(accountId: string): PlanSignInReport | undefined {
    return this.#reports.get(accountId);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Called often; does nothing until the next read is due. Never rejects. */
  tick(): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed || !this.ports.ready() || this.ports.now() < this.#nextAt) return;
      let fast = false;
      try {
        for (const group of await this.ports.plans()) {
          if (this.#closed) return;
          fast = (await this.#pass(group)).fast || fast;
        }
      } catch (error) {
        this.#say('*', 'failed', `[signin-sync] pass failed: ${describe(error)}`);
      }
      this.#nextAt = this.ports.now() + (fast ? this.limits.fastMs : this.limits.idleMs);
    });
  }

  /** Read and repair one plan now. `undefined`: the plan has no laptop holder, or the office is not ready. */
  reconcile(accountId: string): Promise<PlanSignInReport | undefined> {
    return this.#serial(async () => {
      if (this.#closed || !this.ports.ready()) return undefined;
      const group = (await this.ports.plans()).find((value) => value.accountId === accountId);
      if (!group) return undefined;
      const { report, fast } = await this.#pass(group);
      if (fast) this.#nextAt = Math.min(this.#nextAt, this.ports.now() + this.limits.fastMs);
      return report;
    });
  }

  /** One line per distinct state of one subject, so a standing condition is logged once. */
  #say(subject: string, key: string, line: string): void {
    if (this.#said.get(subject) === key) return;
    if (this.#said.size > 512) this.#said.clear();
    this.#said.set(subject, key);
    this.ports.log(line);
  }

  async #pass(group: PlanSignInGroup): Promise<{ report: PlanSignInReport; fast: boolean }> {
    const now = this.ports.now();
    const ports = new Map(group.holders.map((holder) => [holder.id, holder]));
    const seen = await Promise.all(
      group.holders.map(async (holder) => ({ holder, view: await holder.observe().catch(() => undefined) }))
    );
    const holders: SignInHolder[] = [];
    for (const { holder, view } of seen) {
      if (!view) continue;
      holders.push({ id: holder.id, office: holder.office, view });
      // A client empties its file only after the provider refused exactly the copy it held. So the usable copy
      // last seen there is refused, wherever else the same bytes still sit.
      const key = group.accountId + '\0' + holder.id,
        last = this.#held.get(key);
      if (view.state === 'usable') {
        if (this.#held.size > 1024) this.#held.clear();
        this.#held.set(key, view.digest!);
      } else if (last !== undefined) {
        this.#held.delete(key);
        if (view.state !== 'blank') continue;
        if (this.#dead.size > 256) this.#dead.clear();
        this.#dead.add(last);
        this.ports.log(
          `[signin-sync] ${group.accountId}: the sign-in ${holder.label} had (${short(last)}) was refused by the provider`
        );
      }
    }
    const plan = planSignInSync(holders, now, this.#dead);
    const views = new Map(holders.map((holder) => [holder.id, holder.view]));
    const texts = new Map<string, string | undefined>();
    const transfers: PlanSignInReport['transfers'][number][] = [];
    const after = new Map(holders.map((holder) => [holder.id, holder.view.state]));
    for (const transfer of plan.transfers) {
      const source = ports.get(transfer.from)!,
        target = ports.get(transfer.to)!,
        digest = views.get(transfer.from)!.digest!;
      if (!texts.has(transfer.from)) texts.set(transfer.from, await source.read(digest).catch(() => undefined));
      const text = texts.get(transfer.from);
      const outcome =
        text === undefined
          ? ('source-changed' as const)
          : await target.write(text, views.get(transfer.to)!).catch(() => 'refused' as const);
      transfers.push({ ...transfer, outcome });
      const subject = group.accountId + '\0' + transfer.to;
      if (outcome === 'written') {
        after.set(transfer.to, 'usable');
        this.#held.set(subject, digest);
        this.#said.delete(subject);
        this.ports.log(
          `[signin-sync] ${group.accountId}: ${target.label} now has the sign-in ${source.label} holds ` +
            `(${transfer.reason === 'stranded' ? 'it had none it could use' : 'it had an earlier copy'}; ${short(digest)})`
        );
      } else
        this.#say(
          subject,
          outcome,
          `[signin-sync] ${group.accountId}: the sign-in ${source.label} holds was not placed for ${target.label} yet (${outcome})`
        );
    }
    texts.clear();
    // Said when a plan has no usable copy left anywhere, and once more when it has one again.
    if (plan.usable && !this.#said.has(group.accountId)) this.#said.set(group.accountId, 'usable');
    this.#say(
      group.accountId,
      plan.usable ? 'usable' : 'none',
      plan.usable
        ? `[signin-sync] ${group.accountId}: a usable sign-in is held again`
        : `[signin-sync] ${group.accountId}: no holder has a usable sign-in. Sign the plan in at the office (Plans).`
    );
    const report: PlanSignInReport = {
      accountId: group.accountId,
      checkedAt: now,
      usable: plan.usable,
      holders: [...after].map(([id, state]) => ({ id, state })),
      transfers,
    };
    if (this.#reports.size > 256) this.#reports.clear();
    this.#reports.set(group.accountId, report);
    const renewing =
      plan.sharedExpiresAt !== undefined &&
      plan.sharedExpiresAt - now <= this.limits.renewalLeadMs &&
      now - plan.sharedExpiresAt <= this.limits.renewalTailMs;
    // A write that was refused outright is not tried again every few seconds.
    return { report, fast: renewing || transfers.some((transfer) => transfer.outcome !== 'refused') };
  }
}

/** The type of a failure and its code when it has one. Never its message. */
function describe(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown failure';
  const value = error as { name?: unknown; code?: unknown };
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/.test(value.code) ? value.code : undefined;
  const name = typeof value.name === 'string' && /^[A-Za-z]{1,40}$/.test(value.name) ? value.name : 'Error';
  return code ?? name;
}
