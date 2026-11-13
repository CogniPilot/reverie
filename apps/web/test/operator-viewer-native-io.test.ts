/** Original Node pipe credit only; not a native process/closure receipt. */
import {Writable} from 'node:stream';
import {afterEach, expect, it, vi} from 'vitest';
import {AttachmentFrames} from '../scripts/operator-viewer-input.js';
import {NativeAttachmentIo, NATIVE_IO_WAIT_MS} from '../scripts/operator-viewer-native-io.js';
afterEach(() => vi.useRealTimers());

function sink(blocked = false) {
  const writes: Buffer[] = [];
  let complete: (() => void) | undefined;
  const stream = new Writable({highWaterMark: blocked ? 1 : 65536,
    write(bytes: Buffer, _encoding, done) {writes.push(Buffer.from(bytes)); if (blocked) complete = done; else done();}});
  const onError = () => {};
  stream.on('error', onError);
  const io = new NativeAttachmentIo(); io.bind(stream); io.ready();
  return {stream, io, writes, complete: () => complete?.()};
}
it('writes native I/R frames without changing bytes or ordered bounded geometry', async () => {
  const f = sink();
  await f.io.drained(); f.io.input(Buffer.from('漢🙂')); await f.io.drained();
  f.io.resize(120, 40); await f.io.drained(); f.io.input(Buffer.from('tail'));
  const frames: Array<[number, Buffer]> = [];
  const decoder = new AttachmentFrames((kind, bytes) => frames.push([kind, bytes]));
  for (const write of f.writes) decoder.feed(write);
  expect(frames).toEqual([[73, Buffer.from('漢🙂')], [82, Buffer.from('[120,40]')], [73, Buffer.from('tail')]]);
  expect(() => f.io.input(Buffer.alloc(65537))).toThrow('batch bound');
  expect(() => f.io.resize(1, 501)).toThrow('geometry');
  expect(f.writes).toHaveLength(3); f.io.stop(); f.stream.end();
});
it('cancels original readiness waits immediately and cannot bind or revive after stop', async () => {
  const io = new NativeAttachmentIo();
  const waiting = io.drained(); io.stop();
  await expect(waiting).rejects.toThrow('closed');
  expect(() => io.bind(new Writable({write(_bytes, _encoding, done) {done();}}))).toThrow('replaced');
  expect(() => io.ready()).toThrow('unavailable');
});
it('expires missing readiness without dispatching input', async () => {
  vi.useFakeTimers();
  const io = new NativeAttachmentIo();
  const waiting = io.drained().catch(cause => cause);
  await vi.advanceTimersByTimeAsync(NATIVE_IO_WAIT_MS);
  expect(await waiting).toMatchObject({message: expect.stringContaining('expired')});
  expect(io.stopped).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('waits on actual Node backpressure and removes every waiter on cancellation', async () => {
  const f = sink(true);
  f.io.input(Buffer.from('original'));
  const waiting = f.io.drained();
  expect(f.stream.writableNeedDrain).toBe(true);
  expect(f.stream.listenerCount('drain')).toBe(1);
  f.io.stop(); await expect(waiting).rejects.toThrow('closed');
  expect(f.stream.listenerCount('drain')).toBe(0);
  expect(f.stream.listenerCount('close')).toBe(0);
  expect(f.stream.listenerCount('error')).toBe(1);
  f.complete(); expect(() => f.io.input(Buffer.from('successor'))).toThrow('closed');
  expect(f.writes).toHaveLength(1); f.stream.end();
});
it('bounds a native pipe that never drains and does not rearm from a late drain', async () => {
  vi.useFakeTimers();
  const f = sink(true); f.io.input(Buffer.from('original'));
  const waiting = f.io.drained().catch(cause => cause);
  await vi.advanceTimersByTimeAsync(NATIVE_IO_WAIT_MS);
  expect(await waiting).toMatchObject({message: expect.stringContaining('expired')});
  expect(f.io.stopped).toBe(true); expect(f.stream.listenerCount('drain')).toBe(0);
  expect(f.stream.listenerCount('close')).toBe(0); expect(f.stream.listenerCount('error')).toBe(1);
  f.complete(); f.stream.emit('drain');
  expect(() => f.io.input(Buffer.from('retry'))).toThrow('closed');
  expect(f.writes).toHaveLength(1); expect(vi.getTimerCount()).toBe(0); f.stream.end();
});
it('settles and permanently denies original stream error/close during a credit wait', async () => {
  const f = sink(true); f.io.input(Buffer.from('original'));
  const waiting = f.io.drained(); f.stream.destroy(new Error('fixture original pipe failure'));
  await expect(waiting).rejects.toThrow('closed');
  expect(f.io.stopped).toBe(true); expect(f.stream.listenerCount('drain')).toBe(0);
  expect(f.stream.listenerCount('close')).toBe(0); expect(f.stream.listenerCount('error')).toBe(1);
  expect(f.writes).toHaveLength(1);
});
it('never converts a falsy credit-observation failure into successful buffer credit', async () => {
  const f = sink(); let reads = 0;
  Object.defineProperty(f.stream, 'writableNeedDrain', {get() {if (++reads > 1) throw 0; return true;}});
  const result = await f.io.drained().then(() => ({accepted: true}), cause => ({accepted: false, cause}));
  expect(result).toEqual({accepted: false, cause: 0});
  expect(f.io.stopped).toBe(true);
  expect(f.stream.listenerCount('drain')).toBe(0); expect(f.stream.listenerCount('close')).toBe(0);
  expect(f.writes).toHaveLength(0); f.io.stop(); f.stream.destroy();
});
