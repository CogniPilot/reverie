/**
 * The notice a switched-off routine sends: one line in the routine's room, addressed to the author and typed into their pane
 * (a plain system line reaches nobody's pane). Synthetic fixtures only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';

const AUTHOR = '0000002d-0035-4000-8000-000000000047';
const PEER = '00000038-0043-4000-8000-000000000060';

describe('noticeMember', () => {
  const services: ChatroomService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.stop();
  });

  it('queues the line for the addressed member only, and shows it in the room', async () => {
    const live = new Map([
      [AUTHOR, { name: 'Quinn', pid: 1, isWorking: false, mode: 'claude' }],
      [PEER, { name: 'Rowan', pid: 2, isWorking: false, mode: 'claude' }],
    ]);
    const file = join(mkdtempSync(join(tmpdir(), 'routine-notice-')), 'chatrooms.json');
    const service = new ChatroomService({ file, getSession: (id) => live.get(id) as never, broadcast: () => {} });
    await service.init();
    services.push(service);
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, AUTHOR, { goal: 'x' });
    service.addMember(room.id, PEER, { goal: 'y' });
    const before = [service.delivery.pendingFor(AUTHOR), service.delivery.pendingFor(PEER)];
    const message = service.noticeMember(room.id, AUTHOR, 'Routine "standup" is switched off');
    expect(message.from.kind).toBe('system');
    expect(service.room(room.id)!.messages.at(-1)?.id).toBe(message.id);
    expect(service.delivery.pendingFor(AUTHOR)).toBe(before[0] + 1);
    expect(service.delivery.pendingFor(PEER)).toBe(before[1]);
  });

  it('still reaches the addressed session after it was removed from the room', async () => {
    const live = new Map([
      [AUTHOR, { name: 'Quinn', pid: 1, isWorking: false, mode: 'claude' }],
      [PEER, { name: 'Rowan', pid: 2, isWorking: false, mode: 'claude' }],
    ]);
    const file = join(mkdtempSync(join(tmpdir(), 'routine-notice-')), 'chatrooms.json');
    const service = new ChatroomService({ file, getSession: (id) => live.get(id) as never, broadcast: () => {} });
    await service.init();
    services.push(service);
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, AUTHOR, { goal: 'x' });
    service.addMember(room.id, PEER, { goal: 'y' });
    service.removeMember(room.id, AUTHOR);
    const before = service.delivery.pendingFor(AUTHOR);
    const peerBefore = service.delivery.pendingFor(PEER);
    service.noticeMember(room.id, AUTHOR, 'Routine "standup" is switched off (Quinn is no longer a member of this room)');
    expect(service.delivery.pendingFor(AUTHOR)).toBe(before + 1);
    expect(service.delivery.pendingFor(PEER)).toBe(peerBefore);
  });
});
