/** RAM-v2 client. The native service owns validation, policy and effects.
 * Opening this transport neither registers an endpoint nor enables rollout.
 */
import { ResourceNativeClient } from './resource-native-client.js';
import { z } from 'zod';
import type { RamResourceSessionLaunchTask } from './resource-ram-session.js';
import type { RamNativePublicationData } from './resource-session-publication.js';
import {
  ResourceOwnerAuthority,
  type RamResourceOwnerContext,
  type RamResourcePreviewContext,
} from './resource-owner-authority.js';

const UUID = z
  .string()
  .uuid()
  .refine((value) => value.toLowerCase() === value && value !== '00000000-0000-0000-0000-000000000000');
const Claimed = z
  .object({
    reference: UUID,
    sessionId: UUID,
    state: z.literal('PREPARING'),
    publicationIntentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Step = 'draft' | 'claim' | 'publication' | 'prepare' | 'source-stop' | 'start' | 'exhausted' | 'failed';
function need(value: unknown): asserts value {
  if (!value) throw new Error('RAM operation continuation is unavailable or changed; inspect its retained outcome');
}

export class RamResourceNativeClient {
  readonly #client: ResourceNativeClient;
  readonly #context: RamResourceOwnerContext | RamResourcePreviewContext;
  #step: Step;
  #reference?: string;
  private constructor(client: ResourceNativeClient, context: RamResourceOwnerContext | RamResourcePreviewContext) {
    this.#client = client;
    this.#context = context;
    this.#step = context.stage === 'preview' ? 'draft' : 'claim';
  }
  static async open(
    path: string,
    authority: ResourceOwnerAuthority,
    context: RamResourceOwnerContext | RamResourcePreviewContext
  ): Promise<RamResourceNativeClient> {
    return new RamResourceNativeClient(await ResourceNativeClient.openRam(path, authority, context), context);
  }
  async draft(idempotencyKey: string, memoryMiB: number): Promise<unknown> {
    need(this.#context.stage === 'preview' && this.#step === 'draft');
    this.#step = 'exhausted';
    return this.#client.request('draft', { employeeId: this.#context.employeeId, idempotencyKey, memoryMiB });
  }
  async claim(): Promise<Readonly<RamNativePublicationData>> {
    need(this.#context.stage === 'apply' && this.#step === 'claim');
    this.#step = 'failed';
    try {
      const selected = Claimed.parse(await this.#client.request('claim', { approval: this.#context.approval }));
      const approved = this.#context.approval;
      need(
        selected.sessionId === approved.targetSid &&
          ![
            approved.employeeId,
            approved.draftId,
            approved.operationId,
            approved.reservationId,
            approved.targetSid,
          ].includes(selected.reference)
      );
      this.#reference = selected.reference;
      this.#step = 'publication';
      return Object.freeze(selected);
    } catch (error) {
      this.#client.close();
      throw error;
    }
  }
  publication(): Promise<unknown> {
    return this.#continue('publication', 'prepare');
  }
  prepare(): Promise<unknown> {
    return this.#continue('prepare', 'source-stop');
  }
  sourceStop(): Promise<unknown> {
    return this.#continue('source-stop', 'start');
  }
  start(launch: RamResourceSessionLaunchTask): Promise<unknown> {
    return this.#continue('start', 'exhausted', launch);
  }
  async #continue(
    verb: 'publication' | 'prepare' | 'source-stop' | 'start',
    next: Step,
    launch?: RamResourceSessionLaunchTask
  ): Promise<unknown> {
    need(this.#context.stage === 'apply' && this.#step === verb && this.#reference);
    // Latch before dispatch. A timeout/refusal never enables replay on this
    // original channel. Parsed values below are response DATA, not permits.
    this.#step = 'failed';
    try {
      const value = await this.#client.request(verb, { reference: this.#reference }, launch);
      this.#step = next;
      return value;
    } catch (error) {
      this.#client.close();
      throw error;
    }
  }
  close(): void {
    this.#step = 'failed';
    this.#client.close();
  }
}
