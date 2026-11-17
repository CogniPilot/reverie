import { describe, expect, it, vi } from 'vitest';
import { deliverPlanRequest, planRequestWorkerRouting, type PlanRequestMessages } from '../src/plan-request-prompt.js';
import type { PlanRequestView } from '../src/plan-request.js';

const record = { id: 'request', sessionId: 'source', fromAccount: 'first', toAccount: 'second', mode: 'codex', targetMode: 'claude', expiresAt: 1_800_000 } as PlanRequestView;
function messages() {
  return {
    openDm: vi.fn(() => ({ id: 'dm' })),
    post: vi.fn(() => ({ id: 'notice', at: 100 })),
    lastSeen: vi.fn(() => undefined as { messageId: string; at: number } | undefined),
    deleteMessage: vi.fn(async () => {}),
  };
}
describe('queued expert plan approval messages', () => {
  it('describes explicit refresh and its real cleanup-before-launch order without exposing a credential', async () => {
    const m = messages();
    m.lastSeen.mockReturnValue({ messageId: 'notice', at: 100 });
    await deliverPlanRequest({ ...record, toAccount: 'first', targetMode: 'codex', purpose: 'runtime-refresh', runtimeDigest: 'a'.repeat(64) },
      m as unknown as PlanRequestMessages, () => true);
    const text = (m.post.mock.calls[0] as unknown as [unknown, unknown, string])[2];
    expect(text).toContain('runtime refresh');
    expect(text).toContain('preserving the selected runtime settings');
    expect(text).toContain('verifies source cleanup, then starts');
    expect(text).not.toContain('a'.repeat(64));
  });
  it('posts the private nonce-free message immediately and waits for read/submission acknowledgement', async () => {
    const m = messages();
    await deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => true, async () => {
      expect(m.post).toHaveBeenCalledTimes(1);
      m.lastSeen.mockReturnValue({ messageId: 'notice', at: 100 });
    }, { workerRouting: true });
    expect(m.openDm).toHaveBeenCalledWith('source', undefined);
    const [room, sender, text, to] = m.post.mock.calls[0] as unknown as [string, object, string, object[]];
    expect(room).toBe('dm'); expect(sender).toEqual({ kind: 'system', name: 'Plans' });
    expect(to).toEqual(['source']);
    expect(text).toContain('REVERIE_WORKER=1 reverie agent plan-move approve request --handoff-file');
    expect(text).toContain('REVERIE_WORKER=1 reverie agent plan-move reject request');
    expect(text).toContain('REVERIE_WORKER=1 reverie agent plan-move list');
    expect(text.match(/REVERIE_WORKER=1 reverie agent plan-move /g)).toHaveLength(3);
    expect(text).toContain("Do not interrupt unfinished work or approve a different expert's request.");
    expect(text).toContain('Claude harness');
    expect(text).toContain('Jan 1, 1970');
    expect(text).toContain('12:30:00 AM UTC');
    expect(text).not.toMatch(/[a-f0-9]{64}|plan-request-capabilities/);
    expect(m.deleteMessage).not.toHaveBeenCalled();
  });
  it('keeps legacy non-worker approval instructions on the private nonce path by default', async () => {
    const m = messages();
    m.lastSeen.mockReturnValue({ messageId: 'notice', at: 100 });
    await deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => true);
    const text = (m.post.mock.calls[0] as unknown as [unknown, unknown, string])[2];
    for (const command of ['approve request --handoff-file', 'reject request', 'list'])
      expect(text).toContain('reverie agent plan-move ' + command);
    expect(text).not.toContain('REVERIE_WORKER');
    expect(text).not.toMatch(/[a-f0-9]{64}|plan-request-capabilities/);
  });
  it('withdraws only its queued notice on cancellation, expiry or lost authorization', async () => {
    const m = messages(); let allowed = true;
    await expect(deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => allowed, async () => { allowed = false; })).rejects.toThrow('no longer authorized');
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.deleteMessage).toHaveBeenCalledWith('dm', 'notice', 'Plans');
  });
  it('tells the owner once, within a push body, when the request expired before the expert saw it', async () => {
    const m = messages(); let allowed = true;
    const ownerAlert = vi.fn(async () => 1);
    const name = 'Rowan ' + 'x'.repeat(94);
    await expect(deliverPlanRequest({ ...record, name, owner: 'pat' }, m as unknown as PlanRequestMessages, () => allowed,
      async () => { allowed = false; }, { expiredUnseen: () => true, ownerAlert })).rejects.toThrow('no longer authorized');
    expect(m.deleteMessage).toHaveBeenCalledWith('dm', 'notice', 'Plans');
    expect(ownerAlert).toHaveBeenCalledTimes(1);
    const [text, owner] = ownerAlert.mock.calls[0] as unknown as [string, string];
    expect(owner).toBe('pat');
    expect(text.startsWith('Reauthorize on Plans when idle')).toBe(true);
    expect(text).toContain('Rowan');
    expect(text).toContain('Nothing was switched');
    expect(text.length).toBeLessThanOrEqual(220);
    expect(text).not.toMatch(/[a-f0-9]{64}/);
  });
  it('decides expiry when delivery stops, so time passing during cleanup cannot turn another ending into an alert', async () => {
    // A cancellation or lost authority just before the deadline, with cleanup finishing after it.
    const m = messages(); let allowed = true; let expiredNow = false;
    m.deleteMessage.mockImplementation(async () => { expiredNow = true; });
    const ownerAlert = vi.fn(async () => 1);
    await expect(deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => allowed,
      async () => { allowed = false; }, { expiredUnseen: () => expiredNow, ownerAlert })).rejects.toThrow();
    expect(m.deleteMessage).toHaveBeenCalledTimes(1);
    expect(ownerAlert).not.toHaveBeenCalled();
  });
  it('no owner notice when the expert saw it in time, or when it ended for another reason', async () => {
    const ownerAlert = vi.fn(async () => 1);
    const seen = messages();
    await deliverPlanRequest(record, seen as unknown as PlanRequestMessages, () => true, async () => {
      seen.lastSeen.mockReturnValue({ messageId: 'notice', at: 100 });
    }, { expiredUnseen: () => true, ownerAlert });
    const cancelled = messages(); let allowed = true;
    await expect(deliverPlanRequest(record, cancelled as unknown as PlanRequestMessages, () => allowed,
      async () => { allowed = false; }, { expiredUnseen: () => false, ownerAlert })).rejects.toThrow();
    const unknown = messages(); let open = true;
    await expect(deliverPlanRequest(record, unknown as unknown as PlanRequestMessages, () => open,
      async () => { open = false; }, { ownerAlert })).rejects.toThrow();
    expect(cancelled.deleteMessage).toHaveBeenCalledTimes(1);
    expect(ownerAlert).not.toHaveBeenCalled();
  });
  it('a failing owner alert changes nothing else', async () => {
    const m = messages(); let allowed = true;
    await expect(deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => allowed, async () => { allowed = false; },
      { expiredUnseen: () => true, ownerAlert: () => { throw new Error('push down'); } })).rejects.toThrow('no longer authorized');
    expect(m.deleteMessage).toHaveBeenCalledTimes(1);
  });
  it('creates no message when refused before queuing and never mistakes an older read for receipt', async () => {
    const m = messages();
    await expect(deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => false)).rejects.toThrow();
    expect(m.post).not.toHaveBeenCalled();
    let allowed = true; m.lastSeen.mockReturnValue({ messageId: 'older', at: 100 });
    await expect(deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => allowed, async () => { allowed = false; })).rejects.toThrow();
    expect(m.deleteMessage).toHaveBeenCalledTimes(1);
  });
});

describe('canonical employee routing data for plan notices', () => {
  const request = { employeeId: 'employee', owner: 'owner', sessionId: 'source' };
  const employee = {
    id: 'employee',
    owner: 'owner',
    sessionId: 'source',
    sessionGeneration: 7,
    dockerBinding: {
      version: 1 as const,
      sessionId: 'source',
      sessionGeneration: 7,
      operationId: '10000000-0000-4000-8000-000000000001',
      credentialId: '20000000-0000-4000-8000-000000000002',
      containerId: 'a'.repeat(64),
      imageId: 'sha256:' + 'b'.repeat(64),
      originalDigest: 'c'.repeat(64),
      policyDigest: 'd'.repeat(64),
    },
  };
  it('selects worker command spelling only from the coherent current employee binding', () => {
    expect(planRequestWorkerRouting(request, [employee])).toBe(true);
    expect(planRequestWorkerRouting({ ...request, owner: undefined }, [{ ...employee, owner: undefined }])).toBe(true);
  });
  it('does not select worker routing for a matching but invalid generation', () => {
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        planRequestWorkerRouting(request, [
          {
            ...employee,
            sessionGeneration: generation,
            dockerBinding: { ...employee.dockerBinding, sessionGeneration: generation },
          },
        ])
      ).toBe(false);
  });
  it.each([
    'missing',
    'duplicate',
    'employee',
    'owner',
    'session',
    'binding-session',
    'generation',
    'no-binding',
  ] as const)('does not select worker routing for %s data', (change) => {
    const other = structuredClone(employee);
    if (change === 'employee') other.id = 'other';
    if (change === 'owner') other.owner = 'other';
    if (change === 'session') other.sessionId = 'other';
    if (change === 'binding-session') other.dockerBinding.sessionId = 'other';
    if (change === 'generation') other.dockerBinding.sessionGeneration++;
    const employees =
      change === 'missing'
        ? []
        : change === 'duplicate'
          ? [other, other]
          : change === 'no-binding'
            ? [{ ...other, dockerBinding: undefined }]
            : [other];
    expect(planRequestWorkerRouting(request, employees)).toBe(false);
  });
});

it('stores a message while the real chat delivery queue holds a working pane', async () => {
  const { ChatroomService } = await import('../src/chatroom-service.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'plan-request-chat-'));
  const writeViaMux = vi.fn(async () => true);
  const session = { id: 'source', name: 'Synthetic', mode: 'codex', pid: 1, status: 'busy', isWorking: true, paneDialog: null as string | null, writeViaMux };
  const chat = new ChatroomService({ file: join(root, 'chat.json'), getSession: id => id === 'source' ? session : undefined,
    broadcast: () => {} });
  await chat.init();
  try {
    await deliverPlanRequest(record, chat, () => true, async () => {
      const room = chat.rooms()[0];
      expect(room.messages).toHaveLength(1);
      expect(room.messages[0].text).toContain('plan-move approve request');
      expect(chat.deliveryStatus('source').pending).toBeGreaterThan(0);
      const delivery = Reflect.get(chat, 'delivery');
      expect(await delivery.flush('source')).toBe(false);
      session.isWorking = false; session.paneDialog = 'permission';
      expect(await delivery.flush('source')).toBe(false);
      expect(writeViaMux).not.toHaveBeenCalled();
      chat.markSeen('source', room.id, room.messages[0].id);
    });
    expect(writeViaMux).not.toHaveBeenCalled();
  } finally { await chat.stop(); await rm(root, { recursive: true, force: true }); }
});

it('preserves an already-read notice when approval or cancellation consumes the request', async () => {
  const m = messages(); let allowed = true;
  await expect(deliverPlanRequest(record, m as unknown as PlanRequestMessages, () => allowed, async () => {
    m.lastSeen.mockReturnValue({ messageId: 'notice', at: 100 }); allowed = false;
  })).rejects.toThrow('no longer authorized');
  expect(m.deleteMessage).not.toHaveBeenCalled();
});
