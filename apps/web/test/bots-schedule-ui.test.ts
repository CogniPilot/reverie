/**
 * The Bots page schedule form: a routine repeats every few minutes, daily, or
 * weekly on chosen days, at a time in a time zone that starts as the company's; the next runs show before saving, worked out
 * by the server's own schedule code; and an existing routine's schedule can be edited without touching its content.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextRuns } from '../src/cron/cron-time.js';
import { CronJobSchema, CronJobUpdateSchema, CronSchedulePreviewSchema } from '../src/web/schemas.js';
import type { CronJob } from '../src/types/cron.js';

const read = (file: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8');
const doms: JSDOM[] = [];
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });
const wait = (ms = 40) => new Promise((done) => setTimeout(done, ms));

function page() {
  const dom = new JSDOM(read('bots.html'), { url: 'http://example.test/bots', runScripts: 'outside-only' });
  doms.push(dom);
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const post = { action: 'post', botId: 'build', roomId: 'r1', postText: 'Status', createdByOwner: true };
  const jobs = [
    { id: 'daily', name: 'Morning note', ...post, scheduleType: 'daily', dailyTime: '08:15', timeZone: 'Europe/Berlin', enabled: true },
    { id: 'every', name: 'Pulse', ...post, scheduleType: 'interval', intervalMinutes: 30, enabled: false },
    // Was daily at 08:15, now weekly at 18:45: the service keeps the old dailyTime.
    { id: 'moved', name: 'Moved routine', ...post, scheduleType: 'weekly', weeklyDays: [2], weeklyTime: '18:45', dailyTime: '08:15', timeZone: 'Europe/Berlin', enabled: true },
    { id: 'once', name: 'One time', ...post, scheduleType: 'once', runAt: Date.now() + 60_000, enabled: true },
    { id: 'watch', name: 'Repository watch', ...post, postText: '{message}', postSource: 'github', postChangeOnly: true,
      postSourceArgs: { owner: 'o', repo: 'r', pull: 1 }, scheduleType: 'interval', intervalMinutes: 15, enabled: true },
  ];
  const data: Record<string, unknown> = {
    'chat-bots': { success: true, data: { bots: [{ id: 'build', name: 'Build Watch', rooms: ['r1'], maxPerHour: 30 }] } },
    'cron/jobs': jobs,
    'cron/runs': [],
    chatrooms: { success: true, data: { rooms: [{ id: 'r1', name: 'office' }] } },
    company: { success: true, data: { employees: [], settings: { timeZone: 'America/Chicago' } } },
    'cron/active': { jobs: [] },
    'bot-watches/github': { success: true, data: { watches: [] } },
    'publication/tokens': { success: true, data: { tokens: [] } },
  };
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (url: URL, options: { method?: string; body?: string } = {}) => {
    const path = new URL(url).pathname.slice('/api/'.length);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (options.method === 'POST' && path === 'cron/schedule-preview') {
      // The real schema and schedule code answer, as the route does.
      const parsed = CronSchedulePreviewSchema.safeParse(JSON.parse(options.body!));
      if (!parsed.success) return { ok: false, status: 400, json: async () => ({ success: false, error: parsed.error.issues[0].message }) };
      const { count = 3, ...schedule } = parsed.data;
      return ok({ success: true, data: { runs: nextRuns(schedule as CronJob, Date.now(), count) } });
    }
    if (options.method) {
      const body = JSON.parse(options.body!);
      sent.push({ method: options.method, path, body });
      if (path === 'cron/jobs') CronJobSchema.parse(body);
      else CronJobUpdateSchema.parse(body);
      return ok({ success: true, data: {} });
    }
    return ok(data[path]);
  });
  Object.assign(w, { fetch });
  w.eval(read('bots.js'));
  const get = <T extends HTMLElement = HTMLElement>(id: string) => w.document.getElementById(id) as T;
  const set = (root: HTMLElement, name: string, value: string) => {
    const el = root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const days = (root: HTMLElement, chosen: number[]) => {
    for (const box of root.querySelectorAll<HTMLInputElement>('input[name="weeklyDays"]')) box.checked = chosen.includes(Number(box.value));
    root.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const submit = (id: string) => get<HTMLFormElement>(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const card = (name: string) => [...w.document.querySelectorAll('#routines > *')].find((el) => el.textContent!.includes(name)) as HTMLElement;
  const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  return { w, get, set, days, submit, card, button, sent };
}

describe('Bots page schedule form', () => {
  it('shows and keeps the time of the routine\'s own kind when it still holds the other kind\'s time', async () => {
    const p = page();
    await wait();
    expect(p.card('Moved routine').textContent).toContain('Weekly Tue at 18:45');
    p.button(p.card('Moved routine'), 'Edit schedule')!.click();
    const schedule = p.get('edit-schedule');
    expect((schedule.querySelector('[name="scheduleType"]') as HTMLSelectElement).value).toBe('weekly');
    expect((schedule.querySelector('[name="at"]') as HTMLInputElement).value).toBe('18:45');
    p.submit('schedule-form');
    await wait();
    expect(p.sent).toEqual([{ method: 'PUT', path: 'cron/jobs/moved', body: { scheduleType: 'weekly', weeklyDays: [2], weeklyTime: '18:45', timeZone: 'Europe/Berlin' } }]);
  });

  it('creates a weekly routine at a time in a time zone, showing its next runs first', async () => {
    const p = page();
    await wait();
    p.get('new-routine').click();
    const form = p.get<HTMLFormElement>('routine-form');
    const schedule = p.get('routine-schedule');
    expect((schedule.querySelector('[name="intervalMinutes"]')!.closest('label') as HTMLElement).hidden).toBe(false);
    p.set(form, 'name', 'Standup');
    p.set(form, 'postText', 'Standup in five minutes');
    p.set(schedule, 'scheduleType', 'weekly');
    // Starts in the company's zone; the minutes field goes, days, time and zone appear.
    expect((schedule.querySelector('[name="timeZone"]') as HTMLInputElement).value).toBe('America/Chicago');
    expect((schedule.querySelector('[name="intervalMinutes"]')!.closest('label') as HTMLElement).hidden).toBe(true);
    expect((schedule.querySelector('.schedule-days') as HTMLElement).hidden).toBe(false);
    p.days(schedule, [1, 4]);
    p.set(schedule, 'at', '07:30');
    p.set(schedule, 'timeZone', 'Europe/Berlin');
    await wait(400);
    const preview = schedule.querySelector('.schedule-preview')!.textContent!;
    expect(preview.startsWith('Next runs: ')).toBe(true);
    const runs = preview.slice('Next runs: '.length).split(' · ');
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run).toMatch(/^(Mon|Thu), .* 07:30 GMT\+[12]$/);
    p.submit('routine-form');
    await wait();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ method: 'POST', path: 'cron/jobs' });
    expect(p.sent[0].body).toMatchObject({ scheduleType: 'weekly', weeklyDays: [1, 4], weeklyTime: '07:30', timeZone: 'Europe/Berlin' });
    expect(p.sent[0].body).not.toHaveProperty('intervalMinutes');
  });

  it('says what is missing instead of saving, and shows an interval as if saved now', async () => {
    const p = page();
    await wait();
    p.get('new-routine').click();
    const form = p.get<HTMLFormElement>('routine-form');
    const schedule = p.get('routine-schedule');
    p.set(form, 'name', 'Standup');
    p.set(form, 'postText', 'Hello');
    await wait(400);
    expect(schedule.querySelector('.schedule-preview')!.textContent).toMatch(/^Next runs if saved now: /);
    p.set(schedule, 'scheduleType', 'weekly');
    p.days(schedule, []);
    await wait(400);
    expect(schedule.querySelector('.schedule-preview')!.textContent).toBe('Choose at least one day.');
    p.submit('routine-form');
    await wait();
    expect(p.get('routine-error').textContent).toBe('Choose at least one day.');
    p.days(schedule, [2]);
    p.set(schedule, 'timeZone', 'Nowhere/Special');
    p.submit('routine-form');
    await wait();
    expect(p.get('routine-error').textContent).toContain('time zone');
    expect(p.sent).toEqual([]);
  });

  it('edits an existing routine schedule only, and is not offered for a one-time job or the repository watcher', async () => {
    const p = page();
    await wait();
    expect(p.button(p.card('Morning note'), 'Edit schedule')).toBeDefined();
    expect(p.button(p.card('Pulse'), 'Edit schedule')).toBeDefined();
    expect(p.button(p.card('One time'), 'Edit schedule')).toBeUndefined();
    expect(p.button(p.card('Repository watch'), 'Edit schedule')).toBeUndefined();
    p.button(p.card('Morning note'), 'Edit schedule')!.click();
    expect(p.get('schedule-dialog').hasAttribute('open')).toBe(true);
    expect(p.get('schedule-title').textContent).toBe('Edit schedule: Morning note');
    const schedule = p.get('edit-schedule');
    expect((schedule.querySelector('[name="scheduleType"]') as HTMLSelectElement).value).toBe('daily');
    expect((schedule.querySelector('[name="at"]') as HTMLInputElement).value).toBe('08:15');
    expect((schedule.querySelector('[name="timeZone"]') as HTMLInputElement).value).toBe('Europe/Berlin');
    p.set(schedule, 'at', '18:00');
    p.submit('schedule-form');
    await wait();
    expect(p.sent).toEqual([{ method: 'PUT', path: 'cron/jobs/daily', body: { scheduleType: 'daily', dailyTime: '18:00', timeZone: 'Europe/Berlin' } }]);
    expect(p.get('schedule-dialog').hasAttribute('open')).toBe(false);
    // An interval routine opens on its own minutes.
    p.button(p.card('Pulse'), 'Edit schedule')!.click();
    expect((schedule.querySelector('[name="intervalMinutes"]') as HTMLInputElement).value).toBe('30');
    expect((schedule.querySelector('[name="timeZone"]')!.closest('label') as HTMLElement).hidden).toBe(true);
  });
});
