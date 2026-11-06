/**
 * The TS route-frames-v2 reader and connection rules against the shared cases that the Rust codec also
 * runs (crates/reverie-contracts/tests/route_frames_v2_goldens.rs).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FrameError,
  FrameReader,
  decode,
  encode,
  maxLength,
  type Body,
  type Direction,
  type Frame,
} from '../../src/rust-front/frames.js';
import { ConnFault, ConnTable, type ConnFrame, type Received } from '../../src/rust-front/conn-table.js';

// The Nix web derivation is flattened to apps/web, so package.nix copies the cases into test/fixtures.
const copied = resolve(import.meta.dirname, '../fixtures/route-frames-v2');
const source = resolve(import.meta.dirname, '../../../../crates/reverie-contracts/tests/fixtures/route-frames-v2');
const fixtures = existsSync(join(copied, 'cases.json')) ? copied : source;

// Generation and id are decimal strings: a JSON number cannot carry every u64.
type Expect = Record<string, unknown> & { kind: Body['kind']; generation: string; id: string };
type Case = { name: string; direction: Direction; hex: string; expect?: Expect; error?: string };
type Boundary = {
  direction: Direction;
  kind: number;
  host_len?: number;
  errno_len?: number;
  message_len?: number;
  data_len?: number;
  error?: string;
};
type Step = {
  op: 'open_next' | 'receive' | 'send';
  id?: number;
  frame?: ConnFrame;
  expect?: number | boolean | Received;
  error?: string;
};
type Sequence = { name: string; max_open: number; steps: Step[]; open_count: number };
const { cases, boundaries, conn, max_lengths } = JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as {
  cases: Case[];
  boundaries: Record<string, Boundary>;
  conn: Sequence[];
  max_lengths: Record<Direction, number>;
};

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof FrameError || error instanceof ConnFault) return error.code;
    throw error;
  }
}

function expected(expect: Expect): Frame {
  const { kind, generation, id, ...fields } = expect;
  const body = (
    kind === 'data' ? { kind, bytes: Buffer.from(String(fields.bytes_hex), 'hex') } : { kind, ...fields }
  ) as Body;
  return { generation: BigInt(generation), id: BigInt(id), body };
}

const identity = { generation: 1n, id: 0n };

describe('route-frames-v2 TS reader', () => {
  it('agrees with every shared case and re-encodes byte for byte', () => {
    expect(cases.length).toBeGreaterThan(50);
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
      expect(encode(frame, testCase.direction).equals(wire), testCase.name).toBe(true);
    }
  });

  it('has the shared direction maxima', () => {
    expect({ to_front: maxLength('to_front'), to_ts: maxLength('to_ts') }).toEqual(max_lengths);
  });

  it('accepts each field limit and refuses one more byte', () => {
    for (const [name, spec] of Object.entries(boundaries)) {
      let id = 0n;
      let payload: Buffer;
      if (spec.kind === 1)
        payload = Buffer.concat([
          Buffer.from([0, 0, 0, 80, (spec.host_len ?? 0) & 0xff]),
          Buffer.alloc(spec.host_len ?? 0, 0x68),
        ]);
      else if (spec.kind === 3)
        payload = Buffer.concat([
          Buffer.from([0, (spec.errno_len ?? 0) & 0xff]),
          Buffer.alloc(spec.errno_len ?? 0, 0x45),
          Buffer.alloc(spec.message_len ?? 0, 0x6d),
        ]);
      else {
        id = 1n;
        payload = Buffer.alloc(spec.data_len ?? 0, 0xab);
      }
      const wire = Buffer.alloc(4 + 18 + payload.length);
      wire.writeUInt32BE(18 + payload.length, 0);
      wire[4] = 2;
      wire[5] = spec.kind;
      wire.writeBigUInt64BE(1n, 6);
      wire.writeBigUInt64BE(id, 14);
      payload.copy(wire, 22);
      expect(
        errorCode(() => decode(wire, spec.direction)),
        name
      ).toBe(spec.error);
    }
  });

  it('reads frames split at every byte in both directions and refuses an oversize length after four bytes', () => {
    for (const direction of ['to_front', 'to_ts'] as const) {
      const wires = cases.filter((c) => !c.error && c.direction === direction).map((c) => Buffer.from(c.hex, 'hex'));
      const reader = new FrameReader(direction);
      const frames = [...Buffer.concat(wires)].flatMap((byte) => reader.push(Buffer.from([byte])));
      reader.end();
      expect(frames.map((frame) => encode(frame, direction).toString('hex'))).toEqual(
        wires.map((wire) => wire.toString('hex'))
      );

      const oversize = new FrameReader(direction);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(maxLength(direction) + 1);
      expect(errorCode(() => oversize.push(length))).toBe('FRAME_LENGTH');
    }
  });

  it('refuses a frame its one-byte lengths or address family cannot carry exactly', () => {
    const refused: [Frame, Direction][] = [
      // 256 bytes would wrap the host length to 0, and 257 to a 1-byte host with the rest trailing.
      ...[0, 256, 257].map((length): [Frame, Direction] => [
        {
          ...identity,
          body: { kind: 'bind_request', listener: 'main', tls: false, port: 1, host: 'h'.repeat(length) },
        },
        'to_front',
      ]),
      // 255 bytes of host, but 510 bytes of UTF-8.
      [
        { ...identity, body: { kind: 'bind_request', listener: 'main', tls: false, port: 1, host: 'é'.repeat(255) } },
        'to_front',
      ],
      // 289 would wrap to a 33-byte errno; 257 to a 1-byte errno followed by 256 bytes read as the message.
      ...[33, 257, 289].map((length): [Frame, Direction] => [
        { ...identity, body: { kind: 'bind_failed', listener: 'main', errno: 'E'.repeat(length), message: '' } },
        'to_ts',
      ]),
      [{ ...identity, body: { kind: 'bind_failed', listener: 'main', errno: 'Eacces', message: '' } }, 'to_ts'],
      [{ ...identity, body: { kind: 'bind_failed', listener: 'main', errno: 'E', message: 'm'.repeat(513) } }, 'to_ts'],
      [{ ...identity, body: { kind: 'bound', listener: 'other' as never, port: 1 } }, 'to_ts'],
      [{ ...identity, body: { kind: 'bound', listener: 'main', port: 65536 } }, 'to_ts'],
      [{ ...identity, body: { kind: 'shutdown', signal: 'SIGKILL' as never } }, 'to_ts'],
      [{ generation: 1n, id: 1n, body: { kind: 'credit', bytes: 0 } }, 'to_front'],
      [{ generation: 1n, id: 1n, body: { kind: 'abort', reason: 'other' as never } }, 'to_front'],
    ];
    const open = (peer: string, local: string): [Frame, Direction] => [
      {
        generation: 1n,
        id: 1n,
        body: {
          kind: 'conn_open',
          listener: 'main',
          peer: { address: peer, port: 1 },
          local: { address: local, port: 2 },
          encrypted: false,
        },
      },
      'to_ts',
    ];
    // Mixed families, a name, and IPv6 text that is not the form Node and the Rust front report.
    refused.push(
      open('127.0.0.1', '::1'),
      open('localhost', '127.0.0.1'),
      open('::0001', '::1'),
      open('FD00::7', '::1'),
      open('1:2:3:4:5:6:7.8.9.10', '::1')
    );
    for (const [frame, direction] of refused)
      expect(
        errorCode(() => encode(frame, direction)),
        JSON.stringify(frame, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 120)
      ).toMatch(/^FRAME_(PAYLOAD|LENGTH)$/);
  });
});

describe('route-frames-v2 TS connection rules', () => {
  it('run every shared sequence', () => {
    expect(conn.length).toBeGreaterThan(5);
    for (const sequence of conn) {
      const table = new ConnTable(sequence.max_open);
      sequence.steps.forEach((step, at) => {
        const label = `${sequence.name} step ${at}`;
        let outcome: unknown;
        const code = errorCode(() => {
          if (step.op === 'open_next') outcome = Number(table.openNext());
          else if (step.op === 'receive') outcome = table.receive(BigInt(step.id ?? 0), step.frame as ConnFrame);
          else outcome = table.send(BigInt(step.id ?? 0), step.frame as ConnFrame);
        });
        expect(code, label).toBe(step.error);
        if (!step.error) expect(outcome, label).toEqual(step.expect);
      });
      expect(table.openCount, sequence.name).toBe(sequence.open_count);
    }
  });
});
