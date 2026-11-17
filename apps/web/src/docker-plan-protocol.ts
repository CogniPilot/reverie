/** Build-paired fixed-role compatibility is earned before stopping a source.
 * A version string, image label or refusal prefix alone grants nothing. */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { inspectWorkerClientFiles, WORKER_CLIENT_PREFIX, WORKER_CLIENT_ENTRY } from './worker-client-manifest.js';
import { DockerPlanInitialReceipt } from './docker-plan-install-data.js';
import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
import { PlanMoveError } from './plan-move.js';
const fields = Object.keys(DockerPlanInitialReceipt.shape).sort();
export function parseDockerPlanProtocol(text: string): void {
  try {
    if (Buffer.byteLength(text) > 8192) throw Error();
    const value = z
      .object({
        version: z.literal(1),
        purpose: z.literal('reverie-plan-protocol-v1'),
        protocol: z.literal(1),
        receiptFields: z.array(z.string()).length(19),
      })
      .strict()
      .parse(parseBoxedConfigurationJson(text));
    if (new Set(value.receiptFields).size !== 19 || !isDeepStrictEqual([...value.receiptFields].sort(), fields))
      throw Error();
  } catch {
    throw new PlanMoveError('The packaged native plan protocol is unavailable', 503);
  }
}
export function requireDockerPlanProtocol(manifestDigest: string, current: () => void): void {
  current();
  try {
    const before = inspectWorkerClientFiles(WORKER_CLIENT_PREFIX, manifestDigest);
    if (before.ownerUid !== 0) throw Error();
    current();
    const bytes = execFileSync(
      WORKER_CLIENT_ENTRY,
      ['worker-client', 'plan-protocol', '--expected-digest', manifestDigest],
      { env: { PATH: '/bin', HOME: '/home/agent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, timeout: 3000, maxBuffer: 8192 }
    );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parseDockerPlanProtocol(text);
    const after = inspectWorkerClientFiles(WORKER_CLIENT_PREFIX, manifestDigest);
    if (!isDeepStrictEqual(before, after)) throw Error();
  } catch {
    current();
    throw new PlanMoveError('The current protected worker/client pairing cannot install plan generations', 503);
  }
  current();
}
