/** Owner-controlled instance settings. Never import browser preferences as grants. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { dataPath } from './config/instance.js';

export const ChatPluginSettingsSchema = z
  .object({
    latex: z.boolean(),
    python: z.boolean(),
    modelica: z.boolean(),
  })
  .strict();
export type ChatPluginSettings = z.infer<typeof ChatPluginSettingsSchema>;
const defaults = (): ChatPluginSettings => ({ latex: false, python: false, modelica: false });

export class ChatPluginSettingsStore {
  private settings = defaults();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly path = dataPath('chat-plugins.json')) {
    try {
      this.settings = ChatPluginSettingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // A missing or malformed file cannot grant a plugin at startup.
    }
  }
  read(): ChatPluginSettings {
    return { ...this.settings };
  }
  save(input: unknown): Promise<ChatPluginSettings> {
    const settings = ChatPluginSettingsSchema.parse(input);
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
          await writeFile(temporary, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.path);
          this.settings = { ...settings };
          return this.read();
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.pending = task;
    return task;
  }
}
