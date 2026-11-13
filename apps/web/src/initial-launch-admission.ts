/** Deny-only continuation of one request's actual launch/environment semantics. */
import { getCli } from './config/cli-registry/registry.js';
import { sameLaunchProtocol } from './utils/resolved-stock-protocol.js';

export function captureLaunchProtocolAdmission(mode: string): () => boolean {
  const entry = getCli(mode);
  const original = entry && structuredClone(entry);
  let current = !!original?.enabled;
  return () => {
    const latest = getCli(mode);
    current &&=
      !!original &&
      !!latest?.enabled &&
      original.kind === latest.kind &&
      original.capabilities.startMode === latest.capabilities.startMode &&
      sameLaunchProtocol(original, latest);
    return current;
  };
}

const initial = new WeakMap<object, () => boolean>();
const bound = new WeakSet<object>();

/** Called only with the actual constructed object, before it is published. Not a wire grant. */
export function bindInitialLaunchAdmission(subject: { mode: string; owner?: string }, admitted: () => boolean): void {
  if (bound.has(subject)) throw new Error('Initial launch admission was already bound');
  if (!admitted()) throw new Error('Initial launch protocol changed before publication');
  const mode = subject.mode,
    owner = subject.owner;
  let current = true;
  bound.add(subject);
  initial.set(subject, () => (current &&= subject.mode === mode && subject.owner === owner && admitted()));
}

export function initialLaunchAdmitted(subject: object): boolean {
  return initial.get(subject)?.() ?? true;
}

/** Only the canonical successful provider-dispatch settlement may end this continuation. */
export function completeInitialLaunchAdmission(subject: object): boolean {
  if (!initialLaunchAdmitted(subject)) return false;
  initial.delete(subject);
  return true;
}
