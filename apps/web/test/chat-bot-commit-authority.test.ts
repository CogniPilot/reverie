import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatBotRegistry } from '../src/chat-bots.js';
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of dirs.splice(0)) await fs.rm(p, { recursive: true, force: true });
});
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bot-commit-'));
  dirs.push(dir);
  const file = join(dir, 'bots.json');
  await fs.writeFile(file, JSON.stringify({ news: { name: 'News', rooms: [], maxPerHour: 10 } }));
  return { file, registry: new ChatBotRegistry(file) };
}
it('rechecks synchronous authority after actual temp write before registry rename', async () => {
  const f = await fixture(),
    before = await fs.readFile(f.file);
  let allowed = true;
  const original = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    await original(...args);
    allowed = false;
  });
  await expect(
    f.registry.set('github', { name: 'GitHub', rooms: ['room'] }, () => {
      if (!allowed) throw Error('revoked');
    })
  ).rejects.toThrow('revoked');
  expect(await fs.readFile(f.file)).toEqual(before);
  expect(new ChatBotRegistry(f.file).get('github')).toBeUndefined();
});
it('normal set and a current synchronous callback preserve existing bots', async () => {
  const f = await fixture();
  let calls = 0;
  await f.registry.set('github', { name: 'GitHub', rooms: ['room'] }, () => {
    calls++;
  });
  expect(calls).toBe(2);
  expect(new ChatBotRegistry(f.file).list().map((x) => x.id)).toEqual(['news', 'github']);
});
it('rejects a Promise authority result before any registry publication', async () => {
  const f = await fixture(),
    before = await fs.readFile(f.file);
  await expect(f.registry.set('github', { name: 'GitHub', rooms: ['room'] }, async () => {})).rejects.toThrow(
    'Synchronous bot authority'
  );
  expect(await fs.readFile(f.file)).toEqual(before);
});

it('a denied publication never enters the live map or a later unrelated successful save', async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    f.registry.set('denied', { name: 'Denied', rooms: ['room'] }, () => {
      if (++checks === 2) throw Error('revoked');
    })
  ).rejects.toThrow('revoked');
  expect(f.registry.get('denied')).toBeUndefined();
  await f.registry.set('allowed', { name: 'Allowed', rooms: [] });
  const reopened = new ChatBotRegistry(f.file);
  expect(reopened.get('denied')).toBeUndefined();
  expect(reopened.get('allowed')).toBeDefined();
});
it('serializes concurrent successful writes without losing either detached map update', async () => {
  const f = await fixture();
  await Promise.all([
    f.registry.set('first', { name: 'First', rooms: [] }),
    f.registry.set('second', { name: 'Second', rooms: [] }),
  ]);
  expect(new ChatBotRegistry(f.file).list().map((b) => b.id)).toEqual(['news', 'first', 'second']);
});
