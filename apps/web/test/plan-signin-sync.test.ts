import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SAME_SIGN_IN_TOLERANCE_MS,
  planSignInSync,
  signInView,
  type SignInHolder,
  type SignInView,
} from '../src/plan-signin-sync.js';

const HOUR = 60 * 60_000;
const NOW = 1_800_000_000_000;
const GRANT_A = NOW + 20 * 24 * HOUR;
const GRANT_B = NOW + 25 * 24 * HOUR;

/** A synthetic sign-in file. `serial` only makes the bytes of two renewals differ. */
function file(expiresAt: number, refreshTokenExpiresAt: number | undefined, serial = 0): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'SYNTHETIC_ACCESS_' + serial,
      refreshToken: 'SYNTHETIC_REFRESH_' + serial,
      expiresAt,
      ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  });
}
/** What a client writes after the provider refused its renewal. */
function emptied(refreshTokenExpiresAt = GRANT_A): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt, scopes: [] },
  });
}
const holder = (id: string, text: string | undefined): SignInHolder => ({
  id,
  office: id === 'office',
  view: signInView(text),
});
const moves = (holders: SignInHolder[], dead?: Set<string>) =>
  planSignInSync(holders, NOW, dead).transfers.map((t) => `${t.from}>${t.to}:${t.reason}`);

describe('signInView', () => {
  it('reads a usable sign-in down to two times and a digest, and carries no token', () => {
    const text = file(NOW + 8 * HOUR, GRANT_A);
    const view = signInView(text);
    expect(view).toEqual({
      state: 'usable',
      digest: createHash('sha256').update(text).digest('hex'),
      expiresAt: NOW + 8 * HOUR,
      refreshExpiresAt: GRANT_A,
    });
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC');
  });
  it('names every other file by what is wrong with it', () => {
    const states = (text: string | undefined) => signInView(text).state;
    expect(states(undefined)).toBe('absent');
    expect(states('not json')).toBe('invalid');
    expect(states('[]')).toBe('invalid');
    expect(states('{}')).toBe('signed-out');
    expect(states(JSON.stringify({ claudeAiOauth: null }))).toBe('signed-out');
    expect(states(emptied())).toBe('blank');
    // Tokens without an expiry, or an expiry without both tokens, are not a sign-in a client can use.
    expect(states(JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }))).toBe('blank');
    expect(states(JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: '', expiresAt: NOW } }))).toBe(
      'blank'
    );
    expect(signInView(emptied()).refreshExpiresAt).toBe(GRANT_A);
    expect(signInView(undefined).digest).toBeUndefined();
  });
});

describe('planSignInSync', () => {
  it('does nothing when every copy is the same bytes', () => {
    const text = file(NOW + 4 * HOUR, GRANT_A);
    const plan = planSignInSync([holder('office', text), holder('laptop:a', text), holder('laptop:b', text)], NOW);
    expect(plan.transfers).toEqual([]);
    expect(plan.usable).toBe(true);
    expect(plan.sharedExpiresAt).toBe(NOW + 4 * HOUR);
  });

  it('gives the newest copy of one sign-in to every older copy of it: office to laptops', () => {
    const old = file(NOW + 60_000, GRANT_A, 1),
      renewed = file(NOW + 8 * HOUR, GRANT_A + 1000, 2);
    expect(moves([holder('office', renewed), holder('laptop:a', old), holder('laptop:b', old)])).toEqual([
      'office>laptop:a:older-copy',
      'office>laptop:b:older-copy',
    ]);
  });

  it('gives the newest copy of one sign-in to every older copy of it: a laptop to the office and the others', () => {
    const old = file(NOW + 60_000, GRANT_A, 1),
      renewed = file(NOW + 8 * HOUR, GRANT_A + 1000, 2);
    expect(moves([holder('office', old), holder('laptop:a', renewed), holder('laptop:b', old)])).toEqual([
      'laptop:a>laptop:b:older-copy',
      'laptop:a>office:older-copy',
    ]);
  });

  it('never lets an emptied copy win, however it is ordered, and repairs it from the newest usable copy', () => {
    const renewed = file(NOW + 8 * HOUR, GRANT_A, 2);
    for (const holders of [
      [holder('laptop:a', emptied()), holder('laptop:b', renewed), holder('office', emptied())],
      [holder('office', emptied()), holder('laptop:b', renewed), holder('laptop:a', emptied())],
    ])
      expect(moves(holders)).toEqual(['laptop:b>laptop:a:stranded', 'laptop:b>office:stranded']);
  });

  it('is the morning of 2026-11-24: one laptop renewed, the other was refused, the office was refused too', () => {
    // Ada's client renewed first. Burt's and the office's copies of the same sign-in were emptied by their clients.
    const ada = file(NOW + 8 * HOUR, GRANT_A, 2);
    expect(moves([holder('office', emptied()), holder('laptop:ada', ada), holder('laptop:burt', emptied())])).toEqual([
      'laptop:ada>laptop:burt:stranded',
      'laptop:ada>office:stranded',
    ]);
  });

  it('leaves a usable copy of a different sign-in alone, even an older one', () => {
    const office = file(NOW + 8 * HOUR, GRANT_B, 1),
      own = file(NOW + 2 * HOUR, GRANT_A, 2);
    const plan = planSignInSync([holder('office', office), holder('laptop:rex', own)], NOW);
    expect(plan.transfers).toEqual([]);
    // Nothing is shared, so no two clients renew against each other.
    expect(plan.sharedExpiresAt).toBeUndefined();
  });

  it('treats refresh deadlines within the tolerance as one sign-in and beyond it as two', () => {
    const newest = file(NOW + 8 * HOUR, GRANT_A, 2);
    const near = file(NOW + HOUR, GRANT_A + SAME_SIGN_IN_TOLERANCE_MS, 1),
      far = file(NOW + HOUR, GRANT_A + SAME_SIGN_IN_TOLERANCE_MS + 1, 1);
    expect(moves([holder('office', newest), holder('laptop:a', near)])).toEqual(['office>laptop:a:older-copy']);
    expect(moves([holder('office', newest), holder('laptop:a', far)])).toEqual([]);
  });

  it('falls back to newest-wins when a copy does not record its refresh deadline', () => {
    const newest = file(NOW + 8 * HOUR, undefined, 2),
      old = file(NOW + HOUR, GRANT_A, 1);
    expect(moves([holder('office', old), holder('laptop:a', newest)])).toEqual(['laptop:a>office:older-copy']);
  });

  it('renews each sign-in from its own newest copy when a plan has two', () => {
    const a1 = file(NOW + HOUR, GRANT_A, 1),
      a2 = file(NOW + 8 * HOUR, GRANT_A, 2),
      b1 = file(NOW + 2 * HOUR, GRANT_B, 3),
      b2 = file(NOW + 7 * HOUR, GRANT_B, 4);
    expect(
      moves([holder('office', a1), holder('laptop:a', a2), holder('laptop:b', b1), holder('laptop:c', b2)])
    ).toEqual(['laptop:c>laptop:b:older-copy', 'laptop:a>office:older-copy']);
  });

  it('repairs a laptop with no file, an unreadable file or a signed-out file, but never creates the office copy', () => {
    const good = file(NOW + 8 * HOUR, GRANT_A);
    for (const text of [undefined, 'not json', '{}'])
      expect(moves([holder('laptop:a', good), holder('laptop:b', text)])).toEqual(['laptop:a>laptop:b:stranded']);
    for (const text of [undefined, 'not json', '{}']) expect(moves([holder('laptop:a', good), holder('office', text)])).toEqual([]);
  });

  it('counts a sign-in past its refresh deadline as unusable: it receives and never gives', () => {
    const lapsed = file(NOW + 9 * HOUR, NOW - 1, 1),
      good = file(NOW + HOUR, GRANT_B, 2);
    expect(moves([holder('office', lapsed), holder('laptop:a', good)])).toEqual(['laptop:a>office:stranded']);
    expect(moves([holder('office', good), holder('laptop:a', lapsed)])).toEqual(['office>laptop:a:stranded']);
    expect(planSignInSync([holder('office', lapsed), holder('laptop:a', emptied())], NOW)).toEqual({
      transfers: [],
      usable: false,
    });
  });

  it('never places a copy the provider already refused, and replaces it wherever it still sits', () => {
    const refused = file(NOW + 8 * HOUR, GRANT_A, 1),
      good = file(NOW + 3 * HOUR, GRANT_B, 2);
    const dead = new Set([signInView(refused).digest!]);
    // Without the memory, the refused copy looks like the newest and would be placed again for ever.
    expect(moves([holder('office', refused), holder('laptop:a', emptied())])).toEqual(['office>laptop:a:stranded']);
    expect(moves([holder('office', refused), holder('laptop:a', emptied())], dead)).toEqual([]);
    expect(
      moves([holder('office', refused), holder('laptop:a', emptied()), holder('laptop:b', good)], dead)
    ).toEqual(['laptop:b>laptop:a:stranded', 'laptop:b>office:stranded']);
  });

  it('leaves a separate sign-in alone however long ago its access token ended', () => {
    // An idle client renews nothing until its next request: an old access token is not a dead sign-in.
    const working = file(NOW + 5 * HOUR, GRANT_B, 2),
      idle = file(NOW - 6 * HOUR, GRANT_A, 1);
    expect(moves([holder('office', working), holder('laptop:a', idle)])).toEqual([]);
    expect(moves([holder('office', idle), holder('laptop:a', working)])).toEqual([]);
    expect(moves([holder('office', file(NOW - HOUR, GRANT_B, 3)), holder('laptop:a', idle)])).toEqual([]);
  });

  it('prefers the office on a tie and does not depend on input order', () => {
    const one = file(NOW + 8 * HOUR, GRANT_A, 1),
      two = file(NOW + 8 * HOUR, GRANT_B, 2);
    const holders = [holder('laptop:b', emptied()), holder('laptop:a', two), holder('office', one)];
    expect(moves(holders)).toEqual(['office>laptop:b:stranded']);
    expect(moves([...holders].reverse())).toEqual(['office>laptop:b:stranded']);
  });

  it('reports no usable sign-in when nobody holds one', () => {
    expect(planSignInSync([holder('office', emptied()), holder('laptop:a', undefined)], NOW)).toEqual({
      transfers: [],
      usable: false,
    });
    expect(planSignInSync([], NOW)).toEqual({ transfers: [], usable: false });
  });

  it('names the moment a shared sign-in is renewed', () => {
    const shared = file(NOW + 3 * HOUR, GRANT_A, 1),
      own = file(NOW + HOUR, GRANT_B, 2);
    const view: SignInView = signInView(shared);
    expect(view.state).toBe('usable');
    expect(
      planSignInSync([holder('office', shared), holder('laptop:a', shared), holder('laptop:b', own)], NOW)
        .sharedExpiresAt
    ).toBe(NOW + 3 * HOUR);
  });
});
