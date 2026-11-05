/**
 * The TS route-frames-v1 reader against the shared cases that the Rust reader also decodes
 * (crates/reverie-contracts/tests/route_frames_goldens.rs).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FrameError, FrameReader, decode, encode, type Direction, type Frame } from '../../src/rust-routes/frames.js';

// The Nix web derivation is flattened to apps/web, so package.nix copies the cases into test/fixtures.
const copied = resolve(import.meta.dirname, '../fixtures/route-frames-v1');
const source = resolve(import.meta.dirname, '../../../../crates/reverie-contracts/tests/fixtures/route-frames-v1');
const fixtures = existsSync(join(copied, 'cases.json')) ? copied : source;

// Generation and id are decimal strings: a JSON number cannot carry every u64.
type Expect = Record<string, unknown> & { kind: string; generation: string; id: string };
type Case = { name: string; direction: Direction; hex: string; expect?: Expect; error?: string };
type Boundary = {
  direction: Direction;
  kind: number;
  route_len?: number;
  json_len?: number;
  body_len?: number;
  error?: string;
};
const { cases, boundaries } = JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as {
  cases: Case[];
  boundaries: Record<string, Boundary>;
};

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof FrameError) return error.code;
    throw error;
  }
}

function expected(expect: Expect): Frame {
  const hex = (key: string) => Buffer.from(String(expect[key]), 'hex');
  const identity = { generation: BigInt(expect.generation), id: BigInt(expect.id) };
  switch (expect.kind) {
    case 'request':
      return { ...identity, body: { kind: 'request', route: String(expect.route), json: hex('json_hex') } };
    case 'response':
      return { ...identity, body: { kind: 'response', status: Number(expect.status), body: hex('body_hex') } };
    case 'refusal':
      return { ...identity, body: { kind: 'refusal', code: String(expect.code) } };
    case 'cancel':
      return { ...identity, body: { kind: 'cancel' } };
    case 'observe':
      return {
        ...identity,
        body: { kind: 'observe', observation: 'subscription_modes', providers: expect.providers as never },
      };
    case 'observed':
      return { ...identity, body: { kind: 'observed', observation: 'subscription_modes', json: hex('json_hex') } };
  }
  throw new Error(`unknown kind ${expect.kind}`);
}

describe('route-frames-v1 TS reader', () => {
  it('agrees with every shared case and re-encodes byte for byte', () => {
    expect(cases.length).toBeGreaterThan(30);
    for (const testCase of cases) {
      const wire = Buffer.from(testCase.hex, 'hex');
      if (testCase.error) {
        expect(
          errorCode(() => decode(wire, testCase.direction)),
          testCase.name
        ).toBe(testCase.error);
        continue;
      }
      const frame = expected(testCase.expect as Expect);
      expect(decode(wire, testCase.direction), testCase.name).toEqual(frame);
      expect(encode(frame).equals(wire), testCase.name).toBe(true);
    }
  });

  it('accepts each kind maximum and refuses one more byte', () => {
    for (const [name, spec] of Object.entries(boundaries)) {
      let payload: Buffer;
      if (spec.kind === 1)
        payload = Buffer.concat([
          Buffer.from([spec.route_len ?? 0]),
          Buffer.alloc(spec.route_len ?? 0, 0x52),
          Buffer.alloc(spec.json_len ?? 0, 0x20),
        ]);
      else if (spec.kind === 2)
        payload = Buffer.concat([Buffer.from([0, 200]), Buffer.alloc(spec.body_len ?? 0, 0x20)]);
      else payload = Buffer.concat([Buffer.from([1]), Buffer.alloc(spec.json_len ?? 0, 0x20)]);
      const wire = Buffer.alloc(4 + 18 + payload.length);
      wire.writeUInt32BE(18 + payload.length, 0);
      wire[4] = 1;
      wire[5] = spec.kind;
      wire.writeBigUInt64BE(1n, 6);
      wire.writeBigUInt64BE(1n, 14);
      payload.copy(wire, 22);
      expect(
        errorCode(() => decode(wire, spec.direction)),
        name
      ).toBe(spec.error);
    }
  });

  it('reads frames split at every byte and refuses an oversize length after four bytes', () => {
    const wires = cases.filter((c) => !c.error && c.direction === 'to_front').map((c) => Buffer.from(c.hex, 'hex'));
    const stream = Buffer.concat(wires);
    const reader = new FrameReader('to_front');
    const frames = [...stream].flatMap((byte) => reader.push(Buffer.from([byte])));
    reader.end();
    expect(frames.map((frame) => encode(frame).toString('hex'))).toEqual(wires.map((wire) => wire.toString('hex')));

    const oversize = new FrameReader('to_handler');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(65620);
    expect(errorCode(() => oversize.push(length))).toBe('FRAME_LENGTH');
  });
});
