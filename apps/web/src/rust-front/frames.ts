/**
 * route-frames-v2: the frames between the Rust front and this server on the inherited fd 3 channel.
 * It mirrors `reverie-contracts::route_frames_v2`; both read the shared cases in
 * crates/reverie-contracts/tests/fixtures/route-frames-v2/cases.json, so neither can drift alone.
 *
 * A frame is a big-endian u32 length, an 18-byte header (u8 version, u8 kind, u64 generation, u64 id)
 * and the kind's payload. Lifecycle frames carry id 0; connection frames carry the id the front gave
 * the connection in `conn_open`. The reader checks the length against its direction after 4 bytes and
 * against the kind after 6, so it never waits for, or holds, a frame it would refuse.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { isDeepStrictEqual } from 'node:util';

export const VERSION = 2;
export const HEADER_BYTES = 18;
export const MAX_DATA_BYTES = 64 * 1024;
export const MAX_HOST_BYTES = 255;
export const MAX_ERRNO_BYTES = 32;
export const MAX_MESSAGE_BYTES = 512;
const CONN_OPEN_BYTES = 39;

/** `to_front` is this server writing to the Rust front; `to_ts` is the front writing to us. */
export type Direction = 'to_front' | 'to_ts';
export type Listener = 'main' | 'bridge';
export type Signal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';
export type AbortReason = 'peer_reset' | 'destroy' | 'timeout' | 'generation';

/** A peer or local socket address as the front saw it; both in one `conn_open` share a family. */
export interface SocketFacts {
  address: string;
  port: number;
}

export type Body =
  | { kind: 'bind_request'; listener: Listener; tls: boolean; port: number; host: string }
  | { kind: 'bound'; listener: Listener; port: number }
  | { kind: 'bind_failed'; listener: Listener; errno: string; message: string }
  | { kind: 'accepting'; listener: Listener }
  | { kind: 'service_ready' }
  | { kind: 'unbind'; listener: Listener }
  | { kind: 'shutdown'; signal: Signal }
  | { kind: 'conn_open'; listener: Listener; peer: SocketFacts; local: SocketFacts; encrypted: boolean }
  | { kind: 'data'; bytes: Buffer }
  | { kind: 'end' }
  | { kind: 'abort'; reason: AbortReason }
  | { kind: 'credit'; bytes: number };

export interface Frame {
  generation: bigint;
  id: bigint;
  body: Body;
}

type Kind = Body['kind'];
const BOTH: Direction[] = ['to_front', 'to_ts'];

/** Byte, the directions that may carry it, whether it names a connection, and payload lengths. */
const KINDS: Record<Kind, { byte: number; directions: Direction[]; connection: boolean; payload: [number, number] }> = {
  bind_request: { byte: 1, directions: ['to_front'], connection: false, payload: [6, 5 + MAX_HOST_BYTES] },
  bound: { byte: 2, directions: ['to_ts'], connection: false, payload: [3, 3] },
  bind_failed: {
    byte: 3,
    directions: ['to_ts'],
    connection: false,
    payload: [3, 2 + MAX_ERRNO_BYTES + MAX_MESSAGE_BYTES],
  },
  accepting: { byte: 4, directions: ['to_front'], connection: false, payload: [1, 1] },
  service_ready: { byte: 5, directions: ['to_front'], connection: false, payload: [0, 0] },
  unbind: { byte: 6, directions: ['to_front'], connection: false, payload: [1, 1] },
  shutdown: { byte: 7, directions: ['to_ts'], connection: false, payload: [1, 1] },
  conn_open: { byte: 16, directions: ['to_ts'], connection: true, payload: [CONN_OPEN_BYTES, CONN_OPEN_BYTES] },
  data: { byte: 17, directions: BOTH, connection: true, payload: [1, MAX_DATA_BYTES] },
  end: { byte: 18, directions: BOTH, connection: true, payload: [0, 0] },
  abort: { byte: 19, directions: BOTH, connection: true, payload: [1, 1] },
  credit: { byte: 20, directions: BOTH, connection: true, payload: [4, 4] },
};

/** The largest length any frame read in `direction` may declare. */
export function maxLength(direction: Direction): number {
  return Math.max(
    ...Object.values(KINDS)
      .filter((kind) => kind.directions.includes(direction))
      .map((kind) => HEADER_BYTES + kind.payload[1])
  );
}

export type FrameErrorCode =
  | 'FRAME_TRUNCATED'
  | 'FRAME_LENGTH'
  | 'FRAME_VERSION'
  | 'FRAME_KIND'
  | 'FRAME_IDENTITY'
  | 'FRAME_PAYLOAD';

/** A frame that cannot be accepted. Every one ends the channel generation. */
export class FrameError extends Error {
  constructor(readonly code: FrameErrorCode) {
    super(code);
  }
}

const refuse = (): never => {
  throw new FrameError('FRAME_PAYLOAD');
};

/** Each one-byte enum, in wire order from its first byte. */
const LISTENERS: Listener[] = ['main', 'bridge'];
const SIGNALS: Signal[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const SIGNAL_FIRST = 1;
const ABORT_REASONS: AbortReason[] = ['peer_reset', 'destroy', 'timeout', 'generation'];

function listener(byte: number): Listener {
  return LISTENERS[byte] ?? refuse();
}

function flag(byte: number): boolean {
  if (byte > 1) refuse();
  return byte === 1;
}

/** Bytes that must be valid UTF-8; Node would otherwise substitute U+FFFD and accept them. A leading
 * U+FEFF is text like any other character here, as it is to Rust's `str::from_utf8`. */
function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse();
  }
}

function isErrno(bytes: Buffer): boolean {
  return (
    bytes.length > 0 &&
    bytes.every((byte) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f)
  );
}

/** An IPv6 address as RFC 5952 text, with IPv4-mapped addresses as `::ffff:a.b.c.d`. */
function formatIPv6(octets: Buffer): string {
  if (octets.subarray(0, 10).every((byte) => byte === 0) && octets[10] === 0xff && octets[11] === 0xff)
    return `::ffff:${[...octets.subarray(12)].join('.')}`;
  const groups = Array.from({ length: 8 }, (_, at) => octets.readUInt16BE(at * 2));
  // The first longest run of two or more zero groups becomes "::".
  let best = { start: -1, length: 1 };
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length++;
    if (length > best.length) best = { start, length };
  }
  const hex = (part: number[]) => part.map((group) => group.toString(16)).join(':');
  if (best.start < 0) return hex(groups);
  return `${hex(groups.slice(0, best.start))}::${hex(groups.slice(best.start + best.length))}`;
}

/** The 16 bytes of an address `isIPv6` accepts, including `::` and a trailing dotted quad. */
function parseIPv6(address: string): Buffer {
  let text = address;
  const tail: number[] = [];
  const quad = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad[2].split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = quad[1].endsWith('::') ? quad[1] : quad[1].slice(0, -1);
  }
  const halves = text.split('::');
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const front = parse(halves[0]);
  const back = [...(halves.length === 2 ? parse(halves[1]) : []), ...tail];
  const zeros = halves.length === 2 ? 8 - front.length - back.length : 0;
  const octets = Buffer.alloc(16);
  [...front, ...Array<number>(zeros).fill(0), ...back].forEach((group, at) => octets.writeUInt16BE(group, at * 2));
  return octets;
}

function facts(family: number, bytes: Buffer): SocketFacts {
  const octets = bytes.subarray(0, 16);
  const port = bytes.readUInt16BE(16);
  if (family === 4) {
    if (!octets.subarray(4).every((byte) => byte === 0)) refuse();
    return { address: [...octets.subarray(0, 4)].join('.'), port };
  }
  if (family === 6) return { address: formatIPv6(Buffer.from(octets)), port };
  return refuse();
}

function factsBytes(family: 4 | 6, socket: SocketFacts): Buffer {
  const bytes = Buffer.alloc(18);
  if (family === 4) Buffer.from(socket.address.split('.').map(Number)).copy(bytes);
  else parseIPv6(socket.address).copy(bytes);
  bytes.writeUInt16BE(socket.port, 16);
  return bytes;
}

function body(kind: Kind, payload: Buffer): Body {
  switch (kind) {
    case 'bind_request': {
      const length = payload[4];
      if (length === 0 || payload.length - 5 !== length) refuse();
      return {
        kind,
        listener: listener(payload[0]),
        tls: flag(payload[1]),
        port: payload.readUInt16BE(2),
        host: utf8(payload.subarray(5)),
      };
    }
    case 'bound':
      return { kind, listener: listener(payload[0]), port: payload.readUInt16BE(1) };
    case 'bind_failed': {
      const length = payload[1];
      if (length > MAX_ERRNO_BYTES || payload.length - 2 < length) refuse();
      const errno = payload.subarray(2, 2 + length);
      const message = payload.subarray(2 + length);
      if (!isErrno(errno) || message.length > MAX_MESSAGE_BYTES) refuse();
      return { kind, listener: listener(payload[0]), errno: errno.toString('latin1'), message: utf8(message) };
    }
    case 'accepting':
    case 'unbind':
      return { kind, listener: listener(payload[0]) };
    case 'service_ready':
    case 'end':
      return { kind };
    case 'shutdown':
      return { kind, signal: SIGNALS[payload[0] - SIGNAL_FIRST] ?? refuse() };
    case 'conn_open':
      return {
        kind,
        listener: listener(payload[0]),
        peer: facts(payload[1], payload.subarray(2, 20)),
        local: facts(payload[1], payload.subarray(20, 38)),
        encrypted: flag(payload[38]),
      };
    case 'data':
      return { kind, bytes: Buffer.from(payload) };
    case 'abort':
      return { kind, reason: ABORT_REASONS[payload[0]] ?? refuse() };
    case 'credit': {
      const bytes = payload.readUInt32BE(0);
      if (bytes === 0) refuse();
      return { kind, bytes };
    }
  }
}

/** Reads the frames of one stream in `direction`, however its bytes are split into chunks. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly direction: Direction) {}

  /** Appends `chunk` and returns every frame it completes; throws on the first refused frame. */
  push(chunk: Buffer): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const frames: Frame[] = [];
    for (let frame = this.take(); frame; frame = this.take()) frames.push(frame);
    return frames;
  }

  /** End of input: clean only between frames. */
  end(): void {
    if (this.size > 0) throw new FrameError('FRAME_TRUNCATED');
  }

  /** The first `bytes` buffered bytes as one buffer; joins chunks only when it must. */
  private head(bytes: number): Buffer {
    if (this.chunks[0].length < bytes) this.chunks = [Buffer.concat(this.chunks, this.size)];
    return this.chunks[0];
  }

  private take(): Frame | undefined {
    if (this.size < 4) return undefined;
    const length = this.head(4).readUInt32BE(0);
    if (length < HEADER_BYTES || length > maxLength(this.direction)) throw new FrameError('FRAME_LENGTH');
    if (this.size < 6) return undefined;
    const lead = this.head(6);
    if (lead[4] !== VERSION) throw new FrameError('FRAME_VERSION');
    const kind = (Object.keys(KINDS) as Kind[]).find((name) => KINDS[name].byte === lead[5]);
    if (!kind || !KINDS[kind].directions.includes(this.direction)) throw new FrameError('FRAME_KIND');
    const [min, max] = KINDS[kind].payload;
    if (length < HEADER_BYTES + min || length > HEADER_BYTES + max) throw new FrameError('FRAME_LENGTH');
    if (this.size < 4 + length) return undefined;
    const wire = this.head(4 + length);
    const generation = wire.readBigUInt64BE(6);
    const id = wire.readBigUInt64BE(14);
    if (generation === 0n || KINDS[kind].connection === (id === 0n)) throw new FrameError('FRAME_IDENTITY');
    const frame = { generation, id, body: body(kind, wire.subarray(22, 4 + length)) };
    const rest = wire.subarray(4 + length);
    this.chunks = rest.length > 0 ? [Buffer.from(rest), ...this.chunks.slice(1)] : this.chunks.slice(1);
    this.size -= 4 + length;
    return frame;
  }
}

function family(socket: SocketFacts): 4 | 6 {
  if (isIPv4(socket.address)) return 4;
  if (isIPv6(socket.address)) return 6;
  return refuse();
}

function u16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) refuse();
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

// Every length is checked before its one-byte field is written, which would otherwise wrap.
function payload(frame: Body): Buffer {
  switch (frame.kind) {
    case 'bind_request': {
      const host = Buffer.from(frame.host, 'utf8');
      if (host.length === 0 || host.length > MAX_HOST_BYTES) refuse();
      return Buffer.concat([
        Buffer.from([LISTENERS.indexOf(frame.listener), Number(frame.tls)]),
        u16(frame.port),
        Buffer.from([host.length]),
        host,
      ]);
    }
    case 'bound':
      return Buffer.concat([Buffer.from([LISTENERS.indexOf(frame.listener)]), u16(frame.port)]);
    case 'bind_failed': {
      const errno = Buffer.from(frame.errno, 'utf8');
      if (!isErrno(errno) || errno.length > MAX_ERRNO_BYTES) refuse();
      return Buffer.concat([
        Buffer.from([LISTENERS.indexOf(frame.listener), errno.length]),
        errno,
        Buffer.from(frame.message, 'utf8'),
      ]);
    }
    case 'accepting':
    case 'unbind':
      return Buffer.from([LISTENERS.indexOf(frame.listener)]);
    case 'service_ready':
    case 'end':
      return Buffer.alloc(0);
    case 'shutdown':
      return Buffer.from([SIGNALS.indexOf(frame.signal) + SIGNAL_FIRST]);
    case 'conn_open': {
      const shared = family(frame.peer);
      if (family(frame.local) !== shared) refuse();
      return Buffer.concat([
        Buffer.from([LISTENERS.indexOf(frame.listener), shared]),
        factsBytes(shared, frame.peer),
        factsBytes(shared, frame.local),
        Buffer.from([Number(frame.encrypted)]),
      ]);
    }
    case 'data':
      return frame.bytes;
    case 'abort':
      return Buffer.from([ABORT_REASONS.indexOf(frame.reason)]);
    case 'credit': {
      const bytes = Buffer.alloc(4);
      if (!Number.isInteger(frame.bytes) || frame.bytes < 0 || frame.bytes > 0xffffffff) refuse();
      bytes.writeUInt32BE(frame.bytes);
      return bytes;
    }
  }
}

/** The wire bytes of `frame` sent in `direction`, or the error its reader would refuse them with. */
export function encode(frame: Frame, direction: Direction): Buffer {
  const content = payload(frame.body);
  const wire = Buffer.alloc(4 + HEADER_BYTES + content.length);
  wire.writeUInt32BE(HEADER_BYTES + content.length, 0);
  wire[4] = VERSION;
  wire[5] = KINDS[frame.body.kind].byte;
  wire.writeBigUInt64BE(frame.generation, 6);
  wire.writeBigUInt64BE(frame.id, 14);
  content.copy(wire, 22);
  // An enum outside its table writes byte 255, and an address can format differently from how it was
  // given, so the frame must read back as itself.
  if (!isDeepStrictEqual(decode(wire, direction), frame)) refuse();
  return wire;
}

/** Exactly one frame from `wire`. */
export function decode(wire: Buffer, direction: Direction): Frame {
  const reader = new FrameReader(direction);
  const frames = reader.push(wire);
  reader.end();
  if (frames.length !== 1) throw new FrameError('FRAME_TRUNCATED');
  return frames[0];
}
