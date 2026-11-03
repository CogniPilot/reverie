/** The website's stop-agent client: what counts as a definitive refusal and what stays an unknown outcome. */
import { describe, expect, it, vi } from 'vitest';
import { settleLaptopStop, stopLaptopAgent } from '../src/web/routes/laptop-power-routes.js';

const FENCE = '0123456789abcdef0123456789abcdef';
const failing = (props: Record<string, unknown>) => vi.fn(async () => { throw Object.assign(new Error('command failed'), props); });

describe('stopLaptopAgent', () => {
  it('sends the session, its deadline and its fence and returns the broker reply', async () => {
    const run = vi.fn(async () => ({ stdout: '{"action":"stop-agent","success":true,"stopped":true,"paneDead":true}', stderr: '' }));
    expect(await stopLaptopAgent('session-1', 1_793_393_600_123.7, FENCE, run as never)).toMatchObject({ stopped: true });
    expect(run.mock.calls[0][1]).toEqual(['--control', 'stop-agent', '--session-id', 'session-1', '--not-after', '1793393600123', '--fence', FENCE]);
  });

  it('treats an older client that has no --not-after as a definitive refusal', async () => {
    const run = failing({ code: 2, stderr: 'usage: reverie-worker-exec ...\nreverie-worker-exec: error: unrecognized arguments: --not-after 1793393600123\n' });
    expect(await stopLaptopAgent('session-1', 1_793_393_600_123, FENCE, run as never)).toMatchObject({ dispatched: false });
  });

  it('treats an older client that has no --fence as a definitive refusal', async () => {
    const run = failing({ code: 2, stderr: 'reverie-worker-exec: error: unrecognized arguments: --fence ' + FENCE + '\n' });
    expect(await stopLaptopAgent('session-1', 1_793_393_600_123, FENCE, run as never)).toMatchObject({ dispatched: false });
  });

  it('treats a broker that refuses the request frame as a definitive refusal', async () => {
    const run = failing({ code: 1, stderr: 'Traceback (most recent call last):\n  ...\nRuntimeError: Invalid stop-agent request\n' });
    const result = await stopLaptopAgent('session-1', 1_793_393_600_123, FENCE, run as never);
    expect(result).toMatchObject({ dispatched: false });
    expect(String(result.error)).toContain('updated laptop manager');
  });

  it('leaves a timeout, a lost connection or a failure after the signal as an unknown outcome', async () => {
    for (const props of [
      { killed: true, signal: 'SIGTERM', code: null, stderr: '' },
      { code: 1, stderr: 'ConnectionResetError: [Errno 104] Connection reset by peer\n' },
      { code: 1, stderr: 'RuntimeError: Laptop pane state is unavailable after the stop signal; its outcome is unknown\n' },
      { code: 2, stderr: 'error: unrecognized arguments: --other\n' },
    ])
      await expect(stopLaptopAgent('session-1', 1_793_393_600_123, FENCE, failing(props) as never)).rejects.toThrow('command failed');
  });
});

describe('settleLaptopStop', () => {
  it('asks the laptop to settle exactly that stop and returns its answer', async () => {
    const run = vi.fn(async () => ({ stdout: '{"action":"settle-stop","success":true,"signalled":false}', stderr: '' }));
    expect(await settleLaptopStop('session-1', FENCE, run as never)).toEqual({ action: 'settle-stop', success: true, signalled: false });
    expect(run.mock.calls[0][1]).toEqual(['--control', 'settle-stop', '--session-id', 'session-1', '--fence', FENCE]);
  });

  it('never turns a missing answer into one', async () => {
    for (const props of [{ killed: true, signal: 'SIGTERM', code: null, stderr: '' },
      { code: 1, stderr: 'RuntimeError: The laptop stop is not settled yet; its outcome is unknown\n' }])
      await expect(settleLaptopStop('session-1', FENCE, failing(props) as never)).rejects.toThrow('command failed');
  });
});
