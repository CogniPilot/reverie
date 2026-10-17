import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(join(process.cwd(), 'src/web/public/index.html'), 'utf-8');
const panelsJs = readFileSync(join(process.cwd(), 'src/web/public/panels-ui.js'), 'utf-8');
const stylesCss = readFileSync(join(process.cwd(), 'src/web/public/styles.css'), 'utf-8');
const mobileCss = readFileSync(join(process.cwd(), 'src/web/public/mobile.css'), 'utf-8');

describe('away digest UI', () => {
  it('exposes a header entry point and modal shell', () => {
    expect(indexHtml).toContain('onclick="app.openAwayDigest()"');
    expect(indexHtml).toContain('aria-label="Open away digest"');
    expect(indexHtml).toContain('id="awayDigestModal"');
    expect(indexHtml).toContain('id="awayDigestSummary"');
    expect(indexHtml).toContain('id="awayDigestSections"');
  });

  it('offers supported range controls', () => {
    expect(indexHtml).toContain('data-away-range="since-last-visit"');
    expect(indexHtml).toContain('data-away-range="1h"');
    expect(indexHtml).toContain('data-away-range="today"');
    expect(indexHtml).toContain('data-away-range="24h"');
    expect(indexHtml).toContain('id="awayDigestCustomSince"');
    expect(indexHtml).toContain('id="awayDigestCustomUntil"');
  });

  it('fetches the aggregate endpoint and preserves since-last-visit until successful close', () => {
    expect(panelsJs).toContain('/api/away-digest');
    expect(panelsJs).toContain('codeman-away-digest-last-viewed');
    expect(panelsJs).toContain('openAwayDigest');
    expect(panelsJs).toContain('closeAwayDigest');
  });

  it('has desktop and mobile layout styles', () => {
    expect(stylesCss).toContain('.away-digest-modal');
    expect(stylesCss).toContain('.away-digest-summary');
    expect(stylesCss).toContain('.away-digest-item');
    expect(mobileCss).toContain('.away-digest-modal');
    expect(mobileCss).toContain('.away-digest-ranges');
  });
});
