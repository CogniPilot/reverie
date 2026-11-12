import type { BrowserProducer } from './browser-coverage-producer.js';
/** Synthetic metadata only; never describes a browser actually launched by this fixture. */
export const SYNTHETIC_BROWSER_PRODUCER: BrowserProducer = {
  chromium: { product: 'Chrome/123.0.0.1', protocolVersion: '1.3', revision: '@synthetic', jsVersion: '12.3.0' },
  browserVersion: '123.0.0.1',
  playwright: { version: '1.0.0', coreVersion: '1.0.0' },
  node: 'v22.0.0',
};
