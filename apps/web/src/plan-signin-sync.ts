/**
 * @fileoverview One plan sign-in held in several places: the decision (pure).
 *
 * A Claude plan sign-in is an access token that lasts about eight hours and a refresh token that is replaced each
 * time it is used. The office keeps one copy of a plan's sign-in, and a laptop gets its own copy of the same bytes
 * (a seat folder at a rebuild, a generation folder at a plan move). Each copy is then renewed by a different
 * client. Whichever client renews first holds the only live refresh token; every other copy of that sign-in is
 * refused at its own renewal and its client empties the file (`accessToken: ""`, `refreshToken: ""`,
 * `expiresAt: 0`). That is how an employee ends up at a sign-in screen for a plan the system still holds.
 *
 * This module reads a copy down to what can be compared without the tokens, and decides which copy should replace
 * which. It performs no effect and reads no clock.
 *
 * The rules:
 * - A copy that cannot be used (emptied, missing, unreadable, or past its refresh deadline) never replaces
 *   anything. It RECEIVES the newest usable copy of the plan.
 * - Copies of the SAME sign-in converge on the newest of them, so a copy whose refresh token another holder
 *   already replaced is renewed before its own client tries and is refused.
 * - A usable copy of a DIFFERENT sign-in is left alone, however long ago its access token ended. Two separate
 *   sign-ins of one plan never collide, and overwriting one would only create a second holder of the other. A
 *   client that sits idle renews nothing until its next request, so an old access token says nothing about
 *   whether the copy still works; a copy that does not is emptied by its client and then receives one.
 * - The office's copy is never created here: an office that is signed out of a plan stays signed out.
 * - A copy that was placed and then emptied by its client is dead and is never placed again.
 */
import { createHash } from 'node:crypto';

/**
 * - `absent`: there is no sign-in file.
 * - `invalid`: the file is not the provider's JSON object.
 * - `signed-out`: the file holds no Claude subscription sign-in at all.
 * - `blank`: the sign-in is there with its tokens emptied, which is what a client writes after a refused renewal.
 * - `usable`: both tokens are present.
 */
export type SignInState = 'absent' | 'invalid' | 'signed-out' | 'blank' | 'usable';

/** What one copy says without its tokens. A digest identifies bytes; it is not token material. */
export interface SignInView {
  readonly state: SignInState;
  /** SHA-256 of the file's bytes. Absent only when there is no file. */
  readonly digest?: string;
  /** When the access token ends (ms). Present for a usable copy. */
  readonly expiresAt?: number;
  /** When the refresh token ends (ms), when the client recorded it. It stays the same across renewals of one
   * sign-in, give or take the seconds between the provider's answer and the client's clock. */
  readonly refreshExpiresAt?: number;
}

/** Larger than any real sign-in file; the readers refuse more. */
export const SIGN_IN_FILE_LIMIT = 128 * 1024;

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Reduce a sign-in file's text to its view. Total: any input has exactly one state. */
export function signInView(text: string | undefined): SignInView {
  if (text === undefined) return { state: 'absent' };
  const digest = createHash('sha256').update(text).digest('hex');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'invalid', digest };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid', digest };
  const login = (value as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (!login || typeof login !== 'object' || Array.isArray(login)) return { state: 'signed-out', digest };
  const { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt } = login as Record<string, unknown>;
  const refreshExpiresAt = time(refreshTokenExpiresAt);
  const expires = time(expiresAt);
  const tokens =
    typeof accessToken === 'string' && accessToken !== '' && typeof refreshToken === 'string' && refreshToken !== '';
  return tokens && expires !== undefined
    ? { state: 'usable', digest, expiresAt: expires, ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }) }
    : { state: 'blank', digest, ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }) };
}

/** One place a plan's sign-in is kept. */
export interface SignInHolder {
  readonly id: string;
  /** The office's own copy. Every other holder is a laptop's. */
  readonly office: boolean;
  readonly view: SignInView;
}

export interface SignInTransfer {
  readonly from: string;
  readonly to: string;
  /** `stranded`: the receiver holds nothing it can use. `older-copy`: it holds an earlier copy of the same sign-in. */
  readonly reason: 'stranded' | 'older-copy';
}

export interface SignInSyncPlan {
  readonly transfers: readonly SignInTransfer[];
  /** Some holder has a sign-in that can be used. False means only a person can sign the plan in. */
  readonly usable: boolean;
  /** The earliest access-token expiry among copies of a sign-in that more than one holder has: the moment their
   * clients start renewing against each other. Absent when no sign-in is shared. */
  readonly sharedExpiresAt?: number;
}

/** Two recorded refresh deadlines this close are one sign-in. Separate sign-ins were measured hours apart. */
export const SAME_SIGN_IN_TOLERANCE_MS = 2 * 60_000;

function live(holder: SignInHolder, now: number, dead: ReadonlySet<string>): boolean {
  const { view } = holder;
  return (
    view.state === 'usable' &&
    !(view.refreshExpiresAt !== undefined && view.refreshExpiresAt <= now) &&
    !(view.digest !== undefined && dead.has(view.digest))
  );
}

/** Whether two usable copies are the same sign-in. Unknown on either side counts as the same, which is the plain
 * newest-copy-wins rule. */
function sameSignIn(a: SignInView, b: SignInView): boolean {
  if (a.refreshExpiresAt === undefined || b.refreshExpiresAt === undefined) return true;
  return Math.abs(a.refreshExpiresAt - b.refreshExpiresAt) <= SAME_SIGN_IN_TOLERANCE_MS;
}

/** Newest first; the office before a laptop on a tie; then by id, so the choice never depends on input order. */
function newer(a: SignInHolder, b: SignInHolder): number {
  return (
    (b.view.expiresAt ?? 0) - (a.view.expiresAt ?? 0) || Number(b.office) - Number(a.office) || a.id.localeCompare(b.id)
  );
}

/** The office's copy is only ever repaired, never created or signed back in. */
function receives(holder: SignInHolder, now: number): boolean {
  const { view } = holder;
  const lapsed = view.state === 'usable' && view.refreshExpiresAt !== undefined && view.refreshExpiresAt <= now;
  if (holder.office) return view.state === 'blank' || lapsed;
  return view.state !== 'usable' || lapsed;
}

/**
 * Which copy should replace which, for the holders of one plan.
 *
 * `dead` lists digests that were placed and then emptied by a client: the provider refused them.
 */
export function planSignInSync(
  holders: readonly SignInHolder[],
  now: number,
  dead: ReadonlySet<string> = new Set()
): SignInSyncPlan {
  const usable = holders.filter((holder) => live(holder, now, dead)).sort(newer);
  const best = usable[0];
  if (!best) return { transfers: [], usable: false };
  const transfers: SignInTransfer[] = [];
  let sharedExpiresAt: number | undefined;
  for (const holder of [...holders].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!live(holder, now, dead)) {
      // A copy the provider refused is unusable wherever it sits, the office included.
      const refused = holder.view.digest !== undefined && dead.has(holder.view.digest);
      if (refused || receives(holder, now)) transfers.push({ from: best.id, to: holder.id, reason: 'stranded' });
      continue;
    }
    const same = usable.filter((other) => sameSignIn(other.view, holder.view));
    if (same.length > 1)
      sharedExpiresAt = Math.min(sharedExpiresAt ?? Infinity, ...same.map((other) => other.view.expiresAt!));
    const newest = same[0]!;
    if (
      newest.id !== holder.id &&
      newest.view.digest !== holder.view.digest &&
      newest.view.expiresAt! > holder.view.expiresAt!
    )
      transfers.push({ from: newest.id, to: holder.id, reason: 'older-copy' });
  }
  return { transfers, usable: true, ...(sharedExpiresAt === undefined ? {} : { sharedExpiresAt }) };
}
