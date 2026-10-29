/** Deliver one crash-recovery instruction only after the agent composer is ready. */
import { getCli } from './config/cli-registry/registry.js';

export interface RecoveryPromptSession {
  readonly mode: string;
  readonly pid: number | null;
  readonly paneDialog: string | null;
  readonly isWorking: boolean;
  readonly terminalBuffer: string;
  writeViaMux(
    text: string,
    options: {
      opencodeGuard: boolean;
      requireEmptyComposer?: boolean;
      fromUser?: boolean;
      onOutcome(outcome: 'submitted' | 'stranded' | 'unverified'): void;
    }
  ): Promise<boolean>;
}

/** Color/OSC sequences may divide a visible marker across terminal writes. */
export function recoveryComposerReady(session: RecoveryPromptSession, mark: string): boolean {
  const text = session.terminalBuffer
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return !session.paneDialog && !session.isWorking && text.includes(mark);
}

export async function deliverRecoveryPrompt(
  session: RecoveryPromptSession,
  text: string,
  allowed: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  const mark = getCli(session.mode)?.capabilities.composerReadyMark;
  if (!mark) throw new Error('This agent has no safe composer readiness marker');
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!allowed() || session.pid === null) throw new Error('Recovery instruction canceled');
    if (recoveryComposerReady(session, mark)) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready || !allowed()) throw new Error('Recovery expert composer did not become ready');
  await submitRecoveryPrompt(session, text, allowed, sleep);
}

/** Submit once, allowing the CLI's guarded Enter retries to finish. */
export async function submitRecoveryPrompt(
  session: RecoveryPromptSession, text: string, allowed: () => boolean,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  options: {fromUser?: boolean} = {}
): Promise<void> {
  if (!allowed() || session.pid === null) throw new Error('Recovery instruction canceled');
  let outcome: 'submitted' | 'stranded' | 'unverified' | undefined;
  const sent = await session.writeViaMux(text.replace(/[\r\n]+/g, ' ') + '\r', {
    ...options,
    opencodeGuard: true,
    requireEmptyComposer: true,
    onOutcome: (value) => {
      outcome = value;
    },
  });
  if (!sent) throw new Error('Recovery instruction could not be typed');
  // The existing verifier retries Enter only while this exact prompt remains in the composer.
  // Never paste the body twice: an uncertain result requires owner inspection.
  for (let attempt = 0; attempt < 75 && outcome === undefined; attempt++) {
    if (!allowed()) throw new Error('Recovery instruction canceled');
    await sleep(1000);
  }
  if (outcome !== 'submitted') throw new Error('Recovery instruction submission was not confirmed');
}
