/**
 * Read one agent message aloud on request, from its context menu or a long press on a phone. The message's menu (right-click, its More button, or a long press on a phone) offers "Read aloud", then "Speak
 * again"; it reads all of the message now, in its author's voice, and while it is being said the menu entry and the message
 * itself offer Stop. Automatic per-room read-aloud stays as it was, and its lines can be stopped the same way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room, user } from './helpers/chat-app-harness.mjs';

const voiceChat = readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8');

type Queue = {
  push(text: string, meta?: object): void;
  playNow(text: string, meta?: object): void;
  stopMessage(id: string): void;
  playingMessageId: string | null;
};

function queue() {
  const context = vm.createContext({ ReverieApp: class {} });
  vm.runInContext(voiceChat, context);
  const said: Array<{ text: string; onend?: () => void }> = [];
  const done: string[] = [];
  let cancels = 0;
  const Q = vm.runInContext('ReadAloudQueue', context) as new (deps: unknown) => Queue;
  const q = new Q({
    synth: { speak: (u: { text: string }) => said.push(u), cancel: () => cancels++ },
    createUtterance: (text: string) => ({ text }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    onDone: (item: { text: string }, how: string) => done.push(`${item.text}:${how}`),
  });
  return { q, said, done, cancels: () => cancels };
}

describe('ReadAloudQueue for one message', () => {
  it('says a requested message now and puts the interrupted line back right after it', () => {
    const { q, said, done, cancels } = queue();
    q.push('auto one', { messageId: 'a1' });
    q.push('auto two', { messageId: 'a2' });
    expect(q.playingMessageId).toBe('a1');
    q.playNow('asked', { messageId: 'm9' });
    expect(cancels()).toBe(1);
    expect(q.playingMessageId).toBe('m9');
    said.at(-1)!.onend!();
    expect(said.map((u) => u.text)).toEqual(['auto one', 'asked', 'auto one']);
    said.at(-1)!.onend!();
    expect(said.at(-1)!.text).toBe('auto two');
    expect(done).toEqual(['asked:ended', 'auto one:ended']);
  });

  it('Speak again on the message being said starts it over once, and Stop cuts it and drops its queued lines', () => {
    const { q, said, done } = queue();
    q.playNow('again', { messageId: 'm1' });
    q.push('later', { messageId: 'm2' });
    q.push('again', { messageId: 'm1' });
    q.playNow('again', { messageId: 'm1' });
    expect(said.map((u) => u.text)).toEqual(['again', 'again']);
    q.stopMessage('m1');
    expect(done).toEqual(['again:dropped', 'again:cancelled']);
    expect(q.playingMessageId).toBe('m2');
    expect(said.at(-1)!.text).toBe('later');
    q.stopMessage('nothing');
    expect(q.playingMessageId).toBe('m2');
    said.at(-1)!.onend!();                                               // the stopped message's queued line never plays
    expect(said.map((u) => u.text)).toEqual(['again', 'again', 'later']);
    expect(q.playingMessageId).toBeNull();
  });
});

const A = '0000002d-0035-4000-8000-0000000000c1';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); });

async function setup({ speech = true } = {}) {
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + '.';
  const rooms = [
    room('r1', 'General', [member(A, 'alpha')], {
      messages: [message('m1', 'r1', agent(A, 'alpha'), long, 1000), message('m2', 'r1', user, 'from me', 1100)],
    }),
  ];
  const h = await createHarness({ sessions: [{ id: A, name: 'alpha', mode: 'claude' }], rooms });
  opened.push(h);
  const spoken: Array<{ text: string; onend?: () => void }> = [];
  let cancels = 0;
  if (speech) {
    h.window.SpeechSynthesisUtterance = class { text: string; constructor(text: string) { this.text = text; } };
    h.window.speechSynthesis = { speak: (u: { text: string }) => spoken.push(u), cancel: () => cancels++, getVoices: () => [] };
  }
  h.window.eval(voiceChat);
  const shell = h.window.reverieChat;
  const msg = (id: string) => h.document.querySelector(`[data-msg-id="${id}"]`) as HTMLElement;
  const labels = (id: string) => {
    h.document.querySelector('.ca-msg-menu')?.remove();
    (msg(id).querySelector('[aria-label="More"]') as HTMLElement).click();
    const out = [...h.document.querySelectorAll('.ca-msg-menu button')].map((b) => b.textContent);
    return out;
  };
  const choose = (id: string, label: string) => {
    labels(id);
    ([...h.document.querySelectorAll('.ca-msg-menu button')].find((b) => b.textContent === label) as HTMLElement).click();
  };
  return { h, shell, msg, labels, choose, spoken, cancels: () => cancels };
}

describe('Read aloud in the message menu', () => {
  it('reads all of an agent message now, shows it playing with its own Stop, then offers Speak again', async () => {
    const { h, shell, msg, labels, choose, spoken, cancels } = await setup();
    expect(labels('m1')).toContain('Read aloud');
    expect(labels('m2')).not.toContain('Read aloud');                      // a person's message: not offered
    choose('m1', 'Read aloud');
    // All of it (the automatic read-aloud would say "Long reply from alpha"), in pieces the queue speaks one after another.
    expect(spoken[0].text.startsWith('alpha says: word0 word1')).toBe(true);
    expect(h.window.app._readAloud.current.chunks.join(' ')).toContain('word119');
    expect(msg('m1').classList.contains('is-reading')).toBe(true);
    expect(labels('m1')).toContain('Stop reading');
    expect(labels('m1')).not.toContain('Read aloud');
    // The message's own Stop, which a re-rendered feed gets back on the next voice tick.
    shell.renderFeed();
    shell.syncVoice();
    const stop = msg('m1').querySelector('.ca-reading-stop') as HTMLButtonElement;
    expect(stop.textContent).toContain('Stop');
    stop.click();
    expect(cancels()).toBeGreaterThan(0);
    expect(msg('m1').classList.contains('is-reading')).toBe(false);
    expect(msg('m1').querySelector('.ca-reading-stop')).toBeNull();
    expect(labels('m1')).toContain('Speak again');
    choose('m1', 'Speak again');
    expect(h.window.app._readAloud.playingMessageId).toBe('m1');
    choose('m1', 'Stop reading');
    expect(h.window.app._readAloud.playingMessageId).toBeNull();
  });

  it('a line the room read aloud by itself can be stopped from its message too', async () => {
    const { h, shell, msg, spoken } = await setup();
    h.window.app._setSpeakReplies?.('r1', true);
    h.window.app._readAloudQueue().push('alpha says: hi', { room: 'r1', member: A, messageId: 'm1', text: 'hi' });
    shell.syncVoice();
    expect(spoken).toHaveLength(1);
    expect(msg('m1').classList.contains('is-reading')).toBe(true);
    (msg('m1').querySelector('.ca-reading-stop') as HTMLButtonElement).click();
    expect(h.window.app._readAloud.playingMessageId).toBeNull();
  });

  it('is not offered where the browser has no speech', async () => {
    const { labels } = await setup({ speech: false });
    expect(labels('m1')).not.toContain('Read aloud');
  });
});
