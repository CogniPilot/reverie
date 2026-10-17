import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExternalChatState } from './external-chat-types.js';

export async function loadExternalChat(file: string): Promise<ExternalChatState> {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8')) as ExternalChatState;
    if (
      state.version !== 1 ||
      !Array.isArray(state.connections) ||
      !Array.isArray(state.links) ||
      !Array.isArray(state.deliveries)
    ) {
      throw new Error('Unsupported external chat state');
    }
    // A process may have died after the platform accepted the request. Never replay it.
    for (const delivery of state.deliveries)
      if (delivery.state === 'sending') {
        delivery.state = 'unknown';
        delivery.error = 'Process stopped during send; delivery may have succeeded. Check the external channel.';
      }
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, connections: [], links: [], deliveries: [] };
    throw new Error('Cannot load external chat state; refusing to reset delivery cursors');
  }
}

export async function saveExternalChat(file: string, state: ExternalChatState): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
