import {
  dockerResourceCapacityWitnesses,
  DockerResourceLedgerByteLimit,
  type DockerResourceAttempt,
  type DockerResourceDesiredRevision,
} from '../../src/docker-resource-revisions.js';
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Synthetic immutable historical DATA only; no native proof or application authority. */
export function resourceCapacityHistory(desired: DockerResourceDesiredRevision, freeBytes: number) {
  const target = DockerResourceLedgerByteLimit - freeBytes;
  const sample = dockerResourceCapacityWitnesses().find((value) => value.state === 'observed')!;
  const state = {
    version: 1 as const,
    purpose: 'reverie-docker-resource-revisions-v1' as const,
    desired: [desired],
    attempts: [] as DockerResourceAttempt[],
  };
  let index = 0;
  const make = (blank = false) => {
    const value = structuredClone(sample);
    value.revision = desired.revision;
    value.operationId = '50000000-0000-4000-8000-' + (++index).toString(16).padStart(12, '0');
    value.containerId = index.toString(16).padStart(64, '0');
    value.identity.worker.id = value.containerId;
    if (blank)
      for (const where of [value.identity.parent, value.identity.anchor, value.identity.worker]) where.path = '';
    return value;
  };
  while (true) {
    const full = make();
    if (byteSize({ ...state, attempts: [...state.attempts, full] }) > target) break;
    state.attempts.push(full);
  }
  const blank = make(true);
  if (byteSize({ ...state, attempts: [...state.attempts, blank] }) > target) {
    const previous = state.attempts.at(-1);
    if (previous?.state !== 'observed') throw Error('Immutable filler required');
    previous.identity.parent.path = '';
  }
  state.attempts.push(blank);
  let needed = target - byteSize(state);
  for (const where of [blank.identity.parent, blank.identity.anchor, blank.identity.worker]) {
    const nul = Math.min(4096, Math.floor(needed / 6));
    where.path = '\0'.repeat(nul);
    needed -= nul * 6;
    const ascii = Math.min(4096 - nul, needed);
    where.path += 'x'.repeat(ascii);
    needed -= ascii;
  }
  if (target - byteSize(state) >= 6) throw Error('Bounded capacity fixture padding failed');
  return state;
}
