/**
 * route-frames-v1: the frames between this server and a Rust route handler child on its stdin and
 * stdout. It mirrors `reverie-contracts::route_frames_v1`; both read the shared cases in
 * crates/reverie-contracts/tests/fixtures/route-frames-v1/cases.json, so neither can drift alone.
 *
 * A frame is a big-endian u32 length, an 18-byte header (u8 version, u8 kind, u64 generation, u64 id)
 * and the kind's payload. The reader checks the length against its direction after 4 bytes and against
 * the kind after 6, so it never waits for, or holds, a frame it would refuse.
 */

export const VERSION = 1;
export const HEADER_BYTES = 18;
export const SUBSCRIPTION_PROFILES = 'GET /api/subscription-profiles';
export const SETTINGS = 'GET /api/settings';

/** The finite media a typed response may name; mirrors `route_frames_v1::Media`. */
export const MEDIA = {
  1: 'application/json; charset=utf-8',
  2: 'text/plain; charset=utf-8',
} as const;
export type Media = keyof typeof MEDIA;

export type Direction = 'to_handler' | 'to_front';
export type Provider = 'anthropic' | 'openai';
export type Observation = 'subscription_modes';

export type Body =
  | { kind: 'request'; route: string; json: Buffer }
  | { kind: 'response'; status: number; body: Buffer }
  | { kind: 'refusal'; code: string }
  | { kind: 'cancel' }
  | { kind: 'observe'; observation: Observation; providers: Provider[] }
  | { kind: 'observed'; observation: Observation; json: Buffer }
  | { kind: 'typed_response'; media: Media; status: number; body: Buffer };

export interface Frame {
  generation: bigint;
  id: bigint;
  body: Body;
}

type Kind = Body['kind'];

/** A request's route key is 1 to MAX_ROUTE_BYTES ASCII bytes, behind a one-byte length. */
const MAX_ROUTE_BYTES = 64;

const KINDS: Record<Kind, { byte: number; direction: Direction; lengths: [number, number] }> = {
  request: {
    byte: 1,
    direction: 'to_handler',
    lengths: [HEADER_BYTES + 2, HEADER_BYTES + 1 + MAX_ROUTE_BYTES + 65536],
  },
  response: { byte: 2, direction: 'to_front', lengths: [HEADER_BYTES + 2, HEADER_BYTES + 2 + 8 * 1024 * 1024] },
  refusal: { byte: 3, direction: 'to_front', lengths: [HEADER_BYTES + 1, HEADER_BYTES + 64] },
  cancel: { byte: 4, direction: 'to_handler', lengths: [HEADER_BYTES, HEADER_BYTES] },
  observe: { byte: 5, direction: 'to_front', lengths: [HEADER_BYTES + 3, HEADER_BYTES + 4] },
  observed: { byte: 6, direction: 'to_handler', lengths: [HEADER_BYTES + 2, HEADER_BYTES + 1 + 65536] },
  typed_response: { byte: 7, direction: 'to_front', lengths: [HEADER_BYTES + 3, HEADER_BYTES + 3 + 8 * 1024 * 1024] },
};

/** The largest length any frame read in `direction` may declare. */
export function maxLength(direction: Direction): number {
  return Math.max(
    ...Object.values(KINDS)
      .filter((kind) => kind.direction === direction)
      .map((kind) => kind.lengths[1])
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

const PROVIDERS: Provider[] = ['anthropic', 'openai'];
const OBSERVATION_BYTE = 1;

function body(kind: Kind, payload: Buffer): Body {
  const refuse = (): never => {
    throw new FrameError('FRAME_PAYLOAD');
  };
  switch (kind) {
    case 'request': {
      const length = payload[0];
      if (length === 0 || length > MAX_ROUTE_BYTES || payload.length - 1 < length) refuse();
      const route = payload.subarray(1, 1 + length);
      if (route.some((byte) => byte > 0x7f)) refuse();
      return { kind, route: route.toString('latin1'), json: Buffer.from(payload.subarray(1 + length)) };
    }
    case 'response':
      return { kind, status: payload.readUInt16BE(0), body: Buffer.from(payload.subarray(2)) };
    case 'refusal':
      if (!payload.every((byte) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f))
        refuse();
      return { kind, code: payload.toString('latin1') };
    case 'cancel':
      return { kind };
    case 'observe': {
      const [observation, count, ...codes] = payload;
      if (observation !== OBSERVATION_BYTE || count < 1 || count > 2 || codes.length !== count) refuse();
      const providers = codes.map((code) => PROVIDERS[code - 1] ?? refuse());
      if (providers.length === 2 && providers[0] === providers[1]) refuse();
      return { kind, observation: 'subscription_modes', providers };
    }
    case 'observed':
      if (payload[0] !== OBSERVATION_BYTE) refuse();
      return { kind, observation: 'subscription_modes', json: Buffer.from(payload.subarray(1)) };
    case 'typed_response': {
      const media = payload[0];
      if (!Object.hasOwn(MEDIA, media)) refuse();
      return { kind, media: media as Media, status: payload.readUInt16BE(1), body: Buffer.from(payload.subarray(3)) };
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
    if (!kind || KINDS[kind].direction !== this.direction) throw new FrameError('FRAME_KIND');
    const [min, max] = KINDS[kind].lengths;
    if (length < min || length > max) throw new FrameError('FRAME_LENGTH');
    if (this.size < 4 + length) return undefined;
    const wire = this.head(4 + length);
    const generation = wire.readBigUInt64BE(6);
    const id = wire.readBigUInt64BE(14);
    if (generation === 0n || id === 0n) throw new FrameError('FRAME_IDENTITY');
    const frame = { generation, id, body: body(kind, wire.subarray(22, 4 + length)) };
    const rest = wire.subarray(4 + length);
    this.chunks = rest.length > 0 ? [Buffer.from(rest), ...this.chunks.slice(1)] : this.chunks.slice(1);
    this.size -= 4 + length;
    return frame;
  }
}

/** `text` as one byte per character. Anything beyond ASCII is refused here, because Node's one-byte
 * encodings keep only a character's low byte, which could turn it into another valid string. */
function ascii(text: string): Buffer {
  if (![...text].every((character) => character.charCodeAt(0) <= 0x7f)) throw new FrameError('FRAME_PAYLOAD');
  return Buffer.from(text, 'latin1');
}

function payload(frame: Body): Buffer {
  switch (frame.kind) {
    case 'request': {
      const route = ascii(frame.route);
      // Checked before the one-byte length is written, which would wrap a longer route into the JSON.
      if (route.length === 0 || route.length > MAX_ROUTE_BYTES) throw new FrameError('FRAME_PAYLOAD');
      return Buffer.concat([Buffer.from([route.length]), route, frame.json]);
    }
    case 'response': {
      const status = Buffer.alloc(2);
      status.writeUInt16BE(frame.status);
      return Buffer.concat([status, frame.body]);
    }
    case 'refusal':
      return ascii(frame.code);
    case 'cancel':
      return Buffer.alloc(0);
    case 'observe':
      return Buffer.from([
        OBSERVATION_BYTE,
        frame.providers.length,
        ...frame.providers.map((p) => PROVIDERS.indexOf(p) + 1),
      ]);
    case 'observed':
      return Buffer.concat([Buffer.from([OBSERVATION_BYTE]), frame.json]);
    case 'typed_response': {
      const head = Buffer.alloc(3);
      head[0] = frame.media;
      head.writeUInt16BE(frame.status, 1);
      return Buffer.concat([head, frame.body]);
    }
  }
}

/** The wire bytes of `frame`, or the error its reader would refuse them with. */
export function encode(frame: Frame): Buffer {
  const content = payload(frame.body);
  const wire = Buffer.alloc(4 + HEADER_BYTES + content.length);
  wire.writeUInt32BE(HEADER_BYTES + content.length, 0);
  wire[4] = VERSION;
  wire[5] = KINDS[frame.body.kind].byte;
  wire.writeBigUInt64BE(frame.generation, 6);
  wire.writeBigUInt64BE(frame.id, 14);
  content.copy(wire, 22);
  decode(wire, KINDS[frame.body.kind].direction);
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
