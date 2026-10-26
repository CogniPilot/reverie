import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
const services: ChatroomService[] = [],
  folders: string[] = [];
afterEach(async () => {
  for (const s of services) await s.stop();
  services.length = 0;
  for (const d of folders) await rm(d, { recursive: true, force: true });
  folders.length = 0;
});
async function fixture(db: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-durable-chat-'));
  folders.push(dir);
  const create = async () => {
    const s = new ChatroomService({
      file: join(dir, 'chatrooms.json'),
      database: db ? join(dir, 'chat.db') : undefined,
      getSession: () => undefined,
      broadcast: () => {},
    });
    await s.init();
    services.push(s);
    return s;
  };
  return { create };
}
describe('typed bot synchronous durable message admission', () => {
  it('refuses JSON debounce-only fallback before a post', async () => {
    const f = await fixture(false),
      s = await f.create(),
      r = s.createRoom('Room', undefined);
    expect(() =>
      s.postDurableBotMessage(
        { id: 'status', name: 'Status', rooms: [r.id], maxPerHour: 30 },
        r.id,
        'test',
        0,
        'all',
        false
      )
    ).toThrow('durable chat database');
    expect(s.room(r.id)?.messages).toHaveLength(0);
  });
  it('real SQLite acknowledgement survives website service reopen without duplicate', async () => {
    const f = await fixture(true),
      s = await f.create(),
      r = s.createRoom('Room', undefined),
      bot = { id: 'status', name: 'Status', rooms: [r.id], maxPerHour: 30 };
    const m = s.postDurableBotMessage(bot, r.id, 'public fixture notice', 0, 'all', false);
    await s.stop();
    services.splice(services.indexOf(s), 1);
    const reopened = await f.create();
    expect(reopened.room(r.id)?.messages.filter((x) => x.id === m.id)).toHaveLength(1);
  });
});
