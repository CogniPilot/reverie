/**
 * Car mode's team voice: CarServerSynth speaks server audio one line at a time behind the
 * same surface as speechSynthesis, restarts failed reply batches in one fixed device voice, and a cancel
 * silences everything queued before it.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ ReverieApp: class {} });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-chat.js'), 'utf8'), context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), context);
const get = (name: string) => vm.runInContext(name, context);

interface Utt {
  text: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type Synth = {
  speaking: boolean;
  pending: boolean;
  speak(u: Utt): void;
  speakReply(batch: Utt[]): void;
  cancel(): void;
};
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

function playbackTimingHarness() {
  let now = 100;
  const timingContext = vm.createContext({ ReverieApp: class {}, performance: { now: () => now } });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8'), timingContext);
  const events: Array<{ event: string; info: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<() => void>>();
  const audio = {
    duration: 3,
    currentTime: 0,
    paused: false,
    src: '',
    play: () => Promise.resolve(),
    pause: () => {
      audio.paused = true;
    },
    addEventListener: (name: string, fn: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeEventListener: (name: string, fn: () => void) => {
      listeners.get(name)?.delete(fn);
    },
  };
  const build = vm.runInContext('ReverieApp.prototype._carTeamSynth', timingContext) as (
    this: unknown,
    phone: unknown,
    diag: (event: string, info: Record<string, unknown>) => void
  ) => { deps: { play(url: string, link: Record<string, unknown>): Promise<void>; stop(): void } };
  const app = {
    _carSynthesisQueue: {},
    _chatAudio: audio,
    _chatAudioEl: () => audio,
    _chatUrl: (url: string) => url,
  };
  const team = build.call(app, { speaking: false, pending: false }, (event, info) => events.push({ event, info }));
  return {
    team,
    audio,
    events,
    advance: (ms: number) => {
      now += ms;
    },
    emit: (name: string) => {
      for (const fn of listeners.get(name) || []) fn();
    },
  };
}

describe('linked first-playback timing', () => {
  it('waits for actual playing, records it once, and keeps the exact reply identity', async () => {
    const h = playbackTimingHarness();
    const link = { turnId: 'turn-a', messageId: 'message-a', utteranceIndex: 1 };
    const played = h.team.deps.play('/audio/a', link);
    await Promise.resolve();
    expect(h.events).toEqual([{ event: 'team:play-request', info: link }]);
    h.advance(37);
    h.emit('playing');
    h.advance(99);
    h.emit('playing'); // A resume must not replace the first onset.
    const starts = h.events.filter((e) => e.event === 'team:playing');
    expect(starts).toHaveLength(1);
    expect(starts[0].info).toMatchObject(link);
    expect(starts[0].info.elapsedMs).toBe(37);
    expect(Object.keys(starts[0].info).sort()).toEqual(['elapsedMs', 'messageId', 'turnId', 'utteranceIndex']);
    h.audio.currentTime = h.audio.duration;
    h.emit('ended');
    await played;
  });

  it('removes the onset listener on stop so a late event cannot claim playback', async () => {
    const h = playbackTimingHarness();
    const played = h.team.deps.play('/audio/a', { turnId: 'cancelled-turn' });
    h.team.deps.stop();
    await played;
    h.emit('playing');
    expect(h.events.map((e) => e.event)).toEqual(['team:play-request']);
  });

  it('carries each utterance identity through deferred synthesis and ordered playback', async () => {
    const samples: Array<Record<string, unknown>> = [];
    const links: Array<Record<string, unknown>> = [];
    const synth = new CarServerSynth({
      ...manualTimers(),
      fetchAudio: () => '/audio/a',
      play: (_url: string, link: Record<string, unknown>) => {
        links.push(link);
        return Promise.resolve();
      },
      onSynthesis: (info: Record<string, unknown>) => samples.push(info),
    });
    synth.speakReply(
      ['first', 'second'].map((text) => ({
        text,
        turnId: 'turn-a',
        replyMessageId: 'message-a',
        onend: null,
        onerror: null,
      }))
    );
    await flush();
    await flush();
    expect(links).toEqual(
      [0, 1].map((utteranceIndex) => ({ turnId: 'turn-a', messageId: 'message-a', utteranceIndex }))
    );
    expect(samples).toHaveLength(2);
    for (const [utteranceIndex, sample] of samples.entries()) {
      expect(sample).toMatchObject({ turnId: 'turn-a', messageId: 'message-a', utteranceIndex, status: 'completed' });
      expect(sample.queueMs).toBeGreaterThanOrEqual(0);
      expect(sample.requestMs).toBeGreaterThanOrEqual(0);
    }
  });
});

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
  const notices: { engine: string; reason?: string; restarted?: boolean }[] = [];
  const synth = new CarServerSynth({
    onVoice: (info: { engine: string }) => notices.push(info),
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
  return { synth, log, plays, phones, utt, notices, stops: () => stops };
}

describe('CarServerSynth', () => {
  it('synthesizes queued lines single-flight while playing in order', async () => {
    const h = harness();
    h.synth.speak(h.utt('one'));
    h.synth.speak(h.utt('two'));
    expect(h.synth.speaking).toBe(true);
    expect(h.synth.pending).toBe(true);
    await flush();
    expect(h.log).toEqual(['fetch:one', 'play:/a/one', 'fetch:two']);
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

  it('restarts the whole reply after the first server sentence succeeds and the next fetch fails', async () => {
    const h = harness({ audio: (text) => (text === 'two' ? null : `/a/${text}`) });
    h.synth.speakReply(['one', 'two', 'three'].map(h.utt));
    await flush();
    h.plays[0].end();
    await flush();
    expect(h.phones[0].text).toBe('one');
    expect(h.notices.at(-1)).toMatchObject({ engine: 'device', reason: 'audio-unavailable', restarted: true });
    for (let i = 0; i < 3; i++) {
      expect(h.phones[i].text).toBe(['one', 'two', 'three'][i]);
      h.phones[i].end();
      await flush();
    }
    expect(h.plays).toHaveLength(1);
    expect(h.log.filter((line) => line.startsWith('end:'))).toEqual(['end:one', 'end:two', 'end:three']);
    expect(h.synth.speaking).toBe(false);
  });

  it('replays from the start after later playback stalls, and late completion cannot resume server lines', async () => {
    const timers = manualTimers(),
      h = harness({ timers });
    h.synth.speakReply(['one', 'two', 'three'].map(h.utt));
    await flush();
    h.plays[0].end();
    await flush();
    timers.fire(CAR_TEAM_PLAY_MS);
    await flush();
    expect(h.phones[0].text).toBe('one');
    h.plays[1].end();
    await flush();
    for (let i = 0; i < 3; i++) {
      h.phones[i].end();
      await flush();
    }
    expect(h.plays).toHaveLength(2);
    expect(h.notices.at(-1)).toMatchObject({ engine: 'device', reason: 'playback-interrupted' });
    expect(h.log.filter((line) => line.startsWith('end:'))).toHaveLength(3);
  });

  it('starts a queued reply only after the complete fallback replay finishes', async () => {
    const h = harness({ audio: (text) => (text === 'bad' ? null : `/a/${text}`) });
    h.synth.speakReply(['one', 'bad'].map(h.utt));
    h.synth.speakReply([h.utt('next')]);
    await flush();
    h.plays[0].end();
    await flush();
    expect(h.plays).toHaveLength(1);
    h.phones[0].end();
    await flush();
    expect(h.phones[1].text).toBe('bad');
    h.phones[1].end();
    await flush();
    expect(h.plays[1].url).toBe('/a/next');
    expect(h.notices.at(-1)).toMatchObject({ engine: 'server' });
  });

  it('cancels a fallback batch without playing its remaining sentences or notifying stale callbacks', async () => {
    const h = harness({ audio: () => null });
    h.synth.speakReply(['one', 'two'].map(h.utt));
    await flush();
    h.synth.cancel();
    h.phones[0].end();
    await flush();
    expect(h.phones).toHaveLength(1);
    expect(h.log.some((line) => line.startsWith('end:'))).toBe(false);
    expect(h.synth.pending).toBe(false);
  });

  it('does not splice a different server provider into a reply', async () => {
    const plays: string[] = [],
      phones: string[] = [];
    const synth = new CarServerSynth({
      fetchAudio: (text: string) => ({ url: text, engine: text === 'one' ? 'kokoro' : 'piper' }),
      play: async (url: string) => {
        plays.push(url);
      },
      stop: () => {},
      fallback: async (u: Utt) => {
        phones.push(u.text);
      },
      ...manualTimers(),
    });
    synth.speakReply(['one', 'two'].map((text) => ({ text, onend: null, onerror: null })));
    for (let i = 0; i < 4; i++) await flush();
    expect(plays).toEqual(['one']);
    expect(phones).toEqual(['one', 'two']);
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

describe('bounded synthesis lane', () => {
  const lane = (timers = manualTimers()) => {
    const Queue = get('CarSynthesisQueue');
    return new Queue({ ...timers, now: () => 0 });
  };
  it('keeps four slow synthesis requests single-flight instead of hiding busy rejection', async () => {
    const requests = lane(),
      owner = {},
      waits: ReturnType<typeof deferred<string>>[] = [],
      reports: unknown[] = [];
    let active = 0,
      peak = 0;
    const results = [1, 2, 3, 4].map(() =>
      requests.run(
        async () => {
          peak = Math.max(peak, ++active);
          if (active > 1) throw new Error('Kokoro is busy');
          const wait = deferred<string>();
          waits.push(wait);
          const value = await wait.promise;
          active--;
          return value;
        },
        owner,
        () => true,
        (info: unknown) => reports.push(info)
      )
    );
    for (let i = 0; i < 4; i++) {
      await flush();
      expect(waits).toHaveLength(i + 1);
      waits[i].resolve(`/audio/${i}`);
    }
    expect(await Promise.all(results)).toEqual(['/audio/0', '/audio/1', '/audio/2', '/audio/3']);
    expect(peak).toBe(1);
    expect(reports).toHaveLength(4);
  });
  it('cancels pending effects and drains an active response before replacement can synthesize', async () => {
    const requests = lane(),
      old = {},
      fresh = {},
      wait = deferred<string>(),
      effects: string[] = [];
    const first = requests.run(
      () => {
        effects.push('old');
        return wait.promise;
      },
      old,
      () => true
    );
    const stale = requests.run(
      () => {
        effects.push('stale');
        return '/stale';
      },
      old,
      () => true
    );
    await flush();
    requests.cancel(old);
    const next = requests.run(
      () => {
        effects.push('new');
        return '/new';
      },
      fresh,
      () => true
    );
    await flush();
    expect(effects).toEqual(['old']);
    expect(await first).toBeNull();
    expect(await stale).toBeNull();
    wait.resolve('/late');
    expect(await next).toBe('/new');
    expect(effects).toEqual(['old', 'new']);
  });
  it('refuses expired work without resetting its deadline or overlapping a hung request', async () => {
    const timers = manualTimers(),
      requests = lane(timers),
      owner = {},
      wait = deferred<string>(),
      effects: string[] = [];
    const first = requests.run(
      () => {
        effects.push('active');
        return wait.promise;
      },
      owner,
      () => true
    );
    const queued = requests.run(
      () => {
        effects.push('expired');
        return '/bad';
      },
      owner,
      () => true
    );
    await flush();
    timers.fire(CAR_TEAM_FETCH_MS);
    expect(await first).toBeNull();
    expect(await queued).toBeNull();
    const next = requests.run(
      () => {
        effects.push('next');
        return '/next';
      },
      {},
      () => true
    );
    await flush();
    expect(effects).toEqual(['active']);
    wait.resolve('/late');
    expect(await next).toBe('/next');
    expect(effects).toEqual(['active', 'next']);
  });
  it('bounds pending requests and never retries a busy refusal', async () => {
    const requests = lane(),
      wait = deferred<null>(),
      owner = {},
      refused: unknown[] = [];
    let calls = 0;
    const active = requests.run(
      () => {
        calls++;
        return wait.promise;
      },
      owner,
      () => true
    );
    const queued = Array.from({ length: 32 }, () =>
      requests.run(
        () => {
          calls++;
          return null;
        },
        owner,
        () => true
      )
    );
    expect(
      await requests.run(
        () => {
          calls++;
          return '/overflow';
        },
        {},
        () => true,
        (info: unknown) => refused.push(info)
      )
    ).toBeNull();
    await flush();
    expect(calls).toBe(1);
    expect(refused).toMatchObject([{ status: 'refused' }]);
    requests.cancel(owner);
    wait.resolve(null);
    await active;
    await Promise.all(queued);
    await flush();
    expect(calls).toBe(1);
  });
});

it('keeps the real reply synthesizer below a busy-only engine capacity without device fallback', async () => {
  let active = 0,
    peak = 0;
  const waits: ReturnType<typeof deferred<string>>[] = [];
  const h = harness({
    audio: async () => {
      peak = Math.max(peak, ++active);
      if (active > 1) {
        active--;
        throw new Error('Kokoro is busy');
      }
      const wait = deferred<string>();
      waits.push(wait);
      const result = await wait.promise;
      active--;
      return result;
    },
  });
  h.synth.speakReply(['one', 'two', 'three', 'four'].map(h.utt));
  for (let i = 0; i < 4; i++) {
    await flush();
    expect(waits).toHaveLength(i + 1);
    waits[i].resolve(`/audio/${i}`);
    await flush();
    expect(h.phones).toHaveLength(0);
    expect(h.plays).toHaveLength(i + 1);
    h.plays[i].end();
    await flush();
  }
  expect(peak).toBe(1);
  expect(h.synth.speaking).toBe(false);
});

it('rechecks the original absolute deadline immediately before starting a synthesis effect', async () => {
  let now = 0,
    calls = 0;
  const Queue = get('CarSynthesisQueue'),
    timers = manualTimers();
  const queue = new Queue({ ...timers, now: () => now });
  const result = queue.run(
    () => {
      calls++;
      return '/late';
    },
    {},
    () => true
  );
  now = CAR_TEAM_FETCH_MS;
  expect(await result).toBeNull();
  expect(calls).toBe(0);
});

it('passes only the remaining original deadline to a request that waited in the lane', async () => {
  let now = 0,
    remaining = 0;
  const Queue = get('CarSynthesisQueue'),
    wait = deferred<string>();
  const queue = new Queue({ ...manualTimers(), now: () => now });
  const first = queue.run(
    () => wait.promise,
    {},
    () => true
  );
  const second = queue.run(
    (budget: number) => {
      remaining = budget;
      return '/two';
    },
    {},
    () => true
  );
  await flush();
  now = 10_000;
  wait.resolve('/one');
  expect(await first).toBe('/one');
  expect(await second).toBe('/two');
  expect(remaining).toBe(CAR_TEAM_FETCH_MS - 10_000);
});

it('withdraws the rest of a busy reply batch without further synthesis attempts', async () => {
  const h = harness({ audio: () => null });
  h.synth.speakReply(['one', 'two', 'three'].map(h.utt));
  await flush();
  expect(h.log.filter((line) => line.startsWith('fetch:'))).toEqual(['fetch:one']);
  for (let i = 0; i < 3; i++) {
    expect(h.phones[i].text).toBe(['one', 'two', 'three'][i]);
    h.phones[i].end();
    await flush();
  }
  expect(h.log.filter((line) => line.startsWith('fetch:'))).toHaveLength(1);
});

it.each([25_000, 25_001])('completion deadline rejects success at %i ms before a delayed timer fires', async (end) => {
  let now = 0;
  const Queue = get('CarSynthesisQueue'),
    timers = manualTimers(),
    wait = deferred<string>(),
    reports: unknown[] = [];
  const queue = new Queue({ ...timers, now: () => now });
  const result = queue.run(
    () => wait.promise,
    {},
    () => true,
    (info: unknown) => reports.push(info)
  );
  await flush();
  now = end;
  wait.resolve('/late');
  expect(await result).toBeNull();
  expect(reports).toMatchObject([{ status: 'deadline', queueMs: 0, requestMs: end }]);
  timers.fire(CAR_TEAM_FETCH_MS);
  expect(reports).toHaveLength(1);
  expect(timers.count()).toBe(0);
});

it('completion deadline accepts success just before the boundary and clears the delayed timer', async () => {
  let now = 0;
  const Queue = get('CarSynthesisQueue'),
    timers = manualTimers(),
    wait = deferred<string>(),
    reports: unknown[] = [];
  const queue = new Queue({ ...timers, now: () => now });
  const result = queue.run(
    () => wait.promise,
    {},
    () => true,
    (info: unknown) => reports.push(info)
  );
  await flush();
  now = CAR_TEAM_FETCH_MS - 1;
  wait.resolve('/timely');
  expect(await result).toBe('/timely');
  timers.fire(CAR_TEAM_FETCH_MS);
  expect(reports).toMatchObject([{ status: 'completed', requestMs: 24_999 }]);
  expect(reports).toHaveLength(1);
  expect(timers.count()).toBe(0);
});

it('completion deadline includes queue wait rather than starting a new request budget', async () => {
  let now = 0;
  const Queue = get('CarSynthesisQueue'),
    first = deferred<string>(),
    second = deferred<string>(),
    reports: unknown[] = [];
  const queue = new Queue({ ...manualTimers(), now: () => now });
  const one = queue.run(
    () => first.promise,
    {},
    () => true
  );
  const two = queue.run(
    () => second.promise,
    {},
    () => true,
    (info: unknown) => reports.push(info)
  );
  await flush();
  now = 10_000;
  first.resolve('/one');
  expect(await one).toBe('/one');
  await flush();
  now = CAR_TEAM_FETCH_MS;
  second.resolve('/late');
  expect(await two).toBeNull();
  expect(reports).toMatchObject([{ status: 'deadline', queueMs: 10_000, requestMs: 15_000 }]);
});

it('completion deadline preserves cancelled status while the late active request drains without retry', async () => {
  let now = 0,
    calls = 0;
  const Queue = get('CarSynthesisQueue'),
    wait = deferred<string>(),
    owner = {},
    reports: unknown[] = [];
  const queue = new Queue({ ...manualTimers(), now: () => now });
  const result = queue.run(
    () => {
      calls++;
      return wait.promise;
    },
    owner,
    () => true,
    (info: unknown) => reports.push(info)
  );
  await flush();
  queue.cancel(owner);
  expect(await result).toBeNull();
  now = CAR_TEAM_FETCH_MS + 1;
  wait.resolve('/late');
  await flush();
  expect(calls).toBe(1);
  expect(reports).toMatchObject([{ status: 'cancelled' }]);
  expect(reports).toHaveLength(1);
});

it.each(['setTimeout', 'clearTimeout'])('keeps the browser receiver for default %s', (method) => {
  const browser = vm.createContext({ ReverieApp: class {} });
  vm.runInContext(
    `
    globalThis.calls = [];
    globalThis.setTimeout = function(callback, ms) {
      if (${JSON.stringify(method)} === 'setTimeout' && this !== globalThis) throw new TypeError('Illegal invocation: setTimeout');
      calls.push(['set', ms]); return 17;
    };
    globalThis.clearTimeout = function(id) {
      if (${JSON.stringify(method)} === 'clearTimeout' && this !== globalThis) throw new TypeError('Illegal invocation: clearTimeout');
      calls.push(['clear', id]);
    };
  `,
    browser
  );
  for (const file of ['voice-chat.js', 'car-mode.js'])
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8'), browser);
  const queue = vm.runInContext('new CarSynthesisQueue()', browser);
  const timer = queue.set(() => {}, 25_000);
  queue.clear(timer);
  expect(vm.runInContext('calls', browser)).toEqual([
    ['set', 25_000],
    ['clear', 17],
  ]);
});
