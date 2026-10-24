import { basename, isAbsolute, join } from 'node:path';
import { envValue } from './config/reverie-env.js';

/** The owner-selected shared drive is mounted at the same path in the website and laptops. */
export function sharedAttachmentsRoot(): string | undefined {
  const path = envValue(process.env, 'SHARED_ATTACHMENTS_PATH');
  return path && isAbsolute(path) ? path : undefined;
}

export function sharedAttachmentPath(roomId: string, attachment: { id: string; path: string }): string {
  const root = sharedAttachmentsRoot();
  const name = basename(attachment.path);
  if (!root || !/^[A-Za-z0-9-]{1,64}$/.test(roomId) || !name.startsWith(attachment.id + '-')) return attachment.path;
  return join(root, roomId, name);
}

export function sharedWorkspaceRoot(): string | undefined {
  const path = envValue(process.env, 'SHARED_WORKSPACE_PATH');
  return path && isAbsolute(path) ? path : undefined;
}
