import { expect, it } from 'vitest';
import { NativeOwnerFrames, FLEET_REPLY_MAX_FRAME } from '../src/native-owner-channel.js';

function wire(size: number): Buffer {
  const raw = Buffer.from(JSON.stringify({ padding: 'x'.repeat(size - 14) }));
  expect(raw.length).toBe(size);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length);
  return Buffer.concat([header, raw]);
}
it('accepts the exact negotiated fleet output budget across arbitrary chunk boundaries', () => {
  expect(FLEET_REPLY_MAX_FRAME).toBe(65_536);
  const frames = new NativeOwnerFrames('fleet-maintenance');
  let ready = 0,
    count = 0;
  frames.accept(
    Buffer.from('FLEET_MAINTENANCE_CHANNEL_V2\n'),
    () => ready++,
    () => count++
  );
  const raw = wire(FLEET_REPLY_MAX_FRAME);
  for (let offset = 0; offset < raw.length; offset += 997)
    frames.accept(
      raw.subarray(offset, offset + 997),
      () => ready++,
      () => count++
    );
  expect([ready, count]).toEqual([1, 1]);
  expect(() =>
    frames.accept(
      wire(FLEET_REPLY_MAX_FRAME + 1),
      () => ready++,
      () => count++
    )
  ).toThrow();
  expect(count).toBe(1);
});
it('retains the 8 KiB pool-registration budget', () => {
  const frames = new NativeOwnerFrames('pool-registration');
  let count = 0;
  frames.accept(
    Buffer.from('POOL_REGISTRATION_CHANNEL_V1\n'),
    () => {},
    () => count++
  );
  frames.accept(
    wire(8192),
    () => {},
    () => count++
  );
  expect(count).toBe(1);
  expect(() =>
    frames.accept(
      wire(8193),
      () => {},
      () => count++
    )
  ).toThrow();
  expect(count).toBe(1);
});
it('never downgrades to an old broker greeting or consumes a preview after upgrade refusal', () => {
  for (const greeting of [
    Buffer.from('FLEET_MAINTENANCE_CHANNEL_V1\n'),
    (() => {
      const body = Buffer.from('FLEET_REPLY_CODEC_UPGRADE_REQUIRED');
      const header = Buffer.alloc(5);
      header[0] = 69;
      header.writeUInt32BE(body.length, 1);
      return Buffer.concat([header, body]);
    })(),
  ]) {
    let ready = 0,
      count = 0;
    const frames = new NativeOwnerFrames('fleet-maintenance');
    expect(() =>
      frames.accept(
        greeting,
        () => ready++,
        () => count++
      )
    ).toThrow('FLEET_REPLY_CODEC_UPGRADE_REQUIRED');
    expect([ready, count]).toEqual([0, 0]);
  }
});
