/** A failed terminal RPC can follow an issued key. No caller may replay it as a refusal. */
export class TerminalInputUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super('Terminal input outcome is unconfirmed. Do not replay this input. Further input is held until the original effect is reconciled.', {cause});
    this.name = 'TerminalInputUnconfirmedError';
  }
}
/** One original sendInput owner, shared across its text/paste/Escape/Enter RPCs. */
export class TerminalInputAttempt {
  #state: {phase: 'unissued' | 'issued' | 'settled'} | {phase: 'unconfirmed'; error: TerminalInputUnconfirmedError} = {phase: 'unissued'};
  continuing(): boolean {return this.#state.phase === 'unissued' || this.#state.phase === 'issued';}
  beforeEffect(): void {
    if (this.#state.phase === 'unconfirmed') throw this.#state.error;
    if (this.#state.phase === 'settled') throw new Error('Terminal input attempt was already settled');
    this.#state = {phase: 'issued'};
  }
  fail(cause: unknown): TerminalInputUnconfirmedError | undefined {
    if (this.#state.phase === 'unconfirmed') return this.#state.error;
    if (this.#state.phase !== 'issued') return undefined;
    const error = cause instanceof TerminalInputUnconfirmedError ? cause : new TerminalInputUnconfirmedError(cause);
    this.#state = {phase: 'unconfirmed', error};
    return error;
  }
  finish(accepted: boolean, admitted: boolean): boolean {
    if (this.#state.phase === 'unconfirmed') throw this.#state.error;
    if (this.#state.phase === 'issued' && (!accepted || !admitted))
      throw this.fail(new Error('Original terminal input authority or dispatch outcome changed'))!;
    if (this.#state.phase === 'settled') throw new Error('Terminal input attempt was already settled');
    this.#state = {phase: 'settled'};
    return accepted;
  }
}

// Process-local capabilities: no SID, DTO, timestamp or restored JSON can mint a subject.
const inputSubjects = new WeakMap<() => boolean, object>();
export function issueInputAdmission(subject: object, current: () => boolean): () => boolean {
  inputSubjects.set(current, subject);
  return current;
}
export function inputAdmissionSubject(admission: () => boolean): object {
  const subject = inputSubjects.get(admission);
  if (!subject) throw new Error('Missing original input subject');
  return subject;
}
type InputReceiptState = 'pending' | 'confirmed' | 'unconfirmed' | 'typed-unsent';
type InputReceipt = {owner: string | undefined; sid: string; key: string; subject: object; fingerprint: string; state: InputReceiptState};
/** Bounded, process-local replay barrier. Unknown attempts are never evicted or transferred. */
export class TerminalInputReceipts {
  #entries = new Set<InputReceipt>();
  constructor(private readonly perOwner = 256, private readonly total = 4096) {
    if (!Number.isSafeInteger(perOwner) || !Number.isSafeInteger(total) || perOwner < 1 || total < 1)
      throw new Error('Invalid input receipt capacity');
  }
  lookup(owner: string | undefined, sid: string, key: string, subject: object, fingerprint: string): InputReceiptState | 'held' | undefined {
    const matched = [...this.#entries].find(entry => entry.sid === sid && entry.key === key);
    if (matched && matched.fingerprint !== fingerprint) return 'held';
    if (matched?.state === 'confirmed' && matched.owner === owner && matched.subject === subject) return 'confirmed';
    for (const entry of this.#entries) {
      if (entry.sid !== sid) continue;
      // Only a negative fact crosses an object/owner boundary. No predecessor delivery proof does.
      if (entry.state === 'unconfirmed' || (entry.state === 'pending' && entry.subject !== subject)) return 'held';
    }
    for (const entry of this.#entries) {
      if (entry.sid === sid && entry.key === key) {
        if (entry.owner !== owner || entry.subject !== subject) return 'held';
        return entry.state;
      }
    }
    return undefined;
  }
  reserve(owner: string | undefined, sid: string, key: string, subject: object, fingerprint: string): {
    record: (state: InputReceiptState) => void; release: () => boolean;
  } | undefined {
    if (this.lookup(owner, sid, key, subject, fingerprint) !== undefined) return undefined;
    const ownerCount = () => [...this.#entries].filter(entry => entry.owner === owner).length;
    while (this.#entries.size >= this.total || ownerCount() >= this.perOwner) {
      const fullOwner = ownerCount() >= this.perOwner;
      const disposable = [...this.#entries].find(entry => entry.state === 'confirmed' && (!fullOwner || entry.owner === owner));
      if (!disposable) return undefined;
      this.#entries.delete(disposable);
    }
    const entry: InputReceipt = {owner, sid, key, subject, fingerprint, state: 'pending'};
    this.#entries.add(entry);
    return {
      record: state => {
        if (!this.#entries.has(entry) || state === 'pending' || entry.state === 'unconfirmed' || entry.state === 'typed-unsent') return;
        if (entry.state === 'confirmed' && state !== 'unconfirmed') return;
        entry.state = state;
      },
      release: () => entry.state === 'pending' && this.#entries.delete(entry),
    };
  }
}
