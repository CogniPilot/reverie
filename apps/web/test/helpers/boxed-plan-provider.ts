/** External-model fixture protocol only. CLI replies/receipts are DATA, never native grants. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WORKER_CLIENT_ENTRY } from '../../src/worker-client-manifest.js';
import { PlanRequestId } from '../../src/plan-request-capability.js';

export const PlanProviderFixtureContract = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-plan-provider-v1'),
    employeeId: z.string().uuid(),
    accounts: z.tuple([PlanRequestId, PlanRequestId]),
    autoApprove: z.boolean(),
    exhausted: z.boolean(),
    refreshAccountId: PlanRequestId.nullable(),
    pauseBeforeApproval: z.boolean(),
    approvalAllowlistOnly: z.boolean().optional(),
    sdkForceEnabled: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (v) => v.accounts[0] !== v.accounts[1] && (v.refreshAccountId === null || v.accounts.includes(v.refreshAccountId))
  );
export type PlanProviderFixtureContract = z.infer<typeof PlanProviderFixtureContract>;
export interface FixtureCliReply {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}
export interface PlanProviderFixtureIdentity {
  sessionId: string;
  providerThread: string;
  namespacePid: number;
  hookGeneration: string;
}
export interface PlanProviderFixtureReport {
  version: 1;
  purpose: 'synthetic-plan-provider-turn-v1';
  turnId: string;
  employeeId: string;
  sessionId: string;
  providerThread: string;
  namespacePid: number;
  hookGenerationSha256: string;
  requestId: string | null;
  accountId: string | null;
  state: 'idle' | 'cooperation-disabled' | 'denied' | 'already-attempted' | 'approval-returned' | 'unknown';
  probes: { args: readonly string[]; exitCode: number | null; stdoutSha256: string; stderrSha256: string }[];
  limitation: 'External fake provider only; no native, permission, policy or paid-dispatch proof.';
}
export interface PlanProviderFixturePorts {
  /** CI image adapter executes ONLY the fixed capsule entry, never a shell. */
  cli(args: readonly string[], input?: string): Promise<FixtureCliReply>;
  /** Exclusive, private, checked durable intent+handoff BEFORE the CLI approval. Existing means no replay. */
  prepareApproval(requestId: string, handoff: string): Promise<'prepared' | 'existing'>;
  /** Fixed private generation only. Canonical account data must never be modified. */
  refreshAuthOnce(accountId: string): Promise<void>;
  beforeApproval(requestId: string): Promise<void>;
  allowApproval?(requestId: string): Promise<boolean>;
  /** Consuming file+directory closes must succeed before the completion stdout below. */
  record(report: Readonly<PlanProviderFixtureReport>): Promise<void>;
  output(text: string): void;
}
const uuid = z.string().uuid(),
  json = (value: string): unknown => JSON.parse(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const Pending = z
  .object({
    success: z.literal(true),
    requests: z
      .array(
        z
          .object({
            id: PlanRequestId,
            phase: z.string(),
            toAccount: PlanRequestId,
          })
          .passthrough()
      )
      .max(16),
  })
  .passthrough();
const Status = z
  .object({
    success: z.literal(true),
    id: PlanRequestId,
    employeeId: z.string().uuid(),
    sessionId: z.string().uuid(),
    fromAccount: PlanRequestId,
    toAccount: PlanRequestId,
    phase: z.string(),
  })
  .passthrough();
const Plans = z
  .array(
    z
      .object({ id: PlanRequestId, sessions: z.array(z.object({ id: z.string() }).passthrough()).max(256) })
      .passthrough()
  )
  .max(128);

/** A readable receipt alone cannot prove its writer consumed all closes. */
export function planFixtureTurnBarrier(
  report: Pick<PlanProviderFixtureReport, 'turnId' | 'sessionId' | 'requestId' | 'state'>
) {
  uuid.parse(report.turnId);
  uuid.parse(report.sessionId);
  if (report.requestId !== null) PlanRequestId.parse(report.requestId);
  z.enum(['idle', 'cooperation-disabled', 'denied', 'already-attempted', 'approval-returned', 'unknown']).parse(
    report.state
  );
  return (
    'BCPLAN_TURN_' +
    digest(report.turnId + '\0' + report.sessionId + '\0' + (report.requestId ?? '') + '\0' + report.state)
  );
}
/** Only the ordinary generated managed callbacks may be represented by this SDK fake. */
export function requirePlanFixtureHooks(value: unknown): void {
  const hook = (event: string) =>
    z.tuple([
      z
        .object({
          hooks: z.tuple([
            z
              .object({
                type: z.literal('command'),
                command: z.literal(WORKER_CLIENT_ENTRY + ' worker-callback hook-event --event ' + event),
              })
              .passthrough(),
          ]),
        })
        .passthrough(),
    ]);
  z.object({ hooks: z.object({ Stop: hook('stop'), UserPromptSubmit: hook('prompt_submitted') }).passthrough() })
    .passthrough()
    .parse(value);
}

export class BoxedPlanProviderFixture {
  #busy = false;
  constructor(
    readonly contract: PlanProviderFixtureContract,
    readonly identity: PlanProviderFixtureIdentity,
    readonly ports: PlanProviderFixturePorts,
    settings: unknown
  ) {
    requirePlanFixtureHooks(settings);
    PlanProviderFixtureContract.parse(contract);
    uuid.parse(identity.sessionId);
    uuid.parse(identity.providerThread);
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(identity.hookGeneration)) throw Error('Fixture hook generation refused');
    if (!Number.isSafeInteger(identity.namespacePid) || identity.namespacePid <= 1)
      throw Error('Fixture identity refused');
  }
  async #probe(report: PlanProviderFixtureReport, args: readonly string[], input?: string) {
    const reply = await this.ports.cli(args, input);
    if (Buffer.byteLength(reply.stdout) > 65536 || Buffer.byteLength(reply.stderr) > 65536)
      throw Error('Fixture CLI reply bound');
    report.probes.push({
      args,
      exitCode: reply.exitCode,
      stdoutSha256: digest(reply.stdout),
      stderrSha256: digest(reply.stderr),
    });
    if (reply.exitCode !== 0 || reply.signal !== null) throw Error('Fixture CLI result unconfirmed');
    return reply.stdout;
  }
  async #capability(report: PlanProviderFixtureReport) {
    const value = z
      .object({ identity: z.object({ kind: z.literal('agent'), sessionId: uuid }).passthrough() })
      .passthrough()
      .parse(json(await this.#probe(report, ['agent', 'capabilities', '--json'])));
    if (value.identity.sessionId !== this.identity.sessionId) throw Error('Fixture CLI identity differs');
  }
  async #identity(report: PlanProviderFixtureReport) {
    await this.#capability(report);
    const plans = Plans.parse(json(await this.#probe(report, ['plans', '--json'])));
    const own = plans.filter((p) => p.sessions.some((s) => s.id === this.identity.sessionId));
    if (own.length !== 1 || !this.contract.accounts.includes(own[0]!.id)) throw Error('Fixture own account differs');
    report.accountId = own[0]!.id;
    return own[0]!.id;
  }
  #report(): PlanProviderFixtureReport {
    return {
      version: 1,
      purpose: 'synthetic-plan-provider-turn-v1',
      turnId: randomUUID(),
      employeeId: this.contract.employeeId,
      sessionId: this.identity.sessionId,
      providerThread: this.identity.providerThread,
      namespacePid: this.identity.namespacePid,
      hookGenerationSha256: digest(this.identity.hookGeneration),
      requestId: null,
      accountId: null,
      state: 'idle',
      probes: [],
      limitation: 'External fake provider only; no native, permission, policy or paid-dispatch proof.',
    };
  }
  async #idle(report: PlanProviderFixtureReport) {
    const output = await this.#probe(
      report,
      ['worker-callback', 'hook-event', '--event', 'stop'],
      JSON.stringify({ session_id: this.identity.providerThread, source: 'synthetic-plan-provider' })
    );
    if (output !== '') throw Error('Fixture Stop output differs');
    await this.ports.record(report);
    const barrier = digest(this.identity.sessionId + '\0' + (report.requestId ?? '') + '\0' + report.state);
    const turnBarrier = planFixtureTurnBarrier(report);
    this.ports.output(`BCPLAN_${barrier}\n${turnBarrier}\n❯ `);
    return report;
  }
  async start() {
    const report = this.#report();
    await this.#capability(report);
    if (this.contract.exhausted) this.ports.output("You've hit your limit. Please try again later.\n");
    return this.#idle(report);
  }
  async turn() {
    if (this.#busy) return undefined;
    this.#busy = true;
    const report = this.#report();
    try {
      await this.#probe(
        report,
        ['worker-callback', 'hook-event', '--event', 'prompt_submitted'],
        JSON.stringify({ session_id: this.identity.providerThread, source: 'synthetic-plan-provider' })
      );
      const account = await this.#identity(report);
      if (this.contract.refreshAccountId === account) await this.ports.refreshAuthOnce(account);
      if (!this.contract.autoApprove || this.contract.exhausted) {
        report.state = 'cooperation-disabled';
        return await this.#idle(report);
      }
      let pending: z.infer<typeof Pending>;
      try {
        pending = Pending.parse(json(await this.#probe(report, ['agent', 'plan-move', 'list', '--json'])));
      } catch {
        report.state = 'denied';
        return await this.#idle(report);
      }
      if (!pending.requests.length) return await this.#idle(report);
      if (pending.requests.length !== 1) throw Error('Fixture pending request ambiguous');
      const selected = pending.requests[0]!;
      if (
        selected.phase !== 'pending' ||
        selected.toAccount === account ||
        !this.contract.accounts.includes(selected.toAccount)
      )
        throw Error('Fixture destination refused');
      const status = Status.parse(
        json(await this.#probe(report, ['agent', 'plan-move', 'status', selected.id, '--json']))
      );
      if (
        status.id !== selected.id ||
        status.employeeId !== this.contract.employeeId ||
        status.sessionId !== this.identity.sessionId ||
        status.fromAccount !== account ||
        status.toAccount !== selected.toAccount ||
        status.phase !== 'pending'
      )
        throw Error('Fixture exact request scope differs');
      report.requestId = status.id;
      if (this.contract.approvalAllowlistOnly && !(await this.ports.allowApproval?.(status.id))) {
        report.state = 'cooperation-disabled';
        return await this.#idle(report);
      }
      const handoff = `Synthetic plan fixture ${this.identity.sessionId}; request ${status.id}. No real work or paid credentials. Preserve original unknown outcomes; never replay them.`;
      if ((await this.ports.prepareApproval(status.id, handoff)) === 'existing') {
        report.state = 'already-attempted';
        return await this.#idle(report);
      }
      if (this.contract.pauseBeforeApproval) await this.ports.beforeApproval(status.id);
      try {
        const approval = z
          .object({ success: z.literal(true), phase: z.literal('executing') })
          .passthrough()
          .parse(
            json(
              await this.#probe(report, [
                'agent',
                'plan-move',
                'approve',
                status.id,
                '--handoff-file',
                `/home/agent/.fixture/plan-handoff-${status.id}.txt`,
                '--json',
              ])
            )
          );
        if (approval.phase === 'executing') report.state = 'approval-returned';
      } catch {
        report.state = 'unknown';
      }
      return await this.#idle(report);
    } finally {
      this.#busy = false;
    }
  }
}
