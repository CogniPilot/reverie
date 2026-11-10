/** Shared framing and private-socket checks for the existing fixed B/Q roles.
 * Authentication and consent remain with each actual retained owner context.
 */
import { Socket } from 'node:net';
import { lstat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

const MAX_FRAME = 8192;
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
    greeting: 'FLEET_MAINTENANCE_CHANNEL_V1\n',
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
    raw = Buffer.from(JSON.stringify({ purpose: selected.purpose, version: 1 })),
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
    this.#buffer = Buffer.concat([this.#buffer, data]);
    need(this.#buffer.length <= MAX_FRAME * 2);
    if (!this.#greeted) {
      const end = this.#buffer.indexOf(10);
      if (end < 0) {
        need(this.#buffer.length <= 64);
        return;
      }
      need(this.#buffer.subarray(0, end + 1).toString() === roles[this.role].greeting);
      this.#buffer = this.#buffer.subarray(end + 1);
      this.#greeted = true;
      ready();
    }
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32BE(0);
      need(size > 0 && size <= MAX_FRAME);
      if (this.#buffer.length < size + 4) break;
      const raw = this.#buffer.subarray(4, size + 4);
      this.#buffer = this.#buffer.subarray(size + 4);
      frame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    }
  }
}
