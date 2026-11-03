import { describe, expect, it, vi } from 'vitest';
import { ChatroomDelivery, type DeliverySession } from '../src/chatroom-delivery.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function fixture() {
  const fetching = deferred<string>();
  const writes: string[] = [];
  const gates: boolean[] = [];
  const session: DeliverySession = {
    id: 's',
    name: 'Agent',
    mode: 'codex',
    pid: 42,
    isWorking: false,
    writeViaMux: async (text, opts) => {
      writes.push(text);
      gates.push(opts?.requireIdle === true);
      opts?.onOutcome?.('submitted');
      return true;
    },
  };
  const submitted = vi.fn();
  const prepare = vi.fn(() => fetching.promise);
  const delivery = new ChatroomDelivery({ getSession: () => session, prepareMessage: prepare, onSubmitted: submitted });
  delivery.enqueue('s', { id: 'r', name: 'room' }, 'USER: image unavailable', { messageId: 'm', localImages: true });
  return { fetching, writes, session, submitted, prepare, delivery, gates };
}

describe('fresh image paths at queue flush', () => {
  it('does not fetch at enqueue and submits only the freshly prepared view', async () => {
    const f = fixture();
    expect(f.prepare).not.toHaveBeenCalled();
    const flushing = f.delivery.flush('s');
    expect(f.prepare).toHaveBeenCalledWith('s', 'r', 'm');
    expect(f.writes).toEqual([]);
    f.fetching.resolve('USER: [attached: "/tmp/.reverie-chat-images/fresh.png"]');
    expect(await flushing).toBe(true);
    expect(f.writes[0]).toContain('fresh.png');
    expect(f.gates).toEqual([true]);
    expect(f.submitted).toHaveBeenCalledOnce();
    f.delivery.stop();
  });
  it('keeps unsupported automatic composer proofs out of image I/O; ordinary CLI reads remain available', async () => {
    const f = fixture();
    Object.assign(f.session, { mode: 'opencode' });
    expect(await f.delivery.flush('s')).toBe(true);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.writes[0]).toContain('image unavailable');
    f.delivery.stop();
  });
  it.each(['read', 'delete', 'leave', 'forget'] as const)(
    'a %s during image I/O withdraws the pending identity without a pane attempt',
    async (kind) => {
      const f = fixture();
      const flushing = f.delivery.flush('s');
      if (kind === 'read') f.delivery.acknowledgeRead('s', 'r', ['m']);
      if (kind === 'delete') f.delivery.dropMessage('r', 'm');
      if (kind === 'leave') f.delivery.dropRoom('r', 's');
      if (kind === 'forget') f.delivery.forget('s');
      f.fetching.resolve('fresh');
      expect(await flushing).toBe(false);
      expect(f.writes).toEqual([]);
      expect(f.delivery.inspectionFor('s')).toEqual([]);
      f.delivery.stop();
    }
  );
  it('a turn beginning during image I/O keeps the original queued view for a fresh later attempt', async () => {
    const f = fixture();
    const flushing = f.delivery.flush('s');
    Object.assign(f.session, { isWorking: true });
    f.fetching.resolve('a path that must not be saved');
    expect(await flushing).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.delivery.pendingFor('s')).toBe(1);
    expect(f.delivery.inspectionFor('s')).toEqual([]);
    f.delivery.stop();
  });
});
