import { expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  browserProducerSchema,
  observeBrowserProducer,
  sameBrowserProducer,
} from './helpers/browser-coverage-producer.js';
import { SYNTHETIC_BROWSER_PRODUCER } from './helpers/browser-coverage-fixtures.js';

function page(
  response: unknown = SYNTHETIC_BROWSER_PRODUCER.chromium,
  version = SYNTHETIC_BROWSER_PRODUCER.browserVersion
) {
  const session = { send: vi.fn(async () => response), detach: vi.fn(async () => {}) };
  const browser = { version: () => version };
  const context = { browser: () => browser, newCDPSession: vi.fn(async () => session) };
  const target = { context: () => context } as unknown as Page;
  return { target, session, context };
}
it('records actual CDP runtime and installed Playwright versions without user-agent data', async () => {
  const { target, session, context } = page({ ...SYNTHETIC_BROWSER_PRODUCER.chromium, userAgent: 'not retained' });
  const producer = await observeBrowserProducer(target);
  expect(context.newCDPSession).toHaveBeenCalledWith(target);
  expect(session.send).toHaveBeenCalledExactlyOnceWith('Browser.getVersion');
  expect(session.detach).toHaveBeenCalledOnce();
  expect(producer.chromium).toEqual(SYNTHETIC_BROWSER_PRODUCER.chromium);
  expect(producer.playwright.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(producer.playwright.version).toBe(producer.playwright.coreVersion);
  expect(producer.node).toBe(process.version);
  expect(JSON.stringify(producer)).not.toContain('not retained');
});
it.each([
  {},
  { ...SYNTHETIC_BROWSER_PRODUCER.chromium, product: 'Firefox/123.0.0.1' },
  { ...SYNTHETIC_BROWSER_PRODUCER.chromium, protocolVersion: '' },
])('refuses invalid runtime metadata and detaches its exact session: %j', async (response) => {
  const { target, session } = page(response);
  await expect(observeBrowserProducer(target)).rejects.toThrow();
  expect(session.detach).toHaveBeenCalledOnce();
});
it('refuses CDP/browser disagreement and preserves query failure', async () => {
  const mismatch = page(undefined, '124.0.0.1');
  await expect(observeBrowserProducer(mismatch.target)).rejects.toThrow('differs from the connected browser');
  const failed = page(),
    cause = new Error('synthetic CDP failure');
  failed.session.send.mockRejectedValueOnce(cause);
  await expect(observeBrowserProducer(failed.target)).rejects.toBe(cause);
  expect(failed.session.detach).toHaveBeenCalledOnce();
});
it('rejects missing producer fields and distinguishes changed runtime identities', () => {
  expect(() => browserProducerSchema.parse({})).toThrow();
  expect(sameBrowserProducer(SYNTHETIC_BROWSER_PRODUCER, structuredClone(SYNTHETIC_BROWSER_PRODUCER))).toBe(true);
  for (const change of [
    { node: 'v23.0.0' },
    { chromium: { ...SYNTHETIC_BROWSER_PRODUCER.chromium, jsVersion: 'changed' } },
  ])
    expect(sameBrowserProducer(SYNTHETIC_BROWSER_PRODUCER, { ...SYNTHETIC_BROWSER_PRODUCER, ...change })).toBe(false);
});

it('refuses cleanup failure and preserves both query and cleanup causes', async () => {
  const { target, session } = page(),
    cleanup = new Error('synthetic detach failure');
  session.detach.mockRejectedValue(cleanup);
  await expect(observeBrowserProducer(target)).rejects.toBe(cleanup);
  const query = new Error('synthetic query failure');
  session.send.mockRejectedValue(query);
  await expect(observeBrowserProducer(target)).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [query, cleanup],
  });
});
