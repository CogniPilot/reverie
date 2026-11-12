import {expect, it} from 'vitest';
import {LaunchReservation} from '../src/web/launch-reservation.js';

it('expires only known pending reservations and releases deterministic failures', () => {
  const owner = new LaunchReservation(100);
  expect(owner.blocks(99)).toBe(true); expect(owner.blocks(100)).toBe(false);
  expect(owner.release()).toBe(true); expect(owner.blocks(1)).toBe(false);
  owner.retainUnconfirmed(); expect(owner.blocks(1)).toBe(false);
});
it('keeps unknown effects held through expiry and finally-release', () => {
  const owner = new LaunchReservation(100);
  owner.retainUnconfirmed(); expect(owner.release()).toBe(false);
  expect(owner.blocks(Number.MAX_SAFE_INTEGER)).toBe(true);
});
it('a stale operation never removes or replaces a newer claim', () => {
  const old = new LaunchReservation(100), next = new LaunchReservation(200);
  const claims = new Map([['subject', next]]);
  old.retainUnconfirmed(); expect(old.owns(claims, 'subject')).toBe(false);
  expect(next.owns(claims, 'subject')).toBe(true); old.removeOwned(claims, 'subject');
  expect(claims.get('subject')).toBe(next); expect(next.blocks(199)).toBe(true);
  expect(next.release()).toBe(true); next.removeOwned(claims, 'subject'); expect(claims.size).toBe(0);
});

it('a dispatched operation never expires and known settlement still releases its own claim', () => {
  const owner = new LaunchReservation(100);
  expect(owner.beginDispatch()).toBe(true); expect(owner.beginDispatch()).toBe(false);
  expect(owner.blocks(Number.MAX_SAFE_INTEGER)).toBe(true);
  expect(owner.release()).toBe(true); expect(owner.blocks(1)).toBe(false);
});
