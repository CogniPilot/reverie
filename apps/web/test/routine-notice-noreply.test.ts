/**
 * A notice typed to someone who is no longer in the room (a removed routine author) carries no "reply:" hint, because the
 * reply command would point at a room they cannot post in. Synthetic fixtures only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
import { buildDeliveryLine } from '../src/chatroom-delivery.js';

const AUTHOR = '0000002d-0035-4000-8000-000000000047';
const PEER = '00000038-0043-4000-8000-000000000060';

describe('notice without a reply hint', () => {
  const services: ChatroomService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.stop();
  });

  const setup = async () => {
    const live = new Map([
      [AUTHOR, { name: 'Quinn', pid: 1, isWorking: false, mode: 'claude' }],
      [PEER, { name: 'Rowan', pid: 2, isWorking: false, mode: 'claude' }],
    ]);
    const file = join(mkdtempSync(join(tmpdir(), 'routine-noreply-')), 'chatrooms.json');
    const service = new ChatroomService({ file, getSession: (id) => live.get(id) as never, broadcast: () => {} });
    await service.init();
    services.push(service);
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, PEER, { goal: 'y' });
    return { service, room };
  };
  const queued = (service: ChatroomService, id: string) => (service.delivery as unknown as { queues: Map<string, never[]> }).queues.get(id) ?? [];

  it('a removed author gets the line without the reply hint', async () => {
    const { service, room } = await setup();
    service.noticeMember(room.id, AUTHOR, 'Routine "standup" is switched off');
    const line = buildDeliveryLine(queued(service, AUTHOR));
    expect(line).toContain('switched off');
    expect(line).not.toContain('(reply:');
  });

  it('a current member still gets the reply hint', async () => {
    const { service, room } = await setup();
    service.noticeMember(room.id, PEER, 'Routine "standup" is switched off');
    expect(buildDeliveryLine(queued(service, PEER))).toContain('(reply: reverie agent chat say');
  });

  it('a mixed batch keeps the hint', () => {
    const line = buildDeliveryLine([
      { roomId: 'r', roomName: 'Lab', text: 'a', noReply: true },
      { roomId: 'r', roomName: 'Lab', text: 'b' },
    ]);
    expect(line).toContain('(reply:');
  });
});
