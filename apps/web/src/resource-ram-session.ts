/** Actual RAM-purpose normal Session launch. Native Q remains the sole owner
 * of STARTING, allocation and terminal effects; no parsed result grants them. */
import { Session } from './session.js';
import { ResourceWorkerLaunch } from './resource-worker-launch.js';
import { RamResourceSessionReadiness } from './resource-readiness.js';
import { PublishedRamResourceSession } from './resource-session-publication.js';
import {
  assertRamResourceOperation,
  RamResourceOwnerBinding,
  type RamResourceOwnerContext,
  type RamResourceSessionIntent,
} from './resource-owner-authority.js';

function need(value: unknown): asserts value {
  if (!value) throw new Error('Approved RAM Session launch is unavailable or changed');
}
export class RamResourceSessionLaunchTask {
  readonly #publication: PublishedRamResourceSession;
  readonly #session: Session;
  readonly #launch: ResourceWorkerLaunch;
  readonly #binding: RamResourceOwnerBinding;
  readonly #intent: RamResourceSessionIntent;
  readonly #reference: string;
  readonly #readiness: RamResourceSessionReadiness;
  #attempted = false;
  #started?: Promise<void>;
  constructor(
    publication: PublishedRamResourceSession,
    session: Session,
    launch: ResourceWorkerLaunch,
    binding: RamResourceOwnerBinding,
    intent: RamResourceSessionIntent,
    reference: string,
    readiness: RamResourceSessionReadiness
  ) {
    need(
      publication instanceof PublishedRamResourceSession &&
        session instanceof Session &&
        launch instanceof ResourceWorkerLaunch &&
        readiness instanceof RamResourceSessionReadiness &&
        session.id === intent.approval.targetSid &&
        session.owner === intent.owner &&
        !session.pid &&
        !session.muxName
    );
    PublishedRamResourceSession.prototype.assertLaunchInputs.call(
      publication,
      binding,
      intent,
      session,
      launch,
      reference
    );
    launch.assertRamOperation(binding, intent);
    this.#publication = publication;
    this.#session = session;
    this.#launch = launch;
    this.#binding = binding;
    this.#intent = intent;
    this.#reference = reference;
    this.#readiness = readiness;
    Object.freeze(this);
  }
  begin(reference: string): void {
    need(!this.#attempted && reference === this.#reference);
    this.#attempted = true;
    PublishedRamResourceSession.prototype.assertLaunchInputs.call(
      this.#publication,
      this.#binding,
      this.#intent,
      this.#session,
      this.#launch,
      reference
    );
    assertRamResourceOperation(this.#binding, this.#intent.owner, this.#intent);
    this.#launch.arm(reference);
    this.#started = this.#session.startInteractive().then(async () => {
      assertRamResourceOperation(this.#binding, this.#intent.owner, this.#intent);
      await this.#readiness.waitUntilReady();
    });
    // Observe the original promise immediately; wait preserves its rejection.
    void this.#started.catch(() => undefined);
  }
  async wait(): Promise<void> {
    need(this.#started);
    await this.#started;
  }
  /** The transport must retain this exact actual owner capture and native
   * routing name; a task for another approved operation is not interchangeable. */
  assertContext(context: RamResourceOwnerContext, reference: string): void {
    need(reference === this.#reference);
    RamResourceOwnerBinding.prototype.assertContext.call(this.#binding, context);
    // The constructor/begin perform the unstarted publication check. This
    // pairing also runs while the actual Session start is in flight.
    assertRamResourceOperation(this.#binding, this.#intent.owner, this.#intent);
  }
  assertCommand(digest: string, sessionId: string, cwd: string): void {
    need(this.#attempted);
    assertRamResourceOperation(this.#binding, this.#intent.owner, this.#intent);
    this.#launch.assertCommand(digest, sessionId, cwd);
  }
}
