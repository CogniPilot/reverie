/** RAM-v2 client. The native service owns validation, policy and effects.
 * Opening this transport neither registers an endpoint nor enables rollout.
 */
import { ResourceNativeClient } from './resource-native-client.js';
import {
  ResourceOwnerAuthority,
  type RamResourceOwnerContext,
  type RamResourcePreviewContext,
} from './resource-owner-authority.js';

export class RamResourceNativeClient {
  readonly #client: ResourceNativeClient;
  readonly #context: RamResourceOwnerContext | RamResourcePreviewContext;
  private constructor(client: ResourceNativeClient, context: RamResourceOwnerContext | RamResourcePreviewContext) {
    this.#client = client;
    this.#context = context;
  }
  static async open(
    path: string,
    authority: ResourceOwnerAuthority,
    context: RamResourceOwnerContext | RamResourcePreviewContext
  ): Promise<RamResourceNativeClient> {
    return new RamResourceNativeClient(await ResourceNativeClient.openRam(path, authority, context), context);
  }
  draft(idempotencyKey: string, memoryMiB: number): Promise<unknown> {
    if (this.#context.stage !== 'preview') return Promise.reject(new Error('RAM preview context required'));
    return this.#client.request('draft', { employeeId: this.#context.employeeId, idempotencyKey, memoryMiB });
  }
  claim(): Promise<unknown> {
    if (this.#context.stage !== 'apply') return Promise.reject(new Error('RAM apply context required'));
    return this.#client.request('claim', { approval: this.#context.approval });
  }
  close(): void {
    this.#client.close();
  }
}
