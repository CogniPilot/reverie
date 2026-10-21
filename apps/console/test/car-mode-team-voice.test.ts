/**
 * Car mode's team voice: CarServerSynth speaks server audio one line at a time behind the
 * same surface as speechSynthesis, falls back to the phone voice per line, and a cancel
 * silences everything queued before it.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), context);
const get = (name: string) => vm.runInContext(name, context);

interface Utt {
  text: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type Synth = { speaking: boolean; pending: boolean; speak(u: Utt): void; cancel(): void };
const CarServerSynth = get('CarServerSynth') as new (deps: unknown) => Synth;
const CAR_TEAM_VOICE = get('CAR_TEAM_VOICE') as string;
const CAR_TEAM_FETCH_MS = get('CAR_TEAM_FETCH_MS') as number;
const CAR_TEAM_PLAY_MS = get('CAR_TEAM_PLAY_MS') as number;
const pickVoice = get('carModePickVoice') as (
  v: unknown[],
  saved: string | null,
  id?: string
) => { name: string } | null;
const voiceMember = get('chatVoiceMember') as (room: unknown) => { sessionId: string } | null;
const isUserDm = get('chatIsUserDm') as (room: unknown) => boolean;

/** Timers the test fires by hand: fire(ms) runs every timer set for exactly that delay. */
function manualTimers() {
  let next = 1;
  const live = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      live.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (t: number) => {
      live.delete(t);
    },
    fire(ms: number) {
      for (const [id, t] of [...live]) {
        if (t.ms === ms) {
          live.delete(id);
          t.fn();
        }
      }
    },
    count: () => live.size,
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(
  opts: {
    audio?: (text: string) => Promise<string | null> | string | null;
    timers?: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (t: number) => void };
  } = {}
) {
  const log: string[] = [];
  const plays: { url: string; end: () => void; fail: () => void }[] = [];
  const phones: { text: string; end: () => void; fail: () => void }[] = [];
  let stops = 0;
  const synth = new CarServerSynth({
    fetchAudio: (text: string) => {
      log.push(`fetch:${text}`);
      return opts.audio ? opts.audio(text) : `/a/${text}`;
    },
    play: (url: string) =>
      new Promise<void>((res, rej) => {
        log.push(`play:${url}`);
        plays.push({ url, end: () => res(), fail: () => rej(new Error('refused')) });
      }),
    stop: () => {
      stops++;
    },
    ...(opts.timers || manualTimers()),
    fallback: (u: Utt) =>
      new Promise<void>((res, rej) => {
        log.push(`phone:${u.text}`);
        phones.push({ text: u.text, end: () => res(), fail: () => rej(new Error('phone failed')) });
      }),
  });
  const utt = (text: string) => {
    const u: Utt = { text, onend: () => log.push(`end:${text}`), onerror: () => log.push(`error:${text}`) };
    return u;
  };
  return { synth, log, plays, phones, utt, stops: () => stops };
}

describe('CarServerSynth', () => {
  it('requests every line at once and plays them in order, one at a time', async () => {
    const h = harness();
    h.synth.speak(h.utt('one'));
    h.synth.speak(h.utt('two'));
    expect(h.synth.speaking).toBe(true);
    expect(h.synth.pending).toBe(true);
    await flush();
    expect(h.log).toEqual(['fetch:one', 'fetch:two', 'play:/a/one']);
    h.plays[0].end();
    await flush();
    expect(h.log.slice(3)).toEqual(['end:one', 'play:/a/two']);
    expect(h.synth.pending).toBe(false);
    h.plays[1].end();
    await flush();
    expect(h.log.at(-1)).toBe('end:two');
    expect(h.synth.speaking).toBe(false);
  });

  it('speaks a line the server could not make with the phone voice, then goes on', async () => {
    const h = harness({ audio: (t) => (t === 'bad' ? null : `/a/${t}`) });
    h.synth.speak(h.utt('bad'));
    h.synth.speak(h.utt('good'));
    await flush();
    expect(h.log).toContain('phone:bad');
    h.phones[0].end();
    await flush();
    expect(h.log.slice(-2)).toEqual(['end:bad', 'play:/a/good']);
  });

  it('treats a rejected request like a missing line', async () => {
    const h = harness({ audio: () => Promise.reject(new Error('network')) });
    h.synth.speak(h.utt('x'));
    await flush();
    expect(h.log).toEqual(['fetch:x', 'phone:x']);
  });

  it('treats a throwing request like a missing line', async () => {
    const h = harness({
      audio: () => {
        throw new Error('sync');
      },
    });
    h.synth.speak(h.utt('x'));
    await flush();
    expect(h.log).toEqual(['fetch:x', 'phone:x']);
  });

  it('falls back to the phone voice when the browser refuses to play', async () => {
    const h = harness();
    h.synth.speak(h.utt('x'));
    await flush();
    h.plays[0].fail();
    await flush();
    expect(h.log).toEqual(['fetch:x', 'play:/a/x', 'phone:x']);
    h.phones[0].end();
    await flush();
    expect(h.log.at(-1)).toBe('end:x');
  });

  it('reports onerror only when the phone voice fails too', async () => {
    const h = harness({ audio: () => null });
    h.synth.speak(h.utt('x'));
    await flush();
    h.phones[0].fail();
    await flush();
    expect(h.log.at(-1)).toBe('error:x');
    expect(h.synth.speaking).toBe(false);
  });

  it('cancel stops playback, drops the queue and never reports the old lines', async () => {
    const h = harness();
    h.synth.speak(h.utt('one'));
    h.synth.speak(h.utt('two'));
    await flush();
    h.synth.cancel();
    expect(h.stops()).toBe(1);
    expect(h.synth.speaking).toBe(false);
    expect(h.synth.pending).toBe(false);
    h.plays[0].end();
    await flush();
    expect(h.log).not.toContain('end:one');
    expect(h.log).not.toContain('play:/a/two');
  });

  it('a cancel while a line is still being made never plays it', async () => {
    const d = deferred<string | null>();
    const h = harness({ audio: () => d.promise });
    h.synth.speak(h.utt('slow'));
    await flush();
    h.synth.cancel();
    d.resolve('/a/slow');
    await flush();
    expect(h.log).toEqual(['fetch:slow']);
  });

  it('speaks a new line after a cancel', async () => {
    const h = harness();
    h.synth.speak(h.utt('old'));
    await flush();
    h.synth.cancel();
    h.synth.speak(h.utt('new'));
    await flush();
    expect(h.log.at(-1)).toBe('play:/a/new');
    h.plays[1].end();
    h.plays[0].end();
    await flush();
    expect(h.log.filter((l) => l.startsWith('end:'))).toEqual(['end:new']);
  });

  it('a request that never settles goes to the phone voice after the fetch limit', async () => {
    const t = manualTimers();
    const h = harness({ audio: () => new Promise(() => {}), timers: t });
    h.synth.speak(h.utt('lost'));
    await flush();
    expect(h.log).toEqual(['fetch:lost']);
    t.fire(CAR_TEAM_FETCH_MS);
    await flush();
    expect(h.log).toEqual(['fetch:lost', 'phone:lost']);
    h.phones[0].end();
    await flush();
    expect(h.log.at(-1)).toBe('end:lost');
  });

  it('a playback that never settles is silenced and goes to the phone voice after the play limit', async () => {
    const t = manualTimers();
    const h = harness({ timers: t });
    h.synth.speak(h.utt('stuck'));
    await flush();
    expect(h.log).toEqual(['fetch:stuck', 'play:/a/stuck']);
    t.fire(CAR_TEAM_PLAY_MS);
    await flush();
    expect(h.stops()).toBe(1);
    expect(h.log).toEqual(['fetch:stuck', 'play:/a/stuck', 'phone:stuck']);
    // The stalled line ending late changes nothing.
    h.plays[0].end();
    h.phones[0].end();
    await flush();
    expect(h.log.filter((l) => l.startsWith('end:') || l.startsWith('error:'))).toEqual(['end:stuck']);
  });

  it('a stop that settles the stalled playback still hands the line to the phone voice', async () => {
    const t = manualTimers();
    let settle: (() => void) | null = null;
    const log: string[] = [];
    const synth = new CarServerSynth({
      fetchAudio: () => '/a/x',
      play: () => new Promise<void>((res) => (settle = res)),
      // The real stop() settles the playing line as finished: the timeout must still win.
      stop: () => settle?.(),
      fallback: (u: Utt) => {
        log.push(`phone:${u.text}`);
        return Promise.resolve();
      },
      ...t,
    });
    synth.speak({ text: 'x', onend: () => log.push('end'), onerror: () => log.push('error') });
    await flush();
    t.fire(CAR_TEAM_PLAY_MS);
    await flush();
    expect(log).toEqual(['phone:x', 'end']);
  });

  it('a line that plays normally leaves no timer behind', async () => {
    const t = manualTimers();
    const h = harness({ timers: t });
    h.synth.speak(h.utt('ok'));
    await flush();
    h.plays[0].end();
    await flush();
    expect(h.log.at(-1)).toBe('end:ok');
    expect(t.count()).toBe(0);
  });

  it('the team voice menu value picks the member default phone voice for the fallback', () => {
    const voices = [
      { name: 'Alpha', lang: 'en-US' },
      { name: 'Beta', lang: 'en-GB' },
      { name: 'Gamma', lang: 'en-AU' },
    ];
    expect(pickVoice(voices, CAR_TEAM_VOICE, 'member-1')).toEqual(pickVoice(voices, null, 'member-1'));
    expect(pickVoice(voices, CAR_TEAM_VOICE, 'member-1')).not.toBeNull();
  });

  it('the team voice menu value is not a phone voice name', () => {
    expect(CAR_TEAM_VOICE).toBe('team-voice');
  });
});

describe('chatVoiceMember', () => {
  const agent = (id: string, extra = {}) => ({ sessionId: id, name: id, ...extra });
  it('is the member marked as the voice in a channel', () => {
    expect(voiceMember({ members: [agent('a'), agent('b', { voice: true })] })?.sessionId).toBe('b');
    expect(voiceMember({ members: [agent('a')] })).toBeNull();
  });
  it("is the agent in the user's own direct message with one agent", () => {
    expect(voiceMember({ kind: 'dm', dm: ['user', 'a'], members: [agent('a')] })?.sessionId).toBe('a');
  });
  it('is no one once the agent has left the DM, or for a member the DM is not with', () => {
    expect(voiceMember({ kind: 'dm', dm: ['user', 'a'], members: [] })).toBeNull();
    expect(voiceMember({ kind: 'dm', dm: ['user', 'a'], members: [agent('b')] })).toBeNull();
  });
  it('is no one in a group DM or a DM between agents', () => {
    expect(voiceMember({ kind: 'dm', dm: ['user', 'a', 'b'], members: [agent('a'), agent('b')] })).toBeNull();
    expect(voiceMember({ kind: 'dm', dm: ['a', 'b'], members: [agent('a')] })).toBeNull();
  });
  it('a marked voice wins in a DM too, and odd rooms are no one', () => {
    expect(
      voiceMember({ kind: 'dm', dm: ['user', 'a', 'b'], members: [agent('a'), agent('b', { voice: true })] })?.sessionId
    ).toBe('b');
    expect(voiceMember(null)).toBeNull();
    expect(voiceMember({})).toBeNull();
  });
  it('reads every agent message in a DM with the user as addressed to the user', () => {
    expect(isUserDm({ kind: 'dm', dm: ['user', 'a'] })).toBe(true);
    expect(isUserDm({ kind: 'dm', dm: ['a', 'b'] })).toBe(false);
    expect(isUserDm({ members: [] })).toBe(false);
  });
});
