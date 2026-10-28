import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { displayTime, displayTimeZone, offsetTimestamp, parseOffsetTimestamp } from '../src/display-time.js';
import { renderTurnSummary } from '../src/chatroom-turn-summary.js';
import { createInputWatch } from '../src/input-watch.js';

describe('configured display timezone', () => {
  it('uses Eastern standard and daylight time at the actual instant', () => {
    expect(displayTime('2026-01-15T15:00:00Z', 'America/New_York')).toContain('10:00:00 AM EST');
    expect(displayTime('2026-07-15T15:00:00Z', 'America/New_York')).toContain('11:00:00 AM EDT');
  });
  it('distinguishes both occurrences of the DST repeated hour', () => {
    expect(offsetTimestamp(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-11-01T01:30:00-04:00');
    expect(offsetTimestamp(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('2026-11-01T01:30:00-05:00');
  });
  it('skips the nonexistent spring hour rather than inventing it', () => {
    expect(offsetTimestamp(Date.parse('2026-03-08T07:00:00Z'), 'America/New_York')).toBe('2026-03-08T03:00:00-04:00');
  });
  it('handles fractional offsets and calendar-day rollover', () => {
    expect(offsetTimestamp(Date.parse('2026-01-01T00:00:00Z'), 'Asia/Kolkata')).toBe('2026-01-01T05:30:00+05:30');
    expect(offsetTimestamp(Date.parse('2026-01-01T00:00:00Z'), 'America/Los_Angeles')).toBe('2025-12-31T16:00:00-08:00');
    expect(offsetTimestamp(Date.parse('2026-01-01T00:00:00Z'), 'Asia/Kathmandu')).toBe('2026-01-01T05:45:00+05:45');
  });
  it('keeps the exact reset instant unchanged through display conversions', () => {
    const at = Date.parse('2026-11-01T06:30:00Z');
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) {
      expect(parseOffsetTimestamp(offsetTimestamp(at, zone))).toBe(at);
    }
  });
  it.each(['2026-02-30T12:00:00Z', '2026-11-01T01:30:00', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+05:60', 'not a timestamp'])(
    'refuses invalid or ambiguous ETA %s', text => expect(parseOffsetTimestamp(text)).toBeUndefined()
  );
  it('accepts existing UTC ETA and equivalent explicit-offset ETA', () => {
    expect(parseOffsetTimestamp('2026-10-28T01:00:00Z')).toBe(parseOffsetTimestamp('2026-10-27T21:00:00-04:00'));
  });
  it('fails invalid settings back to explicitly labelled UTC and invalid dates to a placeholder', () => {
    expect(displayTimeZone('wrong\n@everyone')).toBe('UTC');
    expect(displayTimeZone('x'.repeat(101))).toBe('UTC');
    expect(displayTime(0, 'bad/zone')).toContain('UTC');
    expect(displayTime('invalid')).toBe('—');
  });
  it('gives agents the current zone and local source time without altering source epoch or body', () => {
    const at = Date.parse('2026-10-28T00:00:00Z');
    const candidate = { roomId: 'r', room: 'office', messageId: 'm', sender: 'owner', role: 'user', at,
      excerpt: 'original quoted body', state: 'reply-pending' as const, priority: 1 };
    const summary = renderTurnSummary('ring', [candidate], undefined, 'America/New_York', at);
    expect(summary.timeZone).toBe('America/New_York');
    expect(summary.generatedAt).toBe(at);
    expect(summary.messages[0]?.at).toBe(at);
    expect(summary.messages[0]?.excerpt).toBe(candidate.excerpt);
    expect(summary.messages[0]?.atLocal).toContain('8:00:00 PM EDT');
    expect(summary.text).toContain('Use this timezone');
    expect(summary.text.length).toBeLessThanOrEqual(3000);
  });
  it('does not share display-zone state between agent summaries', () => {
    const at = Date.parse('2026-10-28T00:00:00Z');
    const a = renderTurnSummary('ring', [], undefined, 'Asia/Tokyo', at);
    const b = renderTurnSummary('ring', [], undefined, 'America/New_York', at);
    expect(a.text).toContain('Asia/Tokyo');
    expect(b.text).not.toContain('Asia/Tokyo');
    expect(renderTurnSummary('ring', []).text).toBe('');
  });
  it('browser helper uses authorized company settings, formats resets and refuses a settings override in format options', async () => {
    const events: unknown[] = [];
    const window: Record<string, any> = { dispatchEvent: (event: unknown) => events.push(event) };
    let payload: any = { success: true, data: { settings: { timeZone: 'America/New_York' } } };
    const context = { window, Intl, Date, AbortSignal, CustomEvent: class { constructor(public type: string, public detail: unknown) {} },
      document: { addEventListener() {} }, fetch: async () => ({ ok: true, json: async () => payload }) };
    runInNewContext(readFileSync(new URL('../src/web/public/display-time.js', import.meta.url), 'utf8'), context);
    await window.ReverieTime.load();
    const reset = '2026-10-28T00:00:00Z';
    expect(window.ReverieTime.format(reset)).toContain('8:00 PM EDT');
    expect(window.ReverieTime.format(reset, { timeZone: 'Asia/Tokyo', timeZoneName: undefined })).toContain('EDT');
    expect(events).toHaveLength(1);
    window.ReverieTime.setTimeZone('America/New_York');
    expect(events).toHaveLength(1);
    payload = { success: false, data: { settings: { timeZone: 'Asia/Tokyo' } } };
    await window.ReverieTime.load();
    expect(window.ReverieTime.timeZone).toBe('America/New_York');
    window.ReverieTime.setTimeZone('bad/zone');
    expect(window.ReverieTime.format(reset)).toContain('UTC');
    expect(window.ReverieTime.format('bad timestamp')).toBe('—');
  });
  it('TZ-1: the production Plans card uses the company zone for every reset and run-out display', () => {
    type Element = { textContent: string; children: Element[]; title?: string; style: Record<string, string>;
      append(...children: Element[]): void };
    const el = (_tag: string, _cls = '', text = ''): Element => ({ textContent: text, children: [], style: {},
      append(...children) { this.children.push(...children); } });
    class App { _plansEls = { el }; }
    const window: Record<string, any> = { dispatchEvent() {} };
    // A browser-local conversion is deliberately in a different zone from the company.
    class BrowserDate extends Date {
      override toLocaleString(locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        return super.toLocaleString(locale, { timeZone: 'America/Los_Angeles', ...options });
      }
      override toLocaleTimeString(locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        return super.toLocaleTimeString(locale, { timeZone: 'America/Los_Angeles', ...options });
      }
    }
    const context = { window, ReverieApp: App, Intl, Date: BrowserDate,
      CustomEvent: class {}, document: { addEventListener() {}, createTextNode: (text: string) => el('text', '', text) } };
    runInNewContext(readFileSync(new URL('../src/web/public/display-time.js', import.meta.url), 'utf8'), context);
    Object.assign(context, { ReverieTime: window.ReverieTime });
    runInNewContext(readFileSync(new URL('../src/web/public/plans-ui.js', import.meta.url), 'utf8'), context);
    const at = '2026-11-01T06:30:00Z'; // Repeated Eastern hour, specifically standard time.
    const account = { provider: 'openai', label: 'Fixture', signedIn: true, sessions: [], usageSource: 'history',
      usageAsOf: at, pace: { recommendation: 'steady', weekReset: at, runsOutAt: at,
        elapsed: 10, weekly: 20, fiveHour: 30, pace: 0, burnPerHour: 1, projected: 40 } };
    const app = new App() as App & { _planCard(a: unknown): Element };
    const flatten = (e: Element): Element[] => [e, ...e.children.flatMap(flatten)];
    for (const zone of ['America/New_York', 'Asia/Kathmandu']) {
      window.ReverieTime.setTimeZone(zone);
      const nodes = flatten(app._planCard(account));
      const expected = window.ReverieTime.format(at);
      expect(nodes.find(n => n.title?.startsWith('Week resets'))?.title).toBe(`Week resets ${expected}`);
      for (const label of ['resets', 'runs out', 'as of']) {
        const facts = nodes.filter(n => n.children[0]?.textContent === label);
        expect(facts.length).toBeGreaterThan(0);
        for (const fact of facts) expect(fact.children[1]?.textContent).toBe(` ${expected}`);
      }
      expect(account.pace.weekReset).toBe(at);
    }
  });
  it('TZ-2: the production input watcher posts the current room-owner company zone without a fixed ET suffix', () => {
    const at = Date.parse('2026-11-01T06:30:00Z');
    let zone: string | undefined = 'Asia/Kathmandu';
    const owners: (string | undefined)[] = [];
    const posts: string[] = [];
    const bot = { id: 'input-watch', name: 'Input Watch', rooms: ['r'], maxPerHour: 6 };
    const watch = createInputWatch({ bot: () => bot, employee: () => ({ id: 'employee-123', sessionId: 's' }),
      room: () => ({ id: 'r', owner: 'company-owner', members: [{ sessionId: 's' }], messages: [] }),
      now: () => at, timeZone: owner => { owners.push(owner); return zone; },
      post: (_bot, _room, text) => { posts.push(text); return { id: `post-${posts.length}`, at }; },
      failed: () => { throw new Error('Unexpected notification failure'); } });
    for (const selected of ['Asia/Kathmandu', 'America/New_York', undefined]) {
      zone = selected;
      watch.pending({ id: `event-${posts.length}`, sessionId: 's', kind: 'permission' });
      expect(posts.at(-1)).toContain(`— ${displayTime(at, selected)}. Open Approvals`);
      expect(posts.at(-1)).not.toMatch(/ ET\./);
    }
    expect(owners).toEqual(['company-owner', 'company-owner', 'company-owner']);
    const server = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/this\.inputWatch = createInputWatch\(\{\s*ledgerFile:[^\n]+\n\s*timeZone: owner => this\.companyService\.view\(owner\)\.settings\.timeZone,/);
  });
});
