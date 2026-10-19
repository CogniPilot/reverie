/**
 * Voice for every agent: where a mic press goes, what read-aloud says, and the
 * read-aloud queue (one at a time, held while recording, never stalled).
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
const get = (name: string) => vm.runInContext(name, context);
const chatMicRoute = get('chatMicRoute') as (o: {
  toVoiceMember: boolean;
  hasRecognition: boolean;
  hasRecorder: boolean;
}) => string | null;
const readAloudText = get('readAloudText') as (name: string, text: string) => string;
const ReadAloudQueue = get('ReadAloudQueue') as new (deps: unknown) => {
  push(t: string): void;
  mute(on: boolean): void;
  clear(): void;
};

describe('chatMicRoute', () => {
  it('sends the voice member through /turn, everyone else through dictation', () => {
    expect(chatMicRoute({ toVoiceMember: true, hasRecognition: true, hasRecorder: true })).toBe('turn');
    expect(chatMicRoute({ toVoiceMember: false, hasRecognition: true, hasRecorder: true })).toBe('local');
    expect(chatMicRoute({ toVoiceMember: false, hasRecognition: false, hasRecorder: true })).toBe('server');
  });
  it('offers nothing a browser cannot do', () => {
    expect(chatMicRoute({ toVoiceMember: true, hasRecognition: true, hasRecorder: false })).toBeNull();
    expect(chatMicRoute({ toVoiceMember: false, hasRecognition: false, hasRecorder: false })).toBeNull();
  });
});

describe('readAloudText', () => {
  it('names the speaker first', () => {
    expect(readAloudText('orchestrator', 'Build is green.')).toBe('orchestrator says: Build is green.');
  });
  it('announces a long reply instead of reading it', () => {
    expect(readAloudText('slam_web', 'word '.repeat(81))).toBe('Long reply from slam_web, see the panel.');
    expect(readAloudText('x', '   ')).toBe('');
  });
});

function harness() {
  const said: Array<{ text: string; onend?: () => void; onerror?: () => void }> = [];
  const timers: Array<() => void> = [];
  let cancels = 0;
  const q = new ReadAloudQueue({
    synth: { speak: (u: { text: string }) => said.push(u), cancel: () => cancels++ },
    createUtterance: (text: string) => ({ text }),
    setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
    clearTimeout: () => {},
  });
  return { q, said, timers, cancels: () => cancels };
}

describe('ReadAloudQueue', () => {
  it('speaks one item at a time, in order', () => {
    const { q, said } = harness();
    q.push('one');
    q.push('two');
    expect(said.map((u) => u.text)).toEqual(['one']);
    said[0].onend?.();
    expect(said.map((u) => u.text)).toEqual(['one', 'two']);
  });

  it('holds while the mic records and says an interrupted item again afterwards', () => {
    const { q, said, cancels } = harness();
    q.push('first');
    q.mute(true);
    expect(cancels()).toBe(1);
    q.push('second');
    expect(said).toHaveLength(1);
    q.mute(false);
    expect(said.map((u) => u.text)).toEqual(['first', 'first']);
    said[1].onend?.();
    expect(said.at(-1)?.text).toBe('second');
  });

  it('moves on when onend never comes (a stuck synthesizer)', () => {
    const { q, said, timers } = harness();
    q.push('stuck');
    q.push('next');
    timers[0]();
    expect(said.map((u) => u.text)).toEqual(['stuck', 'next']);
  });

  it('clear drops everything', () => {
    const { q, said } = harness();
    q.push('a');
    q.push('b');
    q.clear();
    said[0].onend?.();
    expect(said).toHaveLength(1);
  });
});
