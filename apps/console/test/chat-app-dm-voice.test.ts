/**
 * Voice controls in a direct message: the conversation shell shows car mode and read-aloud
 * in a DM with one agent (voice-chat.js chatVoiceMember), and nowhere it has no one to speak.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.js'), 'utf8'), context);
const speaks = vm.runInContext('caSpeaks', context) as (room: unknown) => boolean;
const isVoice = vm.runInContext('caIsVoice', context) as (room: unknown) => boolean;

describe('caSpeaks', () => {
  it('is a voice channel', () => {
    expect(speaks({ members: [{ sessionId: 'a', voice: true }] })).toBe(true);
    expect(speaks({ members: [{ sessionId: 'a' }] })).toBe(false);
  });
  it('is a DM with one agent, without making it a voice channel', () => {
    const dm = { kind: 'dm', dm: ['user', 'a'], members: [{ sessionId: 'a' }] };
    expect(speaks(dm)).toBe(true);
    expect(isVoice(dm)).toBe(false);
  });
  it('is not a group DM or a DM the user is not in', () => {
    expect(speaks({ kind: 'dm', dm: ['user', 'a', 'b'], members: [{ sessionId: 'a' }, { sessionId: 'b' }] })).toBe(
      false
    );
    expect(speaks({ kind: 'dm', dm: ['a', 'b'], members: [{ sessionId: 'a' }] })).toBe(false);
    expect(speaks(null)).toBe(false);
  });
});
