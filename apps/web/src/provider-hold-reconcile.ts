/**
 * @fileoverview Reconciling the "provider launch outcome is unconfirmed" input hold (pure).
 *
 * A Session carries a launch denial whenever the office cannot prove what a provider
 * dispatch did: a dispatch that failed part-way in this process, or a saved launch
 * intent loaded by a new office process (so every session after an office replacement).
 * That denial fences two different things:
 *
 * - a NEW provider launch (restart, mode switch, prompt run), which stays fenced here;
 * - INPUT to the pane, because without a provider there the text would be typed into
 *   whatever else owns the pane.
 *
 * Only the second is reconciled by this module, and only from what the office can read
 * of the session's own pane: the pane is live under the pid the office registered for it,
 * and its screen shows that CLI's working line or composer mark (the same registry data
 * the worker-viewer reconnect and the readiness waits use). A pane that exited settles
 * the question the other way when the pane's command IS the provider; for a viewer of a
 * laptop or remote provider it settles nothing. Anything else stays held, and the
 * verified owner can settle it by saying what the terminal shows.
 *
 * Nothing here retires a launch intent or admits a launch.
 */

import { ApiErrorCode } from './types/api.js';
import type { PaneLiveness } from './signal-target.js';

/** What the caller says about the provider: nothing (`auto`), or the owner's own reading of the terminal. */
export type ProviderHoldClaim = 'auto' | 'running' | 'not-running';
export const PROVIDER_HOLD_CLAIMS: readonly ProviderHoldClaim[] = ['auto', 'running', 'not-running'];

/** Where a presence confirmation came from. */
export type ProviderPresenceSource = 'screen' | 'owner';

/** Why an observation could not settle the hold. */
export type ProviderHoldHeldReason =
  /** The session has no pane the office can read (stopped, closing, direct PTY, or never attached). */
  | 'no-terminal'
  /** A start, attach or restart of this pane is running; its screen is not evidence yet. */
  | 'lifecycle-in-progress'
  /** The pane could not be read, or more or fewer than one pane answered for it. */
  | 'pane-unreadable'
  /** The pane is not the one the office registered, or it changed while it was being read. */
  | 'pane-changed'
  /** The pane exited, but it only views a provider running elsewhere (a laptop or a remote host). */
  | 'viewer-pane-exited'
  /** The pane is live but its screen shows neither this CLI's working line nor its composer mark. */
  | 'provider-not-visible';

export type ProviderScreenEvidence = 'working-line' | 'composer' | 'none';

export interface ProviderHoldEvidence {
  /** Pane liveness read before and after the screen capture. */
  readonly before: PaneLiveness;
  readonly after: PaneLiveness;
  /** The pane pid the office registered for this session. */
  readonly registeredPid: number | undefined;
  readonly screen: ProviderScreenEvidence;
  /** True when the pane's own command is the provider (a local pane), false for a viewer. */
  readonly paneIsProvider: boolean;
}

export type ProviderHoldDecision =
  | {
      readonly outcome: 'confirmed';
      readonly source: ProviderPresenceSource;
      readonly evidence: 'working-line' | 'composer' | 'owner-attested';
    }
  | { readonly outcome: 'not-running'; readonly evidence: 'pane-exited' | 'owner-attested' }
  | { readonly outcome: 'held'; readonly reason: ProviderHoldHeldReason };

/**
 * What a pane capture says about the provider. A working line counts only for a CLI that
 * declares one, and a composer only by the CLI's `composerReadyMark` (never the prompt
 * glyph alone, which other screens and shells also draw).
 */
export function providerScreenEvidence(
  text: string | null | undefined,
  cli: { readonly composerReadyMark?: string; readonly workingLine?: RegExp | null }
): ProviderScreenEvidence {
  if (!text) return 'none';
  if (cli.workingLine) {
    cli.workingLine.lastIndex = 0;
    if (cli.workingLine.test(text)) return 'working-line';
  }
  return cli.composerReadyMark && text.includes(cli.composerReadyMark) ? 'composer' : 'none';
}

/** The reconciliation rule. Pure: the caller reads the pane and applies the result. */
export function decideProviderHold(claim: ProviderHoldClaim, evidence: ProviderHoldEvidence): ProviderHoldDecision {
  // Withdrawing input is always safe, so the owner's "not running" needs no corroboration.
  if (claim === 'not-running') return { outcome: 'not-running', evidence: 'owner-attested' };
  const { before, after } = evidence;
  if (before.state === 'dead' || after.state === 'dead')
    return evidence.paneIsProvider
      ? { outcome: 'not-running', evidence: 'pane-exited' }
      : { outcome: 'held', reason: 'viewer-pane-exited' };
  if (before.state !== 'live' || after.state !== 'live') return { outcome: 'held', reason: 'pane-unreadable' };
  const pid = evidence.registeredPid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || before.pid !== pid || after.pid !== pid)
    return { outcome: 'held', reason: 'pane-changed' };
  // The owner's reading replaces the screen match only. The pane must still be this session's live pane.
  if (claim === 'running') return { outcome: 'confirmed', source: 'owner', evidence: 'owner-attested' };
  if (evidence.screen === 'none') return { outcome: 'held', reason: 'provider-not-visible' };
  return { outcome: 'confirmed', source: 'screen', evidence: evidence.screen };
}

/** What a reconciliation did to one session. */
export type ProviderHoldReconciliation =
  /** No launch denial is recorded for this session. */
  | { readonly outcome: 'not-held' }
  /** Input flows to the existing provider. `engine-view` is the boxed runtime's own current proof. */
  | {
      readonly outcome: 'confirmed';
      readonly source: ProviderPresenceSource | 'engine-view';
      readonly evidence: 'working-line' | 'composer' | 'owner-attested' | 'engine-view';
    }
  /** The provider is not running in this pane. Input stays held; the launch fence is unchanged. */
  | { readonly outcome: 'not-running'; readonly evidence: 'pane-exited' | 'owner-attested' }
  | { readonly outcome: 'held'; readonly reason: ProviderHoldHeldReason };

export const PROVIDER_INPUT_HELD_CODE = 'PROVIDER_INPUT_HELD';
export const PROVIDER_NOT_RUNNING_CODE = 'PROVIDER_NOT_RUNNING';
export const providerHoldPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/provider-hold`;

const HELD_TEXT: Record<ProviderHoldHeldReason, string> = {
  'no-terminal': 'this session has no terminal pane the office can read',
  'lifecycle-in-progress': 'a start or restart of this terminal is still running',
  'pane-unreadable': 'the terminal pane could not be read',
  'pane-changed': 'the terminal pane changed while it was being checked',
  'viewer-pane-exited': 'the terminal viewer exited, which says nothing about the agent it was showing',
  'provider-not-visible': "the terminal does not show this agent's composer or working line",
};

/**
 * The refusal an input caller gets while the hold stands. It names the supported way
 * out instead of a dead end: `code` and `allowedActions` are for a managing agent,
 * `error` for a person.
 */
export function providerInputHeldBody(sessionId: string, last?: ProviderHoldReconciliation) {
  const notRunning = last?.outcome === 'not-running';
  const why =
    last?.outcome === 'held' ? ` The office checked the terminal and could not tell: ${HELD_TEXT[last.reason]}.` : '';
  const error = notRunning
    ? 'The agent is not running in this terminal, so input is held and nothing was typed. Do not replay it. Restart or recover the employee; if the agent is in fact running, the verified owner can say so with the action below.'
    : `Provider launch outcome is unconfirmed. Input is held and nothing was typed. Do not replay it.${why} The office re-checks the terminal by itself and releases the hold once it shows the running agent. If it cannot tell, the verified owner settles it: look at the terminal, then confirm the agent is running (or report that it is not) with the action below.`;
  return {
    success: false as const,
    error,
    errorCode: ApiErrorCode.CONFLICT,
    recoveryRequired: true as const,
    code: notRunning ? PROVIDER_NOT_RUNNING_CODE : PROVIDER_INPUT_HELD_CODE,
    ...(last?.outcome === 'held' ? { reason: last.reason } : {}),
    allowedActions: ['confirm-provider-running', 'report-provider-not-running', 'recheck-terminal'] as const,
    reconcile: {
      method: 'POST' as const,
      path: providerHoldPath(sessionId),
      requires: 'verified-owner' as const,
      body: {
        'confirm-provider-running': { observation: 'running' },
        'report-provider-not-running': { observation: 'not-running' },
        'recheck-terminal': { observation: 'auto' },
      },
    },
  };
}
