/** Shared framing and private-socket checks for the existing fixed B/Q roles.
 * Authentication and consent remain with each actual retained owner context.
 */
import { Socket } from 'node:net';
import { lstat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

const MAX_FRAME = 8192;
export const FLEET_REPLY_MAX_FRAME = 65_536;
export class NativeFleetPreviewRefusal extends Error {
  readonly code = 'FLEET_PREVIEW_CHANNEL_REFUSED';
  constructor() {
    super(
      'The native shared-pool preview channel was refused before any fleet consent was sent. Check that the website and native broker are compatible and host setup is available.'
    );
  }
}
export class FleetReplyCodecUpgradeRequired extends Error {
  readonly code = 'FLEET_REPLY_CODEC_UPGRADE_REQUIRED';
  constructor() {
    super(
      'FLEET_REPLY_CODEC_UPGRADE_REQUIRED: update the website and native broker together before reviewing shared-pool changes. No fleet consent was sent.'
    );
  }
}
type Role = 'pool-registration' | 'fleet-maintenance';
const roles = {
  'pool-registration': {
    opcode: 'B',
    purpose: 'host-pool-registration-v1',
    greeting: 'POOL_REGISTRATION_CHANNEL_V1\n',
  },
  'fleet-maintenance': {
    opcode: 'Q',
    purpose: 'resource-fleet-maintenance-v1',
    greeting: 'FLEET_MAINTENANCE_CHANNEL_V2\n',
  },
} as const;
function need(value: unknown): asserts value {
  if (!value) throw new Error('The original native owner channel is unavailable or changed');
}
export async function observeOwnerSocket(path: string) {
  need(isAbsolute(path) && normalize(path) === path && !/[\0\r\n]/.test(path) && process.getuid);
  const before = await lstat(path, { bigint: true });
  need(before.isSocket() && before.uid === BigInt(process.getuid()) && (before.mode & 0o077n) === 0n);
  return before;
}
export async function connectOwnerSocket(
  socket: Socket,
  path: string,
  before: Awaited<ReturnType<typeof observeOwnerSocket>>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Native owner connection expired'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect(path);
  });
  const after = await lstat(path, { bigint: true });
  need(before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid);
}
export function sendOwnerHello(socket: Socket, role: Role): void {
  const selected = roles[role],
    raw = Buffer.from(
      JSON.stringify({
        purpose: selected.purpose,
        version: 1,
        ...(role === 'fleet-maintenance' ? { replyVersion: 2 } : {}),
      })
    ),
    header = Buffer.alloc(5);
  header[0] = selected.opcode.charCodeAt(0);
  header.writeUInt32BE(raw.length, 1);
  socket.write(Buffer.concat([header, raw]));
}
export function writeOwnerFrame(socket: Socket, value: unknown): void {
  const raw = Buffer.from(JSON.stringify(value));
  need(raw.length > 0 && raw.length <= MAX_FRAME);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length);
  socket.write(Buffer.concat([header, raw]));
}
export class NativeOwnerFrames {
  #buffer = Buffer.alloc(0);
  #greeted = false;
  constructor(private readonly role: Role) {}
  accept(data: Buffer, ready: () => void, frame: (value: unknown) => void): void {
    const maximum = this.role === 'fleet-maintenance' ? FLEET_REPLY_MAX_FRAME : MAX_FRAME;
    this.#buffer = Buffer.concat([this.#buffer, data]);
    need(this.#buffer.length <= maximum * 2);
    if (!this.#greeted) {
      if (this.role === 'fleet-maintenance' && this.#buffer[0] === 69) {
        if (this.#buffer.length < 5) return;
        const size = this.#buffer.readUInt32BE(1);
        need(size > 0 && size <= 1000);
        if (this.#buffer.length < size + 5) return;
        const code = this.#buffer.subarray(5, size + 5).toString();
        if (code === 'FLEET_REPLY_CODEC_UPGRADE_REQUIRED') throw new FleetReplyCodecUpgradeRequired();
        throw new NativeFleetPreviewRefusal();
      }
      const end = this.#buffer.indexOf(10);
      if (end < 0) {
        need(this.#buffer.length <= 64);
        return;
      }
      if (
        this.role === 'fleet-maintenance' &&
        this.#buffer.subarray(0, end + 1).toString() === 'FLEET_MAINTENANCE_CHANNEL_V1\n'
      )
        throw new FleetReplyCodecUpgradeRequired();
      need(this.#buffer.subarray(0, end + 1).toString() === roles[this.role].greeting);
      this.#buffer = this.#buffer.subarray(end + 1);
      this.#greeted = true;
      ready();
    }
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32BE(0);
      need(size > 0 && size <= maximum);
      if (this.#buffer.length < size + 4) break;
      const raw = this.#buffer.subarray(4, size + 4);
      this.#buffer = this.#buffer.subarray(size + 4);
      frame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    }
  }
}
