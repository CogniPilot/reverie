/** A fixed broker purpose: fetch authorized images into the current laptop.
 * No arbitrary command, URL, credential, host path or lifecycle operation.
 */
import { lstat, realpath } from 'node:fs/promises';
import net from 'node:net';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const GENERATION = /^[0-9a-f]{64}$/;
const LOCAL_IMAGE = /^\/tmp\/\.reverie-chat-images\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const PURPOSE = 'chat-image-paths-v1';

export interface ImageScope {
  sessionId: string;
  roomId: string;
  messageId: string;
  fileIds: string[];
}
export interface LocalChatImage {
  fileId: string;
  path: string;
  bytes: number;
  expiresInSeconds: number;
}
export type ImagePathResult =
  | { status: 'ready'; files: LocalChatImage[]; generation: string }
  | { status: 'unavailable' };

type Exchange = (value: Record<string, unknown>) => Promise<unknown>;

async function brokerRequest(value: Record<string, unknown>): Promise<unknown> {
  const path = process.env.REVERIE_WORKER_SOCKET;
  if (!path) throw new Error('image broker unavailable');
  const info = await lstat(path);
  if (
    !info.isSocket() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    throw new Error('image broker unavailable');
  const request = Buffer.from(JSON.stringify(value));
  if (request.length > 4096) throw new Error('image request refused');
  const frame = Buffer.alloc(5 + request.length);
  frame[0] = 'M'.charCodeAt(0);
  frame.writeUInt32BE(request.length, 1);
  request.copy(frame, 5);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const deadline = setTimeout(() => finish(new Error('image broker timeout')), 45_000);
    function finish(error?: Error, result?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.once('connect', () => socket.end(frame));
    socket.on('data', (part: Buffer) => {
      if (bytes.length + part.length > 8197) {
        finish(new Error('image broker response refused'));
        return;
      }
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length < 5) return;
      const size = bytes.readUInt32BE(1);
      if (size > 8192 || bytes[0] !== 'J'.charCodeAt(0)) {
        finish(new Error('image unavailable'));
        return;
      }
      if (bytes.length < size + 5) return;
      if (bytes.length !== size + 5) {
        finish(new Error('image broker response refused'));
        return;
      }
      try {
        finish(undefined, JSON.parse(bytes.subarray(5).toString('utf8')));
      } catch {
        finish(new Error('image broker response refused'));
      }
    });
    socket.once('error', () => finish(new Error('image broker unavailable')));
    socket.once('close', () => {
      if (!settled) finish(new Error('image broker response unconfirmed'));
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function materializeChatImages(
  scope: ImageScope,
  exchange: Exchange = brokerRequest
): Promise<ImagePathResult> {
  if (
    ![scope.sessionId, scope.roomId, scope.messageId, ...scope.fileIds].every((id) => UUID.test(id)) ||
    scope.fileIds.length < 1 ||
    scope.fileIds.length > 4 ||
    new Set(scope.fileIds).size !== scope.fileIds.length
  )
    return { status: 'unavailable' };
  try {
    const binding = await exchange({ purpose: PURPOSE, action: 'binding', sessionId: scope.sessionId });
    if (
      !record(binding) ||
      binding.version !== 1 ||
      binding.status !== 'bound' ||
      binding.sessionId !== scope.sessionId ||
      typeof binding.generation !== 'string' ||
      !GENERATION.test(binding.generation)
    )
      return { status: 'unavailable' };
    const generation = binding.generation;
    const result = await exchange({
      purpose: PURPOSE,
      action: 'materialize',
      sessionId: scope.sessionId,
      request: { version: 1, ...scope, generation },
    });
    if (
      !record(result) ||
      result.version !== 1 ||
      result.status !== 'ready' ||
      result.generation !== generation ||
      result.sessionId !== scope.sessionId ||
      result.roomId !== scope.roomId ||
      result.messageId !== scope.messageId ||
      !Array.isArray(result.files) ||
      result.files.length !== scope.fileIds.length
    )
      return { status: 'unavailable' };
    const files: LocalChatImage[] = [];
    let total = 0;
    for (const item of result.files) {
      if (
        !record(item) ||
        typeof item.fileId !== 'string' ||
        !scope.fileIds.includes(item.fileId) ||
        files.some((file) => file.fileId === item.fileId) ||
        typeof item.path !== 'string' ||
        !LOCAL_IMAGE.test(item.path) ||
        typeof item.bytes !== 'number' ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 1 ||
        item.bytes > 8 * 1024 * 1024 ||
        typeof item.expiresInSeconds !== 'number' ||
        !Number.isSafeInteger(item.expiresInSeconds) ||
        item.expiresInSeconds < 1 ||
        item.expiresInSeconds > 1800
      )
        return { status: 'unavailable' };
      total += item.bytes;
      files.push({ fileId: item.fileId, path: item.path, bytes: item.bytes, expiresInSeconds: item.expiresInSeconds });
    }
    return total <= 16 * 1024 * 1024 ? { status: 'ready', generation, files } : { status: 'unavailable' };
  } catch {
    // Broker errors may carry host paths or private runtime metadata. Never echo them.
    return { status: 'unavailable' };
  }
}

/** Supported raster types only; SVG and every non-image stay ordinary attachments. */
export function isChatRaster(file: { type: string }): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type);
}

/** Validate the public API shape again in the laptop CLI before advertising paths. */
export function localImageFiles(value: unknown, ids: string[]): LocalChatImage[] {
  if (!record(value) || value.status !== 'ready' || !Array.isArray(value.files) || value.files.length !== ids.length)
    return [];
  const files: LocalChatImage[] = [];
  for (const item of value.files) {
    if (
      !record(item) ||
      typeof item.fileId !== 'string' ||
      !ids.includes(item.fileId) ||
      files.some((file) => file.fileId === item.fileId) ||
      typeof item.path !== 'string' ||
      !LOCAL_IMAGE.test(item.path) ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > 8388608 ||
      typeof item.expiresInSeconds !== 'number' ||
      !Number.isInteger(item.expiresInSeconds) ||
      item.expiresInSeconds < 1 ||
      item.expiresInSeconds > 1800
    )
      return [];
    files.push(item as unknown as LocalChatImage);
  }
  return files.reduce((sum, file) => sum + file.bytes, 0) <= 16777216 ? files : [];
}
