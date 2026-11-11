/** Shared process-local HTTP/WS input admission. Durable effect reconciliation remains separate. */
import { createHash, randomUUID } from 'node:crypto';
import type { Session } from '../session.js';
import type { SessionWriteOptions } from '../types.js';
import {
  inputAdmissionSubject,
  TerminalInputReceipts,
  TerminalInputUnconfirmedError,
} from '../terminal-input-outcome.js';
import { SseEvent } from './sse-events.js';
import { isPlainPromptInput } from './route-helpers.js';

export interface TerminalInputIntent {
  input: string;
  /** Trusted route's derived raw form, e.g. the existing agent shell-key guard. */
  rawInput?: string;
  clientId?: string;
  seq?: number;
  useMux?: boolean;
  ifIdle?: boolean;
  agentInput?: boolean;
}
interface InputReportPort {
  sessions: ReadonlyMap<string, Session>;
  persistSessionStateNow(session: Session): void;
  getSessionStateWithRespawn(session: Session): unknown;
  broadcast(event: string, data: unknown): void;
}
export type TerminalInputDisposition = 'confirmed' | 'refused' | 'held' | 'unconfirmed' | 'typed-unsent';
export interface TerminalInputOperation {
  readonly admitted: () => boolean;
  readonly useMux: boolean;
  readonly held: boolean;
  readonly pending: boolean;
  readonly notIssued: boolean;
  dispatch(report: InputReportPort): TerminalInputDisposition | Promise<TerminalInputDisposition>;
  writeRaw(options?: SessionWriteOptions): boolean;
  writeMux(options?: SessionWriteOptions): Promise<boolean>;
  /** Existing RemoteWake byte-buffer acceptance; not native provider-delivery evidence. */
  acceptBuffered(report: InputReportPort): boolean;
  refuse(): void;
  unconfirmed(
    cause: unknown,
    report: InputReportPort
  ): { error: TerminalInputUnconfirmedError; persistenceUnconfirmed: boolean };
}
export type TerminalInputAdmission =
  | { state: 'held' | 'capacity' | 'typed-unsent' | 'duplicate' | 'pending' }
  | { state: 'admitted'; operation: TerminalInputOperation };
type Phase =
  | 'reserved'
  | 'mux-in-flight'
  | 'mux-refused'
  | 'raw-in-flight'
  | 'raw-refused'
  | 'confirmed'
  | 'typed-unsent'
  | 'unconfirmed'
  | 'released'
  | 'buffered'
  | 'held';

/** Exact original intent encoding shared by dispatch and non-effecting receipt inspection. */
export function terminalInputFingerprint(intent: TerminalInputIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        input: intent.input,
        rawInput: intent.rawInput ?? intent.input,
        useMux: intent.useMux === undefined ? 'default' : intent.useMux ? 'mux' : 'raw',
        ifIdle: intent.ifIdle === true,
        agentInput: intent.agentInput === true,
      })
    )
    .digest('hex');
}
export type TerminalInputReceiptState = 'pending' | 'confirmed' | 'typed-unsent' | 'held' | 'unknown';

export class TerminalInputService {
  readonly #receipts: TerminalInputReceipts;
  constructor(receipts = new TerminalInputReceipts()) {
    this.#receipts = receipts;
  }
  /** Lookup only. Missing evidence never authorizes replay, including after a restart or eviction. */
  inspect(
    session: Session,
    tag: { clientId: string; seq: number; fingerprint: string },
    current: () => boolean
  ): TerminalInputReceiptState {
    if (!current() || session.terminalInputHeld || session.providerDispatchHeld) return 'held';
    const admission = session.captureInputAdmission(current);
    if (!admission()) return 'held';
    const state = this.#receipts.lookup(
      session.owner,
      session.id,
      JSON.stringify([tag.clientId, tag.seq]),
      inputAdmissionSubject(admission),
      tag.fingerprint
    );
    return state === undefined ? 'unknown' : state === 'unconfirmed' ? 'held' : state;
  }
  begin(
    session: Session,
    intent: TerminalInputIntent,
    current: () => boolean,
    capacityAvailable: () => boolean = () => true,
    subjectCurrent: () => boolean = current
  ): TerminalInputAdmission {
    const original = session.captureInputAdmission(current);
    const identity = session.captureInputAdmission(subjectCurrent);
    const subject = inputAdmissionSubject(original),
      owner = session.owner,
      sid = session.id;
    if (!current() || session.terminalInputHeld || session.providerDispatchHeld) return { state: 'held' };
    const { clientId, seq, input, useMux } = intent;
    const rawInput = intent.rawInput ?? input;
    const selectedMux = useMux ?? isPlainPromptInput(input);
    const tagged = typeof clientId === 'string' && typeof seq === 'number';
    const key = tagged ? JSON.stringify([clientId, seq]) : randomUUID();
    const fingerprint = terminalInputFingerprint(intent);
    const known = this.#receipts.lookup(owner, sid, key, subject, fingerprint);
    if (known === 'confirmed') return { state: 'duplicate' };
    if (known === 'typed-unsent') return { state: 'typed-unsent' };
    if (known === 'pending') return { state: 'pending' };
    if (known !== undefined || (tagged && session.inputSeqSpent(clientId!, seq!))) return { state: 'held' };
    if (!capacityAvailable()) return { state: 'capacity' };
    const receipt = this.#receipts.reserve(owner, sid, key, subject, fingerprint);
    if (!receipt) return { state: 'capacity' };

    let phase: Phase = 'reserved',
      claimed = false,
      uncertainty: TerminalInputUnconfirmedError | undefined;
    const eligible = () => session.id === sid && original();
    const stable = () => session.id === sid && identity();
    const admitted = () =>
      (phase === 'mux-in-flight' || phase === 'raw-in-flight' || phase === 'confirmed') && stable();
    const claim = () => {
      if (!claimed && tagged) {
        // The private reservation was fresh before queuing. Another distinct tag
        // may advance the watermark; never regress it or spend queued tags early.
        session.shouldApplyInput(clientId!, seq!);
        claimed = true;
      }
    };
    const start = (kind: 'mux' | 'raw') => {
      if (!(phase === 'reserved' || (kind === 'raw' && phase === 'mux-refused')) || !eligible()) return false;
      claim();
      phase = kind === 'mux' ? 'mux-in-flight' : 'raw-in-flight';
      return true;
    };
    const uncertain = (cause: unknown) => {
      phase = 'unconfirmed';
      receipt.record('unconfirmed');
      if (!uncertainty) {
        try {
          uncertainty = session.holdUnconfirmedInput(cause);
        } catch {
          // Session latches before notifying viewers; notification failure cannot
          // erase the physical outcome or authorize another dispatch.
          uncertainty =
            cause instanceof TerminalInputUnconfirmedError ? cause : new TerminalInputUnconfirmedError(cause);
        }
      }
      return uncertainty;
    };
    const settle = (kind: 'mux' | 'raw', delivered: boolean, typedUnsent = false) => {
      if (phase === 'unconfirmed') throw uncertainty!;
      if (phase !== `${kind}-in-flight`) throw uncertain(new Error('Original input dispatch ownership changed'));
      if (typedUnsent) {
        phase = 'typed-unsent';
        receipt.record('typed-unsent');
        return false;
      }
      if (!delivered) {
        phase = kind === 'mux' ? 'mux-refused' : 'raw-refused';
        return false;
      }
      if (!stable()) throw uncertain(new Error('Original input subject changed after dispatch'));
      phase = 'confirmed';
      receipt.record('confirmed');
      return true;
    };
    const operation: TerminalInputOperation = {
      admitted,
      useMux: selectedMux,
      get held() {
        return phase === 'held';
      },
      get pending() {
        return phase === 'reserved' || phase === 'mux-in-flight' || phase === 'raw-in-flight';
      },
      get notIssued() {
        return phase === 'released';
      },
      writeRaw: (options = {}) => {
        if (!start('raw')) return false;
        try {
          return settle(
            'raw',
            session.write(rawInput, {
              ...options,
              admitted: () => admitted() && (!options.admitted || options.admitted()),
            })
          );
        } catch (cause) {
          throw uncertain(cause);
        }
      },
      writeMux: async (options = {}) => {
        if (!start('mux')) return false;
        let typedUnsent = false;
        try {
          const delivered = await session.writeViaMux(input, {
            ...options,
            admitted: () => admitted() && (!options.admitted || options.admitted()),
            onTypedUnsent: () => {
              typedUnsent = true;
              options.onTypedUnsent?.();
            },
          });
          return settle('mux', delivered, typedUnsent);
        } catch (cause) {
          throw uncertain(cause);
        }
      },
      dispatch: (report) => {
        if (phase === 'confirmed' && stable()) return 'confirmed';
        if (phase !== 'reserved') return 'held';
        const complete = (delivered: boolean): TerminalInputDisposition => {
          if (delivered) return 'confirmed';
          if (phase === 'typed-unsent') return 'typed-unsent';
          operation.refuse();
          return phase === 'held' ? 'held' : 'refused';
        };
        const failed = (cause: unknown): TerminalInputDisposition => {
          operation.unconfirmed(cause, report);
          return 'unconfirmed';
        };
        try {
          if (selectedMux) return operation.writeMux({ fromUser: true }).then(complete).catch(failed);
          return complete(operation.writeRaw({ fromUser: true }));
        } catch (cause) {
          return failed(cause);
        }
      },
      acceptBuffered: (report) => {
        if (phase !== 'reserved') return false;
        if (!stable()) {
          operation.unconfirmed(new Error('Original buffered input subject changed'), report);
          return false;
        }
        claim();
        phase = 'buffered';
        receipt.record('confirmed');
        return true;
      },
      refuse: () => {
        if (phase !== 'reserved' && phase !== 'mux-refused' && phase !== 'raw-refused') return;
        if (session.id !== sid || !identity()) {
          phase = 'held';
          return;
        }
        phase = 'released';
        if (receipt.release() && claimed && tagged) session.forgetInputSeq(clientId!, seq!);
      },
      unconfirmed: (cause, report) => {
        const error = uncertain(cause);
        let persistenceUnconfirmed = false;
        if (report.sessions.get(sid) === session && session.id === sid && session.owner === owner) {
          try {
            report.persistSessionStateNow(session);
          } catch {
            persistenceUnconfirmed = true;
          }
          try {
            report.broadcast(SseEvent.SessionUpdated, { session: report.getSessionStateWithRespawn(session) });
          } catch {
            /* response still reports unknown */
          }
          try {
            report.broadcast(SseEvent.SessionError, { id: sid, error: error.message });
          } catch {
            /* response still reports unknown */
          }
        }
        return { error, persistenceUnconfirmed };
      },
    };
    return { state: 'admitted', operation: Object.freeze(operation) };
  }
}
