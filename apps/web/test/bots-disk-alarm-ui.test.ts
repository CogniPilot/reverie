/**
 * The bots page turns the disk alarm on, edits it and turns it off through the existing owner routes, sending only
 * bodies the server's own schemas accept, and creates its dedicated bot only when no chosen bot may post in the channel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBot } from '../src/chat-bots.js';
import { DiskSpaceWatchConfig } from '../src/disk-space-watch.js';

const read = (file: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8');
const doms: JSDOM[] = [];
const tick = () => new Promise((done) => setTimeout(done, 20));
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

type Config = Record<string, unknown>;
function fixture(options: { config?: Config; owner?: boolean; bots?: unknown[]; volumes?: Record<string, unknown> } = {}) {
  const dom = new JSDOM(read('bots.html'), { url: 'http://example.test/bots', runScripts: 'outside-only' });
  doms.push(dom);
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  let disk = { config: options.config, volumes: options.volumes ?? {}, failures: 0, durable: true };
  const data: Record<string, unknown> = {
    'chat-bots': { success: true, data: { bots: options.bots ?? [{ id: 'build', name: 'Build Watch', rooms: ['r1'], maxPerHour: 30 }] } },
    'cron/jobs': [],
    'cron/runs': [],
    'cron/active': { jobs: [] },
    company: { success: true, data: { employees: [] } },
    chatrooms: { success: true, data: { rooms: [{ id: 'r1', name: 'office' }, { id: 'r2', name: 'boardroom' }, { id: 'dm', name: 'private', dm: true }] } },
    'bot-watches/github': { success: true, data: { version: 1, revision: 0, watches: [] } },
  };
  const fetch = vi.fn(async (url: URL, init: { method?: string; body?: string }) => {
    const path = new URL(url).pathname.slice('/api/'.length);
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body!);
      if (path.startsWith('chat-bots/')) {
        const bot = parseBot(body, path.split('/')[1]!);
        return { ok: true, json: async () => ({ success: true, data: { bot } }) };
      }
      if (path === 'bot-watches/disk-space') {
        disk = { ...disk, config: DiskSpaceWatchConfig.parse(body) };
        return { ok: true, json: async () => ({ success: true, data: { disk } }) };
      }
      throw new Error('Unexpected write ' + path);
    }
    if (path === 'bot-watches') {
      return options.owner === false
        ? { ok: false, status: 403, json: async () => ({ success: false, error: 'Verified owner required' }) }
        : { ok: true, status: 200, json: async () => ({ success: true, data: { disk, unavailable: [] } }) };
    }
    return { ok: true, status: 200, json: async () => data[path] ?? { success: true, data: {} } };
  });
  Object.assign(w, { fetch });
  w.eval(read('bots.js'));
  const get = (id: string) => w.document.getElementById(id)!;
  const writes = () => fetch.mock.calls.filter(([, init]) => init.method).map(([url, init]) => [new URL(url).pathname, JSON.parse(init.body!)]);
  return { w, get, writes, form: () => get('disk-form') as HTMLFormElement };
}
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
const set = (form: HTMLFormElement, name: string, value: string) => {
  const element = field(form, name);
  element.value = value;
  element.dispatchEvent(new element.ownerDocument.defaultView!.Event('change'));
};

describe('disk alarm panel', () => {
  it('sets the alarm up with a dedicated bot for the chosen channel, in two schema-valid writes', async () => {
    const p = fixture();
    await tick();
    expect(p.get('disk-status').textContent).toBe('The disk alarm is not set up.');
    p.get('disk-edit').click();
    const form = p.form();
    expect(field(form, 'warnPercent').value).toBe('90');
    expect(field(form, 'criticalPercent').value).toBe('99');
    expect(field(form, 'intervalMinutes').value).toBe('5');
    set(form, 'roomId', 'r2');
    expect(field(form, 'botId').value).toBe('disk-alarm');
    set(form, 'criticalPercent', '97');
    set(form, 'mention', '@Alex');
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.writes()).toEqual([
      ['/api/chat-bots/disk-alarm', { name: 'Disk Alarm', icon: '💾', rooms: ['r2'], maxPerHour: 6 }],
      ['/api/bot-watches/disk-space', {
        version: 1, type: 'disk-space', enabled: true, botId: 'disk-alarm', roomId: 'r2',
        warnPercent: 90, criticalPercent: 97, rearmMarginPercent: 1, intervalMinutes: 5, mention: 'Alex',
      }],
    ]);
    expect(p.get('disk-dialog').hasAttribute('open')).toBe(false);
    expect(p.get('disk-status').textContent).toContain('On: warns at 90%, critical at 97%');
    expect(p.get('disk-status').textContent).toContain('#boardroom as Disk Alarm, mentioning @Alex');
  });

  it('uses a bot already allowed in the channel without changing any bot', async () => {
    const p = fixture();
    await tick();
    p.get('disk-edit').click();
    const form = p.form();
    set(form, 'roomId', 'r1');
    set(form, 'botId', 'build');
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.writes().map(([path]) => path)).toEqual(['/api/bot-watches/disk-space']);
    expect(p.writes()[0]![1]).toMatchObject({ botId: 'build', roomId: 'r1' });
  });

  it('adds the channel to an existing dedicated bot, keeping its other channels and settings', async () => {
    const p = fixture({ bots: [{ id: 'disk-alarm', name: 'Disk Alarm', icon: '💾', rooms: ['r1'], maxPerHour: 4 }] });
    await tick();
    p.get('disk-edit').click();
    const form = p.form();
    set(form, 'roomId', 'r2');
    expect((field(form, 'botId') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Disk Alarm (also post here)');
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.writes()[0]).toEqual(['/api/chat-bots/disk-alarm', { name: 'Disk Alarm', icon: '💾', rooms: ['r1', 'r2'], maxPerHour: 4 }]);
  });

  it('refuses a warning level at or above critical and an invalid mention, writing nothing', async () => {
    const p = fixture();
    await tick();
    p.get('disk-edit').click();
    const form = p.form();
    set(form, 'warnPercent', '97');
    set(form, 'criticalPercent', '97');
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.get('disk-error').textContent).toContain('below the critical level');
    set(form, 'warnPercent', '90');
    set(form, 'mention', 'Alex<b>');
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.get('disk-error').textContent).toContain('A mention is a name');
    expect(p.writes()).toEqual([]);
  });

  it('turns an existing alarm off and on with the same settings', async () => {
    const config = { version: 1, type: 'disk-space', enabled: true, botId: 'build', roomId: 'r1', warnPercent: 90, criticalPercent: 97, rearmMarginPercent: 1, intervalMinutes: 5, mention: 'Alex' };
    const p = fixture({ config, volumes: { a: { level: 'warn', since: 1, labels: ['Workspace <img src=x>'] } } });
    await tick();
    expect(p.get('disk-edit').textContent).toBe('Edit disk alarm');
    expect(p.get('disk-volumes').textContent).toContain('Workspace <img src=x>');
    expect(p.get('disk-volumes').textContent).toContain('Warning');
    expect(p.get('disk-volumes').querySelector('img')).toBeNull();
    p.get('disk-toggle').click();
    await tick();
    expect(p.writes()).toEqual([['/api/bot-watches/disk-space', { ...config, enabled: false }]]);
    expect(p.get('disk-status').textContent).toMatch(/^Off:/);
    expect(p.get('disk-toggle').textContent).toBe('Turn on');
  });

  it('shows the sign-in message and offers no setup to a non-owner', async () => {
    const p = fixture({ owner: false });
    await tick();
    expect(p.get('disk-status').textContent).toBe('Sign in as the owner to manage the disk alarm.');
    expect((p.get('disk-edit') as HTMLButtonElement).disabled).toBe(true);
    expect(p.get('disk-toggle').hidden).toBe(true);
  });
});
