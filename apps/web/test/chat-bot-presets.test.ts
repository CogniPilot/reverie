import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BotPresetSchema, parseBotPreset } from '../src/chat-bot-presets.js';
import { parseBot } from '../src/chat-bots.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/bot-presets.json', import.meta.url), 'utf8'));
const sender = parseBot(fixtures.sender, fixtures.sender.id);
const watcher = () => structuredClone(fixtures.watcher);
const routine = () => structuredClone(fixtures.routine);

describe('bot preset configuration', () => {
  it.each(['watcher', 'routine'])('accepts the %s fixture, disabled with maintenance off', (key) => {
    const preset = parseBotPreset(fixtures[key], sender);
    expect(preset.enabled).toBe(false);
    expect(preset.maintenanceEnabled).toBe(false);
    expect(parseBotPreset(JSON.parse(JSON.stringify(preset)), sender)).toEqual(preset);
  });

  it('retains per-instance repository choices and allows only a broker reference', () => {
    const raw = { ...watcher(), brokerRef: 'shared-reader' };
    const preset = parseBotPreset(raw, sender);
    expect(preset).toMatchObject({
      repositories: raw.repositories,
      brokerRef: 'shared-reader',
      missingAppPolicy: 'public-only',
      brokerContractVersion: 1,
      logExcerptLines: 40,
    });
    expect(preset).not.toHaveProperty('token');
  });

  it.each([
    { schemaVersion: 2 },
    { type: 'custom-command' },
    { maintenanceEnabled: true },
    { token: 'unaccepted-secret' },
    { privateKey: 'unaccepted-key' },
    { command: 'echo hello' },
    { maxPerHour: 120 },
    { name: 'Another sender' },
    { enabled: 'true' },
    { brokerRef: 'https://example.invalid/broker' },
    { missingAppPolicy: 'pat' },
    { brokerContractVersion: 2 },
    { brokerMethod: 'POST' },
    { permissions: { contents: 'read', issues: 'write' } },
    { installationToken: 'unaccepted-secret' },
    { signedDownloadUrl: 'https://example.invalid/signed' },
    { upstreamBodyLimitBytes: 16777217 },
    { fetchTimeoutSeconds: 16 },
  ])('rejects unsupported or authority-changing fields: %j', (extra) => {
    expect(BotPresetSchema.safeParse({ ...watcher(), ...extra }).success).toBe(false);
  });

  it('accepts zero or bounded excerpt budgets without expanding broker authority', () => {
    for (const logExcerptLines of [0, 200]) {
      const preset = parseBotPreset({ ...watcher(), logExcerptLines, logExcerptChars: 2000 }, sender);
      expect(preset).toMatchObject({ brokerContractVersion: 1, logExcerptLines, logExcerptChars: 2000 });
    }
  });

  it('requires a registered sender and an allowed destination even when disabled', () => {
    expect(() => parseBotPreset(watcher(), undefined)).toThrow('does not exist');
    expect(() => parseBotPreset({ ...watcher(), botId: 'other' }, sender)).toThrow('does not exist');
    expect(() => parseBotPreset({ ...watcher(), roomId: 'elsewhere' }, sender)).toThrow('cannot post');
    const before = structuredClone(sender);
    parseBotPreset({ ...routine(), enabled: true }, sender);
    expect(sender).toEqual(before);
  });

  it('isolates parsed instance arrays from each other and from input', () => {
    const raw = watcher();
    const first = parseBotPreset(raw, sender),
      second = parseBotPreset(raw, sender);
    if (first.type !== 'github-watcher' || second.type !== 'github-watcher') throw new Error('Wrong fixture');
    first.repositories.push('example/third-project');
    expect(second.repositories).toEqual(raw.repositories);
    expect(first.repositories).not.toEqual(raw.repositories);
  });

  it.each(
    [
      [],
      ['example/*'],
      ['https://github.com/example/project'],
      ['example/project', 'EXAMPLE/PROJECT'],
      ['owner/..'],
    ].map((repositories) => ({ repositories }))
  )('rejects invalid or ambiguous repository scope: %j', ({ repositories }) => {
    expect(BotPresetSchema.safeParse({ ...watcher(), repositories }).success).toBe(false);
  });

  it.each([
    { events: [] },
    { events: ['issue', 'issue'] },
    { events: ['execute'] },
    { pollIntervalSeconds: 0 },
    { pollIntervalSeconds: 30.5 },
    { logExcerptChars: 2001 },
    { logExcerptLines: 201 },
    { logExcerptLines: -1 },
    { logExcerptLines: 0.5 },
  ])('rejects invalid event selection and read bounds: %j', (extra) => {
    expect(BotPresetSchema.safeParse({ ...watcher(), ...extra }).success).toBe(false);
  });

  it.each([
    { scheduleType: 'once', runAt: 1793000000000 },
    { scheduleType: 'interval', intervalMinutes: 5 },
    { scheduleType: 'weekly', weeklyTime: '09:00', timeZone: 'America/New_York', weeklyDays: [1, 3, 5] },
  ])('accepts existing cron schedule vocabulary: %j', (schedule) => {
    expect(BotPresetSchema.safeParse({ ...routine(), schedule }).success).toBe(true);
  });

  it.each([
    { scheduleType: 'daily', dailyTime: '24:00', timeZone: 'UTC' },
    { scheduleType: 'daily', dailyTime: '09:00', timeZone: 'Unknown/Zone' },
    { scheduleType: 'daily', dailyTime: '09:00' },
    { scheduleType: 'weekly', weeklyTime: '09:00', timeZone: 'UTC', weeklyDays: [1, 1] },
    { scheduleType: 'interval', intervalMinutes: 0 },
    { scheduleType: 'once', runAt: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid or incomplete schedules: %j', (schedule) => {
    expect(BotPresetSchema.safeParse({ ...routine(), schedule }).success).toBe(false);
  });

  it('validates source templates and numeric conditions through the existing post source rules', () => {
    const post = {
      kind: 'source',
      source: 'host-load',
      text: 'Load: {load1}',
      when: { field: 'load1', op: 'gt', value: 2 },
    };
    expect(parseBotPreset({ ...routine(), post }, sender)).toMatchObject({ post: { changeOnly: false } });
    for (const invalid of [
      { ...post, text: '{unknown}' },
      { ...post, when: { field: 'summary', op: 'gt', value: 2 } },
      { ...post, source: 'github' },
      { ...post, command: 'echo hello' },
    ])
      expect(BotPresetSchema.safeParse({ ...routine(), post: invalid }).success).toBe(false);
    expect(BotPresetSchema.safeParse({ ...routine(), post: { kind: 'text', text: '  ' } }).success).toBe(false);
    expect(BotPresetSchema.safeParse({ ...routine(), missedRunPolicy: 'replay-all' }).success).toBe(false);
  });
});
