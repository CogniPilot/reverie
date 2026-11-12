/** Runtime identity is evidence provenance, never semantic qualification for a coverage floor. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Page } from 'playwright';

export const RAW_BROWSER_OBSERVATION_VERSION = 3;
export const BROWSER_PRODUCER_QUALIFICATION = 'runtime-recorded-not-semantically-qualified';
const version = z.string().regex(/^\d+(?:\.\d+){2,3}(?:[-+][a-zA-Z0-9.-]+)?$/);
const cdpVersion = z.object({
  product: z.string().regex(/^(?:HeadlessChrome|Chrome)\/\d+(?:\.\d+){3}$/),
  protocolVersion: z.string().regex(/^\d+\.\d+$/),
  revision: z.string().min(1).max(160),
  jsVersion: z.string().min(1).max(160),
});
export const browserProducerSchema = z
  .object({
    chromium: cdpVersion,
    browserVersion: version,
    playwright: z.object({ version, coreVersion: version }),
    node: z.string().regex(/^v\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  })
  .superRefine((value, context) => {
    if (value.chromium.product.split('/')[1] !== value.browserVersion)
      context.addIssue({ code: 'custom', message: 'CDP product differs from the connected browser version' });
    if (value.playwright.version !== value.playwright.coreVersion)
      context.addIssue({ code: 'custom', message: 'Playwright wrapper and actual core versions differ' });
  });
export type BrowserProducer = z.infer<typeof browserProducerSchema>;
const require = createRequire(import.meta.url);
const packageVersion = z.object({ version });
function actualPlaywrightVersions() {
  const wrapper = require.resolve('playwright/package.json');
  const core = createRequire(wrapper).resolve('playwright-core/package.json');
  return {
    version: packageVersion.parse(JSON.parse(readFileSync(wrapper, 'utf8'))).version,
    coreVersion: packageVersion.parse(JSON.parse(readFileSync(core, 'utf8'))).version,
  };
}
export async function observeBrowserProducer(page: Page): Promise<BrowserProducer> {
  const browser = page.context().browser();
  if (!browser) throw new Error('Coverage producer has no connected browser');
  const session = await page.context().newCDPSession(page);
  let observation: { state: 'observed'; producer: BrowserProducer } | { state: 'failed'; cause: unknown };
  try {
    const chromium = cdpVersion.parse(await session.send('Browser.getVersion'));
    observation = {
      state: 'observed',
      producer: browserProducerSchema.parse({
        chromium,
        browserVersion: browser.version(),
        playwright: actualPlaywrightVersions(),
        node: process.version,
      }),
    };
  } catch (cause) {
    observation = { state: 'failed', cause };
  }
  try {
    await session.detach();
  } catch (cause) {
    if (observation.state === 'failed')
      throw new AggregateError([observation.cause, cause], 'Coverage producer observation and cleanup failed');
    throw cause;
  }
  if (observation.state === 'failed') throw observation.cause;
  return observation.producer;
}
export function sameBrowserProducer(first: BrowserProducer, second: BrowserProducer): boolean {
  return JSON.stringify(browserProducerSchema.parse(first)) === JSON.stringify(browserProducerSchema.parse(second));
}
