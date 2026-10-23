/**
 * @fileoverview Car mode: a full-screen, hands-free conversation with the room's voice
 * member (the member marked `voice`), built for a phone in a car.
 *
 * Two engines, chosen by what the browser offers:
 * - `speech` (Android Chrome, desktop Chrome): the browser's SpeechRecognition listens
 *   continuously with its own voice-activity detection. A final transcript is posted
 *   as an ordinary room message (`spoken: true`, so the member answers it like a typed
 *   one), the member's reply is spoken, and listening pauses while she speaks so she is
 *   never transcribed, then resumes on its own. The reply is spoken in the member's own
 *   server voice ("Team voice", the default: /api/voice/speak, CarServerSynth) or in a
 *   phone voice picked in the menu (`speechSynthesis`). A line the server cannot make,
 *   or the browser will not play, is spoken by the phone instead.
 * - `server` (no SpeechRecognition): the whole screen is the push-to-talk button of
 *   the chat panel (tap to talk, tap to send), using the /api/voice/turn path.
 *
 * A tap anywhere toggles listening; a tap while she speaks cuts her off and listens.
 * The mode is remembered per device (`reverie:carMode`) and the screen is kept awake.
 *
 * `CarModeController` is the state machine with every browser API injected, so it is
 * unit-tested with fakes (test/car-mode.test.ts); the rest is DOM glue.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js, chatroom-ui.js (_chatApi, _chatRoom, push-to-talk helpers), voice-chat.js (snapshot helpers)
 * @loadorder 12.12 (after voice-chat.js)
 */

/** How long to wait for the member's answer before listening again. */
const CAR_REPLY_TIMEOUT_MS = 180_000;
const CAR_POST_CONFIRM_MS = 25_000;
/** Join final recognition segments across a short natural pause. */
const CAR_FINAL_GRACE_MS = 1500;
/** Chrome stops long utterances; speaking sentence by sentence avoids it. */
const CAR_MAX_UTTERANCE_CHARS = 220;
/** Recognition errors other than silence (network, audio-capture): wait before retrying. */
const CAR_RETRY_BACKOFF_MS = 1500;
/** Nothing heard for this long: stop listening, release the mic, show "Tap to talk". */
const CAR_LISTEN_TIMEOUT_MS = 15_000;
/** One utterance may run this long; then what was heard so far is sent. */
const CAR_UTTERANCE_CAP_MS = 30_000;
/** This many recognition failures in a row: stop and show a tappable state. */
const CAR_MAX_ERRORS = 3;
/** How often to ask the synthesizer whether it is really done speaking. */
const CAR_SPEECH_POLL_MS = 250;
/** Wait at least this long for the synthesizer to go quiet, however short the reply. */
const CAR_SPEECH_MIN_WAIT_MS = 4000;
/** Never wait longer than this for the synthesizer to go quiet. */
const CAR_SPEECH_WAIT_CAP_MS = 120_000;
/** How often the car screen checks who is speaking (its avatar and name). */
const CAR_SPEAKER_MS = 250;

/** Pure: which engine this browser supports. */
function carModeEngine(win) {
  const Recognition = win && (win.SpeechRecognition || win.webkitSpeechRecognition);
  return Recognition && win.speechSynthesis ? 'speech' : 'server';
}

/** Pure: split a reply into utterances the synthesizer will finish. */
function carModeUtterances(text, max = CAR_MAX_UTTERANCE_CHARS) {
  // Break only where sentence punctuation is followed by a space, so "1.5 s" or
  // "v2.1.284" stay in one utterance.
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = flat ? flat.split(/(?<=[.!?])\s+/) : [];
  const out = [];
  for (let s of sentences) {
    s = s.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > max / 2 ? s.lastIndexOf(' ', max) : max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/**
 * Pure: what of a reply is worth hearing. Code, links, paths and long ids stay on screen and are
 * spoken as a short stand-in; markdown markers are dropped. The written reply is never changed.
 */
function carModeSpeakable(text) {
  return (
    String(text || '')
      .replace(/```[\s\S]*?(```|$)/g, ' (code in chat) ')
      .replace(/`([^`\n]*)`/g, (_, inner) => (inner.length <= 24 && !/[/\\]/.test(inner) ? inner : ' (see chat) '))
      .replace(/\b(?:https?|wss?):\/\/\S+/gi, ' a link ')
      // A path starts a word: /etc, ~/x, ./y, ../z (one segment is enough). "and/or" and "1/2" do not start one.
      .replace(/(^|[\s("'])(?:~|\.{1,2})?\/[^\s"')]+?(?=[.,;:!?]*(?:[\s"')]|$))/g, (_, pre) =>
        /\S/.test(pre) ? `${pre}a file path ` : `${pre} a file path `
      )
      // "Node.js" is a name, "chat-app.js" a file: a .js/.ts name counts only with a dash, underscore or digit.
      .replace(
        /\b([\w-]+)\.(sh|js|mjs|ts|py|json|md|txt|log|patch|gz|tar|html|css|yaml|yml|toml)\b/gi,
        (m, name, ext) => (/^(?:js|ts)$/i.test(ext) && !/[-_\d]/.test(name) ? m : ' a file ')
      )
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, ' an id ')
      .replace(/\b(?:[a-z]{1,3}-)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, ' an id ')
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, '')
      // Kokoro has no stress markup and reads a lone star as "asterisk": every star goes, **x** and *x* alike.
      .replace(/\*+|__/g, '')
      // A run of stand-ins with only spaces between them is said once; a list ("x, y and z") keeps each one.
      .replace(/( (?:a file path|a file|an id|a link|\(see chat\)|\(code in chat\)) )(?:[ \t]*\1)+/g, '$1')
      .replace(/[ \t]+/g, ' ')
      // Only punctuation that ends a word loses the space before it: " ./y" keeps its space.
      .replace(/ ([,.;:!?)"'])(?=[\s,.;:!?)"']|$)/g, '$1')
      .trim()
  );
}

/** Pure: a stable 32-bit FNV-1a hash, so a member keeps the same default voice. */
function carModeHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Voices checked to sound female or male, by exact entry: Apple and other desktop voices by name,
 * Microsoft voices by their first name inside the full Microsoft name, Android voices by their
 * Google TTS code. Anything not on the table is unknown, however its name reads.
 */
const CAR_VOICE_GENDERS = (() => {
  const table = new Map();
  const add = (kind, gender, keys) =>
    (Array.isArray(keys) ? keys : keys.split(' ')).forEach((k) => table.set(`${kind}:${k}`, gender));
  add(
    'name',
    'female',
    'samantha karen victoria moira tessa fiona veena serena allison ava susan kate nicky catherine'
  );
  add('name', 'female', 'zoe flo sandy shelley grandma');
  add(
    'name',
    'male',
    'daniel alex fred tom aaron arthur gordon rishi oliver lee evan nathan eddy reed rocko grandpa ralph'
  );
  add('full', 'female', ['google us english', 'google uk english female']);
  add('full', 'male', ['google uk english male']);
  add('microsoft', 'female', 'zira aria jenny libby sonia hazel natasha clara michelle emily susan catherine');
  add('microsoft', 'male', 'david mark guy ryan george william eric davis tony christopher brian');
  add('code', 'female', 'sfg iob iog tpc tpf gba gbc gbg fis afh aua auc');
  add('code', 'male', 'iol iom tpd gbb gbd rjs aub aud');
  return table;
})();

/**
 * Pure: how a voice is known to sound, 'female' or 'male', or '' when it is not on the table.
 * The whole (lowercased, space-collapsed) name must have one of these exact shapes:
 *   en-us-x-sfg-local / -network          Android, by code
 *   Microsoft Zira [Online (Natural)] - English (United States)
 *   Samantha, Samantha (Enhanced), Samantha (Premium), Flo (English (US))
 *   Google US English, Google UK English Female, Google UK English Male
 * so "Not Samantha", "Daniel Clone" or "Unknown Male" say nothing.
 */
function carModeVoiceGender(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const lookup = (kind, key) => CAR_VOICE_GENDERS.get(`${kind}:${key}`) || '';
  let m = /^en-[a-z]{2}-x-([a-z]{3})-(?:local|network)$/.exec(n);
  if (m) return lookup('code', m[1]);
  m = /^microsoft ([a-z]+)(?: online \(natural\))? - english \([a-z ]+\)$/.exec(n);
  if (m) return lookup('microsoft', m[1]);
  m = /^([a-z]+)(?: \((?:enhanced|premium|english \([a-z ]+\))\))?$/.exec(n);
  if (m) return lookup('name', m[1]);
  return lookup('full', n);
}

/** Pure: the voice a member's pronouns ask for: 'female' for she/..., 'male' for he/..., '' otherwise (they, xe, none). */
function carModePronounGender(pronouns) {
  const first = /[a-z]+/i.exec(String(pronouns || ''))?.[0].toLowerCase();
  return first === 'she' ? 'female' : first === 'he' ? 'male' : '';
}

/**
 * Pure: the voice for a member. A saved choice wins. Without a member, the old default:
 * an English (US/UK) female-sounding voice. With a member, each member gets its own
 * English voice (any English locale), picked by a stable hash of its id over the voices
 * sorted by name, so different members usually sound different and each stays the same.
 * Pronouns (she/he) narrow that pool to the voices known to sound that way; with none of
 * those on the device, or other pronouns, the whole pool is used.
 */
function carModePickVoice(voices, savedName, memberId, pronouns) {
  const english = (voices || []).filter((v) => /^en[-_]/i.test(v.lang || ''));
  const saved = english.find((v) => v.name === savedName);
  if (saved) return saved;
  if (memberId) {
    const all = english.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const want = carModePronounGender(pronouns);
    const matching = want ? all.filter((v) => carModeVoiceGender(v.name) === want) : [];
    const pool = matching.length ? matching : all;
    return pool.length ? pool[carModeHash(String(memberId)) % pool.length] : null;
  }
  const usuk = english.filter((v) => /^en[-_](US|GB)/i.test(v.lang || ''));
  const female =
    /female|woman|samantha|karen|victoria|zira|aria|jenny|libby|sonia|amy|serena|moira|tessa|google uk english female|google us english/i;
  return usuk.find((v) => female.test(v.name)) || usuk[0] || null;
}

/** Qualified device fallback: saved choice, exact locale/default, then a stable matching-language alternative. */
function carModeFallbackVoice(voices, savedName, language = 'en-US') {
  const norm = (value) =>
    String(value || '')
      .replace(/_/g, '-')
      .toLowerCase();
  const primary = norm(language).split('-')[0];
  const qualified = (voices || []).filter((voice) => norm(voice.lang).split('-')[0] === primary);
  const order = (a, b) => {
    const key = (voice) => `${voice.name}:${voice.voiceURI || ''}:${norm(voice.lang)}`;
    return Number(!!b.default) - Number(!!a.default) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  };
  const savedId = savedName ? qualified.find((voice) => voice.voiceURI === savedName) : null;
  if (savedId) return savedId;
  const named = savedName ? qualified.filter((voice) => voice.name === savedName) : [];
  const available = named.length ? named : qualified;
  const exact = available.filter((voice) => norm(voice.lang) === norm(language));
  return (exact.length ? exact : available).slice().sort(order)[0] || null;
}

/** The per-device storage key for one member's car-mode voice. */
function carModeVoiceKey(memberId) {
  return `reverie:carVoice:${memberId}`;
}

/** The voice menu's value for the member's own server voice (no phone voice is named this). */
const CAR_TEAM_VOICE = 'team-voice';
/** A server line not made by then is spoken by the phone (the server gives up on its voices at 20 s). */
const CAR_TEAM_FETCH_MS = 25_000;
/** A line still playing after this has stalled (600 characters is about 45 s of speech). */
const CAR_TEAM_PLAY_MS = 60_000;
/** No playback progress this long after the stream stalls: give the line to the phone. */
const CAR_TEAM_STALL_MS = 10_000;

/** One bounded request lane per chat app; cancelled work cannot overlap its replacement. */
class CarSynthesisQueue {
  constructor(deps = {}) {
    this.now = deps.now || (() => globalThis.performance?.now() ?? Date.now());
    this.set = deps.setTimeout || ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clear = deps.clearTimeout || ((timer) => globalThis.clearTimeout(timer));
    this.queue = [];
    this.active = null;
  }
  run(work, owner, valid, report) {
    if (this.queue.length >= 32) {
      report?.({ status: 'refused', queueMs: 0, requestMs: 0, requestStartMs: null, requestEndMs: null });
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const item = { work, owner, valid, report, resolve, queued: this.now(), started: null, settled: false };
      item.timer = this.set(() => {
        this.queue = this.queue.filter((value) => value !== item);
        this._settle(item, null, 'deadline');
        // An HTTP timeout/cancel is not proof the model stopped. Keep the lane
        // until the actual request settles; never start overlapping replacement work.
      }, CAR_TEAM_FETCH_MS);
      this.queue.push(item);
      this._pump();
    });
  }
  _settle(item, result, status) {
    if (item.settled) return;
    const end = this.now();
    // Timers may be delayed behind promise callbacks; completion must obey the
    // original queue-plus-request deadline regardless of callback delivery order.
    if (status === 'completed' && end - item.queued >= CAR_TEAM_FETCH_MS) {
      status = 'deadline';
      result = null;
    }
    item.settled = true;
    this.clear(item.timer);
    item.report?.({
      status,
      queueMs: (item.started ?? end) - item.queued,
      requestMs: item.started === null ? 0 : end - item.started,
      requestStartMs: item.started,
      requestEndMs: item.started === null ? null : end,
    });
    item.resolve(result);
  }
  cancel(owner) {
    this.queue = this.queue.filter((item) => {
      if (item.owner !== owner) return true;
      this._settle(item, null, 'cancelled');
      return false;
    });
    if (this.active?.owner === owner) this._settle(this.active, null, 'cancelled');
  }
  _pump() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;
    if (!item.valid() || this.now() - item.queued >= CAR_TEAM_FETCH_MS) {
      this._settle(item, null, item.valid() ? 'deadline' : 'cancelled');
      this._pump();
      return;
    }
    this.active = item;
    Promise.resolve()
      .then(() => {
        const remaining = CAR_TEAM_FETCH_MS - (this.now() - item.queued);
        if (!item.valid() || item.settled || remaining <= 0) {
          this._settle(item, null, item.valid() ? 'deadline' : 'cancelled');
          return null;
        }
        item.started = this.now();
        return item.work(remaining);
      })
      .then(
        (result) =>
          this._settle(
            item,
            item.valid() ? result : null,
            item.valid() ? (result ? 'completed' : 'unavailable') : 'cancelled'
          ),
        () => this._settle(item, null, 'unavailable')
      )
      .finally(() => {
        this.active = null;
        this._pump();
      });
  }
}

/** Reply batches use one server voice, or replay in full on one fixed device voice. */
class CarServerSynth {
  constructor(deps) {
    this.deps = deps;
    this.queue = [];
    this.current = null;
    this.gen = 0;
    this.requests = deps.requests || new CarSynthesisQueue(deps);
    this.requestOwners = new Set();
  }
  get speaking() {
    return this.current !== null;
  }
  get pending() {
    return this.queue.length > 0 || (!!this.current && this.current.index < this.current.items.length - 1);
  }

  _within(promise, ms, timedOut, after) {
    const set = this.deps.setTimeout || setTimeout,
      clear = this.deps.clearTimeout || clearTimeout;
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = set(() => {
        if (timedOut instanceof Error) reject(timedOut);
        else resolve(timedOut);
        after?.();
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clear(timer));
  }

  speak(u) {
    this.speakReply([u]);
  }
  speakReply(utterances) {
    const phoneVoice = this.deps.phoneVoice ? this.deps.phoneVoice() : utterances[0]?.voice;
    const gen = this.gen, requestOwner = {};
    const items = utterances.map(u => ({
      u,
      audio: this.requests.run(
        remaining => this.deps.fetchAudio(u.text, u, remaining), requestOwner,
        () => gen === this.gen, info => this.deps.onSynthesis?.(info)
      ),
    }));
    if (!items.length) return;
    this.requestOwners.add(requestOwner);
    this.queue.push({ items, phoneVoice, requestOwner, index: 0 });
    if (!this.current) void this._next();
  }
  cancel() {
    this.gen++;
    for (const owner of this.requestOwners) this.requests.cancel(owner);
    this.requestOwners.clear();
    this.queue = [];
    this.current = null;
    this.deps.stop();
  }

  async _next() {
    const batch = this.queue.shift();
    if (!batch) return;
    this.current = batch;
    const gen = this.gen;
    let reason = '',
      voiceKey = null,
      attempted = false,
      ok = true;
    this.deps.onVoice?.({ engine: 'server' });
    for (batch.index = 0; batch.index < batch.items.length; batch.index++) {
      const audio = await batch.items[batch.index].audio;
      if (gen !== this.gen) return;
      const url = typeof audio === 'string' ? audio : audio?.url;
      const key = typeof audio === 'object' && audio ? `${audio.engine}:${audio.voice?.id || ''}` : 'server';
      if (!url) {
        reason = 'audio-unavailable';
        break;
      }
      if (voiceKey !== null && key !== voiceKey) {
        reason = 'server-voice-changed';
        break;
      }
      voiceKey = key;
      try {
        attempted = true;
        await this._within(Promise.resolve(this.deps.play(url)), CAR_TEAM_PLAY_MS, new Error('playback stalled'));
      } catch {
        reason = 'playback-interrupted';
      }
      if (gen !== this.gen) return;
      if (reason) break;
    }
    if (reason) {
      // Never splice a different voice into the remaining sentences. Start the reply over.
      this.requests.cancel(batch.requestOwner);
      this.deps.stop();
      if (gen !== this.gen) return;
      const choice = {
        voice: batch.phoneVoice,
        employeeVoice: batch.items.map((item) => item.u.employeeVoice).find((voice) => voice?.provider === 'browser'),
      };
      if (this.deps.resolvePhoneVoice) choice.voice = this.deps.resolvePhoneVoice(choice.employeeVoice, choice.voice);
      this.deps.onVoice?.({
        engine: 'device',
        reason: choice.employeeVoice?.provider === 'browser' && !attempted ? 'selected' : reason,
        restarted: attempted,
        voice: choice.voice?.name,
        language: choice.voice?.lang,
      });
      for (batch.index = 0; batch.index < batch.items.length; batch.index++) {
        try {
          await this.deps.fallback(batch.items[batch.index].u, choice);
        } catch {
          ok = false;
        }
        if (gen !== this.gen) return;
        if (!ok) {
          this.deps.onVoice?.({ engine: 'interrupted', reason: 'device-playback-failed' });
          break;
        }
      }
    }
    this.requestOwners.delete(batch.requestOwner);
    this.current = null;
    try {
      for (const { u } of batch.items) {
        if (ok) u.onend?.();
        else u.onerror?.();
      }
    } finally {
      if (gen === this.gen && !this.current) void this._next();
    }
  }
}

/**
 * The hands-free conversation loop. States: off, listening, thinking, speaking, paused.
 * deps: { createRecognition(), synth, send(text) -> Promise, onState(state, detail),
 *         voice() -> SpeechSynthesisVoice|null, setTimeout, clearTimeout }
 */
class CarModeController {
  constructor(deps) {
    this.deps = deps;
    this.state = 'off';
    this.recognition = null;
    this.replyTimer = null;
    this.sentAt = 0;
    /** Bumped per spoken reply: only the CURRENT batch may hand back to listening. */
    this.speakGen = 0;
    /** The batch being spoken. Chrome drops queued utterances nothing else references
     *  (crbug 509488) and then never fires their onend, so the controller holds them. */
    this.utterances = [];
    this.backoffUntil = 0;
    this.restartTimer = null;
    /** No-speech timeout while listening (CAR_LISTEN_TIMEOUT_MS). */
    this.listenTimer = null;
    /** When the current utterance started being heard, and what was heard so far. */
    this.utteranceAt = 0;
    this.interim = '';
    this.errors = 0;
    /** Polls the synthesizer after a reply until it is really silent. */
    this.speechPoll = null;
    this.finalTimer = null;
    this.finalGeneration = 0;
    this.finalText = '';
  }

  _now() {
    return (this.deps.now ?? Date.now)();
  }

  _clearFinalTimer() {
    this.finalGeneration++;
    if (this.finalTimer) this.deps.clearTimeout(this.finalTimer);
    this.finalTimer = null;
  }

  _queueFinal() {
    this._clearFinalTimer();
    const generation = this.finalGeneration;
    this.finalTimer = this.deps.setTimeout(() => {
      if (generation !== this.finalGeneration || this.state !== 'listening') return;
      this.finalTimer = null;
      this._final(chatSpeechJoin(this.finalText, this.interim));
    }, CAR_FINAL_GRACE_MS);
  }

  _clearListenTimer() {
    if (this.listenTimer) this.deps.clearTimeout(this.listenTimer);
    this.listenTimer = null;
  }

  /** (Re)arm the no-speech timeout: silence for that long releases the mic. */
  _armListenTimer() {
    this._clearListenTimer();
    this.listenTimer = this.deps.setTimeout(() => {
      this.listenTimer = null;
      if (this.state !== 'listening') return;
      if (this.interim) {
        this._final(chatSpeechJoin(this.finalText, this.interim));
        return;
      }
      this._stopRecognition();
      this._set('paused', 'Tap to talk');
    }, CAR_LISTEN_TIMEOUT_MS);
  }

  /** How long the queued reply could take to say: about 15 characters a second plus a margin. */
  _expectedSpeechMs() {
    const chars = this.utterances.reduce((n, u) => n + (u.text?.length ?? 0), 0);
    return Math.min(CAR_SPEECH_WAIT_CAP_MS, Math.max(CAR_SPEECH_MIN_WAIT_MS, (chars / 15) * 1000 + 3000));
  }

  _clearSpeechPoll() {
    if (this.speechPoll) this.deps.clearTimeout(this.speechPoll);
    this.speechPoll = null;
  }

  /**
   * Back to listening only when the synthesizer itself says it is silent. Android
   * Chrome can fire an utterance's onend early, and starting recognition while she
   * is still talking takes the audio path and cuts her off mid-sentence.
   */
  _listenWhenQuiet(gen, startedAt = this._now(), capMs = this._expectedSpeechMs()) {
    this._clearSpeechPoll();
    const synth = this.deps.synth;
    const busy = synth && (synth.speaking || synth.pending);
    if (busy && this._now() - startedAt < capMs) {
      this.speechPoll = this.deps.setTimeout(() => {
        this.speechPoll = null;
        if (this.speakGen === gen && this.state === 'speaking') this._listenWhenQuiet(gen, startedAt, capMs);
      }, CAR_SPEECH_POLL_MS);
      return;
    }
    // Still "speaking" well past what the text could take: Chrome's speaking flag can
    // stick after an utterance ends, until the next cancel(). Cancel resets it.
    if (busy) synth.cancel();
    if (this.speakGen === gen && this.state === 'speaking') {
      this.utterances = [];
      this._listen();
    }
  }

  _set(state, detail = '') {
    this.state = state;
    this.deps.onState(state, detail);
  }

  start() {
    if (this.state !== 'off' && this.state !== 'paused') return;
    this._listen();
  }

  stop() {
    this.speakGen++;
    this.utterances = [];
    this._clearListenTimer();
    this._clearSpeechPoll();
    if (this.restartTimer) this.deps.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._clearReplyTimer();
    this._stopRecognition();
    this.deps.synth?.cancel();
    this._set('off');
  }

  /** A tap anywhere: listening <-> paused; while speaking or thinking, cut it short and listen. */
  tap() {
    if (this.state === 'listening') {
      this._stopRecognition();
      this._set('paused', 'Tap to talk');
    } else if (this.state === 'speaking' || this.state === 'thinking') {
      this._clearReplyTimer();
      this._clearSpeechPoll();
      this.speakGen++;
      this.utterances = [];
      this.deps.synth?.cancel();
      this._listen();
    } else {
      this._listen();
    }
  }

  /**
   * Start (or keep) listening. `restart` is the browser ending a silent session, which on
   * Android happens every 5-8 s: it re-creates the recognizer but keeps the no-speech
   * deadline, so 15 s of silence across restarts still releases the mic.
   */
  _listen({ restart = false } = {}) {
    this._set('listening');
    if (!restart) { this.finalText = ''; this.interim = ''; this.utteranceAt = 0; }
    if (!restart || !this.listenTimer) this._armListenTimer();
    if (this.recognition) return;
    const priorFinal = this.finalText;
    const rec = this.deps.createRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (event) => {
      if (this.state !== 'listening' || this.recognition !== rec) return;
      this.errors = 0;
      const snapshot = chatSpeechSnapshot(event.results);
      this._clearFinalTimer();
      this.finalText = chatSpeechJoin(priorFinal, snapshot.final);
      this.interim = snapshot.interim;
      const heard = chatSpeechJoin(this.finalText, this.interim);
      if (!heard) return;
      // Hearing something: the no-speech timeout starts over, and an utterance that
      // never ends is cut at the cap and sent as heard.
      if (!this.utteranceAt) this.utteranceAt = this._now();
      if (this._now() - this.utteranceAt >= CAR_UTTERANCE_CAP_MS) {
        this._final(chatSpeechJoin(this.finalText, this.interim));
        return;
      }
      this._armListenTimer();
      if (snapshot.final && !this.interim) this._queueFinal();
      this.deps.onState('listening', heard);
    };
    // Chrome ends a "continuous" session after a while of silence: keep it going, but
    // after a real error (no network for the speech service, no audio device) wait a
    // little, or the restart loop would spin as fast as the browser can fail.
    rec.onend = () => {
      if (this.recognition !== rec) return;
      this.recognition = null;
      if (this.state !== 'listening' || this.restartTimer) return;
      // A backoff covers the one failed session it was set for, then is used up.
      const wait = this.backoffUntil - Date.now();
      this.backoffUntil = 0;
      if (wait <= 0) {
        this._listen({ restart: true });
        return;
      }
      this.restartTimer = this.deps.setTimeout(() => {
        this.restartTimer = null;
        if (this.state === 'listening' && !this.recognition) this._listen({ restart: true });
      }, wait);
    };
    rec.onerror = (event) => {
      if (this.recognition !== rec) return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this._stopRecognition();
        this._set('paused', 'Microphone access was refused');
        return;
      }
      // 'no-speech' and 'aborted' just end the session; onend restarts it at once.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this.backoffUntil = Date.now() + CAR_RETRY_BACKOFF_MS;
        // Failing again and again (no network for the speech service, mic in use):
        // stop and show a state the user can tap, rather than retrying out of sight.
        if (++this.errors >= CAR_MAX_ERRORS) {
          this.errors = 0;
          this._clearListenTimer();
          this._stopRecognition();
          this._set('paused', `Speech recognition failed (${event.error}). Tap to try again`);
        }
      }
    };
    this.recognition = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  _stopRecognition() {
    this._clearFinalTimer();
    this.finalText = '';
    const rec = this.recognition;
    this.recognition = null;
    if (!rec) return;
    // Detach everything: an aborted recognizer can still deliver a late result, which
    // must not send a turn or knock the state out of "speaking".
    rec.onend = null;
    rec.onresult = null;
    rec.onerror = null;
    try {
      rec.abort();
    } catch {
      /* not running */
    }
  }

  async _final(text) {
    const generation = ++this.speakGen;
    // Stop listening while she thinks and speaks, so she is never transcribed.
    this._clearListenTimer();
    this.interim = '';
    this.utteranceAt = 0;
    this._stopRecognition();
    this._set('thinking', text);
    this.sentAt = Date.now();
    try {
      if (await this.deps.send(text) === false) return;
    } catch (err) {
      if (generation !== this.speakGen || this.state !== 'thinking') return;
      this._set('paused', `${err?.unconfirmed ? 'Not confirmed' : 'Not sent'}: ${err?.message || err}`);
      return;
    }
    if (generation !== this.speakGen || this.state !== 'thinking') return;
    this._clearReplyTimer();
    this.replyTimer = this.deps.setTimeout(() => {
      this.replyTimer = null;
      if (this.state === 'thinking') this._listen();
    }, CAR_REPLY_TIMEOUT_MS);
  }

  /** The voice member answered: speak it, then listen again. */
  reply(text, link = {}) {
    if (this.state === 'off' || this.state === 'paused') return false;
    this._clearReplyTimer();
    this._stopRecognition();
    const parts = carModeUtterances(carModeSpeakable(text));
    const synth = this.deps.synth;
    if (!parts.length || !synth) {
      this._listen();
      return true;
    }
    // A reply that arrives while she is still speaking is QUEUED behind the current one,
    // never cancels it. Only the newest batch's last utterance hands back to listening;
    // an earlier batch ending is ignored (its generation is stale).
    const queueing = this.state === 'speaking';
    this._set('speaking', text);
    const gen = ++this.speakGen;
    // Android Chrome's cancel() is asynchronous and also kills an utterance spoken right
    // after it, so cancel only when something is actually playing, and then speak a
    // moment later.
    let delay = 0;
    if (!queueing) {
      if (synth.speaking || synth.pending) {
        synth.cancel();
        delay = 300;
      }
      this.utterances = [];
    }
    this._clearListenTimer();
    const done = () => {
      if (this.speakGen === gen && this.state === 'speaking') this._listenWhenQuiet(gen);
    };
    const voice = this.deps.voice();
    const batch = parts.map((part, i) => {
      const u = this.deps.createUtterance(part);
      if (link.turnId) u.turnId = link.turnId;
      if (link.messageId) u.replyMessageId = link.messageId;
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      if (i === parts.length - 1) {
        u.onend = done;
        u.onerror = done;
      }
      return u;
    });
    this.utterances = this.utterances.concat(batch);
    const speakAll = () => {
      if (this.speakGen !== gen || this.state !== 'speaking') return;
      if (synth.speakReply) synth.speakReply(batch);
      else for (const u of batch) synth.speak(u);
    };
    if (delay) this.deps.setTimeout(speakAll, delay);
    else speakAll();
    return true;
  }

  _clearReplyTimer() {
    if (this.replyTimer) this.deps.clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }
}

const CAR_STATUS = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  paused: 'Paused',
  off: 'Off',
};

/** Owns only the screen lock; it never starts audio, changes phone settings or retries forever. */
class CarScreenWakeLock {
  constructor(deps) {
    this.deps = deps;
    this.active = false;
    this.generation = 0;
    this.lock = null;
    this.pending = null;
    this.retryTimer = null;
    this.attempts = 0;
    this.onVisibility = () => {
      if (!this.active) return;
      this.generation++;
      this.pending = null;
      this._clearRetry();
      this._release();
      this.attempts = 0;
      if (this.deps.visible()) void this.acquire();
      else this.deps.status(false, 'Screen may sleep while this tab is hidden.');
    };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.deps.addVisibility(this.onVisibility);
    return this.acquire();
  }

  stop() {
    this.active = false;
    this.generation++;
    this.pending = null;
    this._clearRetry();
    this.deps.removeVisibility(this.onVisibility);
    this._release();
  }

  retry() {
    this.attempts = 0;
    return this.acquire();
  }

  _clearRetry() {
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  _release() {
    const held = this.lock;
    this.lock = null;
    if (!held) return;
    held.sentinel.removeEventListener('release', held.onRelease);
    if (!held.sentinel.released) Promise.resolve(held.sentinel.release()).catch(() => {});
  }

  async acquire() {
    if (!this.active || this.lock || this.pending) return;
    if (!this.deps.visible()) {
      this.deps.status(false, 'Screen may sleep while this tab is hidden.');
      return;
    }
    if (!this.deps.secure) {
      this.deps.status(false, 'Screen may sleep: open Reverie over HTTPS to keep it awake.');
      return;
    }
    if (!this.deps.request) {
      this.deps.status(false, 'Screen may sleep: wake lock is unavailable in this browser.');
      return;
    }
    if (this.attempts >= 3) {
      this.deps.status(false, 'Screen lock keeps dropping. Tap Retry or check your screen timeout settings.');
      return;
    }
    const token = { generation: this.generation };
    this.pending = token;
    this.attempts++;
    this.deps.status(false, 'Requesting screen lock…');
    try {
      const sentinel = await this.deps.request();
      if (!this.active || token.generation !== this.generation || !this.deps.visible()) {
        if (!sentinel.released) await sentinel.release();
        return;
      }
      if (sentinel.released) throw new Error('released');
      const onRelease = () => {
        if (this.lock?.sentinel !== sentinel) return;
        this.lock = null;
        this.deps.status(false, 'Screen lock released; the screen may sleep.');
        if (this.active && this.deps.visible()) {
          this._clearRetry();
          const generation = this.generation;
          this.retryTimer = this.deps.setTimeout(() => {
            this.retryTimer = null;
            if (this.active && generation === this.generation) void this.acquire();
          }, 1000);
        }
      };
      this.lock = { sentinel, onRelease };
      sentinel.addEventListener('release', onRelease, { once: true });
      this.deps.status(true, 'Screen kept awake');
    } catch {
      if (this.active && token.generation === this.generation) {
        this.deps.status(false, 'Screen lock was refused. Tap Retry or check your screen timeout settings.');
      }
    } finally {
      if (this.pending === token) this.pending = null;
    }
  }
}

Object.assign(ReverieApp.prototype, {
  /** The member car mode talks to: the one marked as the room's voice, or a DM's agent (chatVoiceMember). */
  _carVoiceMember() {
    if (typeof chatVoiceMember === 'function') return chatVoiceMember(this._chatRoom);
    return this._chatRoom?.members.find((m) => m.voice === true) || null;
  },

  async openCarMode() {
    if (this._chatApp?.embassy?.selected || document.hidden) return;
    // Idempotent: a second open (a double tap, the restore after a reload racing a
    // click) must never leave two recognizers listening and sending the same words.
    if (this._carOpening || (this._car && this._carScreen && !this._carScreen.hidden)) return;
    // Opening is usually a tap: unlock the audio element now, inside the gesture, so the
    // team voice can play (a reopen after a reload is not a gesture: the phone voice
    // speaks until the next tap).
    this._unlockChatAudio?.();
    this._carOpening = true;
    try {
      await this._openCarMode();
    } finally {
      this._carOpening = false;
    }
  },

  async _openCarMode() {
    const roomId = this._chatRoomId, generation = this._carOpenGeneration;
    if (!this.isChatroomOpen?.()) await this.openChatroom?.();
    if (roomId !== this._chatRoomId || generation !== this._carOpenGeneration || this._chatApp?.embassy?.selected || document.hidden) return;
    const member = this._carVoiceMember();
    if (!member) {
      this.showToast?.('Mark a member as Voice in the chat panel first', 'info');
      return;
    }
    this._setRoomVoiceMode?.('car');
    const revision = this._voiceModeRevision;
    const engine = carModeEngine(window);
    if (engine === 'server' && this._hfProbeService) {
      if (!this._hfService || this._hfService.state === 'checking') await this._hfProbeService();
      if (this._hfService?.state !== 'ready') {
        this._hfRender?.('unavailable');
        this.showToast?.(this._hfService?.message || 'Whisper/Piper speech service is unavailable', 'error');
        return;
      }
    }
    // A probe may resolve after Off, a room switch or an external view was selected.
    if (generation !== this._carOpenGeneration || revision !== this._voiceModeRevision || roomId !== this._chatRoomId || this._roomVoiceMode?.() !== 'car' || !this.isChatroomOpen?.() || this._chatApp?.embassy?.selected || document.hidden) return;
    this._carRoomId = roomId;
    this._buildCarMode(member);
    this._carEngine = engine;
    const diagButton = this._carScreen?.querySelector('.car-diag');
    const engineInfo = this._voiceEngineInfo?.();
    if (diagButton) diagButton.title = `Engine: ${engine}. ${engineInfo?.reason || ''}`;
    this._diag?.('voice:engine', this._voiceEngineInfo?.() || { engine, reason: engine === 'speech' ? 'Browser SpeechRecognition and synthesis are available' : 'Browser speech API unavailable; server selected' });
    this._carScreen.hidden = false;
    document.documentElement.classList.add('car-mode-open');
    clearInterval(this._carSpeakerTimer);
    this._carSpeakerTimer = setInterval(() => this._renderCarSpeaker(), CAR_SPEAKER_MS);
    this._keepCarScreenAwake();
    this._car?.stop();
    this._carTurn = null;
    if (this._carEngine === 'speech') {
      const synth = window.speechSynthesis;
      const diag = (kind, data) => this._diag?.(kind, data);
      const flags = () => ({ speaking: !!synth.speaking, pending: !!synth.pending });
      // Every recognizer, utterance and synthesizer call is traced for "Send diagnostics".
      const tracedSynth = {
        get speaking() {
          return synth.speaking;
        },
        get pending() {
          return synth.pending;
        },
        speak: (u) => {
          diag('tts:speak', { chars: u.text?.length, ...flags() });
          this._carVoiceNotice({ engine: 'device', reason: 'selected', voice: u.voice?.name, language: u.voice?.lang });
          synth.speak(u);
        },
        cancel: () => {
          diag('tts:cancel', flags());
          synth.cancel();
        },
      };
      const app = this;
      const teamSynth = this._carTeamSynth(synth, diag);
      let recCount = 0;
      this._car = new CarModeController({
        createRecognition: () => {
          const rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
          const n = ++recCount;
          for (const type of ['start', 'end', 'audiostart', 'audioend', 'speechstart', 'speechend']) {
            rec.addEventListener?.(type, () => diag(`rec${n}:${type}`, flags()));
          }
          rec.addEventListener?.('error', (e) => diag(`rec${n}:error`, { error: e.error, ...flags() }));
          rec.addEventListener?.('result', (e) => {
            const last = e.results?.[e.results.length - 1];
            diag(`rec${n}:result`, { final: !!last?.isFinal, chars: last?.[0]?.transcript?.length ?? 0 });
          });
          return rec;
        },
        createUtterance: (text) => {
          // A server-voice line is a plain record; CarServerSynth calls its onend/onerror.
          if (this._carUsesTeamVoice()) return { text, voice: null, lang: '', onend: null, onerror: null };
          const u = new SpeechSynthesisUtterance(text);
          let boundaries = 0;
          u.addEventListener?.('start', () => diag('tts:start', { chars: text.length, ...flags() }));
          u.addEventListener?.('end', (e) =>
            diag('tts:end', { elapsed: Math.round(e?.elapsedTime ?? -1), boundaries, ...flags() })
          );
          u.addEventListener?.('error', (e) => diag('tts:error', { error: e?.error, ...flags() }));
          u.addEventListener?.('boundary', () => boundaries++);
          return u;
        },
        get synth() {
          return app._carUsesTeamVoice() ? teamSynth : tracedSynth;
        },
        voice: () => this._carVoice(),
        send: (text) => this._carSend(text),
        onState: (state, detail) => {
          diag('car:state', { state, ...flags() });
          this._renderCarState(state, detail);
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t),
      });
      this._car.start();
    } else {
      this._renderCarState('paused', 'Tap anywhere to talk, tap again to send');
    }
  },

  closeCarMode({ preserveMode = false } = {}) {
    this._carOpenGeneration = (this._carOpenGeneration || 0) + 1;
    this._carTurn = null;
    if (!this._carScreen || this._carScreen.hidden) return;
    if (!preserveMode) this._setRoomVoiceMode?.('off');
    if (this._hfStream) this._hfClose?.('car-closed');
    this._car?.stop();
    this._car = null;
    this._stopChatRecording?.();
    this._carScreen.hidden = true;
    document.documentElement.classList.remove('car-mode-open');
    clearInterval(this._carSpeakerTimer);
    this._carSpeakerTimer = null;
    this._carAwake?.stop();
    this._carAwake = null;
    try {
      localStorage.removeItem('reverie:carMode');
    } catch {
      /* per-device convenience only */
    }
  },

  /** Reopen car mode after a reload if it was on when the page went away. */
  _restoreCarMode() {
    this._hfTick?.();
  },

  _keepCarScreenAwake() {
    if (!this._carAwake) {
      this._carAwake = new CarScreenWakeLock({
        secure: window.isSecureContext === true,
        visible: () => document.visibilityState === 'visible',
        request: navigator.wakeLock?.request ? () => navigator.wakeLock.request('screen') : null,
        addVisibility: (fn) => document.addEventListener('visibilitychange', fn),
        removeVisibility: (fn) => document.removeEventListener('visibilitychange', fn),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (timer) => clearTimeout(timer),
        status: (held, text) => {
          const notice = this._carScreen?.querySelector('.car-wake-notice');
          if (!notice) return;
          notice.hidden = held;
          notice.querySelector('.car-wake-text').textContent = text;
          this._carScreen.dataset.screenAwake = held ? 'held' : 'unavailable';
        },
      });
    }
    return this._carAwake.start();
  },

  _carTurnCurrent(turn) {
    const mode = this._roomVoiceMode?.();
    return !!turn && this._carTurn === turn && this._car === turn.controller &&
      this._car?.state === 'thinking' && this._car.speakGen === turn.generation &&
      this._chatRoomId === turn.roomId && this._carVoiceMember()?.sessionId === turn.memberId &&
      this._carOpenGeneration === turn.openGeneration && !this._carScreen?.hidden &&
      !this._chatApp?.embassy?.selected && (mode === undefined || mode === 'car');
  },

  async _carSend(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('No speech was recognized; nothing was posted');
    const member = this._carVoiceMember();
    if (!member) throw new Error('no voice member');
    const turn = { roomId: this._chatRoomId, memberId: member.sessionId,
      controller: this._car, generation: this._car?.speakGen, openGeneration: this._carOpenGeneration,
      started: globalThis.performance?.now?.() ?? Date.now(), id: null, early: [], overflow: false, answered: false };
    this._carTurn = turn;
    if (!this._carTurnCurrent(turn)) { this._carTurn = null; throw new Error('Car conversation is no longer active'); }
    this._diag?.('voice:post-start', { roomId: turn.roomId, memberId: turn.memberId, generation: turn.generation, openGeneration: turn.openGeneration, chars: text.length });
    const unconfirmed = (message) => Object.assign(new Error(message), { unconfirmed: true });
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let res, confirmationTimer;
    try {
      res = await Promise.race([
        this._chatApi(`/api/chatrooms/${encodeURIComponent(turn.roomId)}/messages`, {
          method: 'POST', body: { text, to: [turn.memberId], spoken: true }, signal: abort?.signal,
        }),
        new Promise((_, reject) => {
          confirmationTimer = setTimeout(() => {
            abort?.abort();
            reject(new Error('Message confirmation timed out'));
          }, CAR_POST_CONFIRM_MS);
        }),
      ]);
    } catch {
      if (this._carTurn === turn) this._carTurn = null;
      throw unconfirmed('Message confirmation was lost. Check the room before trying again.');
    } finally {
      clearTimeout(confirmationTimer);
    }
    if (!this._carTurnCurrent(turn)) {
      if (this._carTurn === turn) this._carTurn = null;
      return false;
    }
    if (!res?.ok) {
      this._carTurn = null;
      if (res?.status >= 400 && res.status < 500) throw new Error(res.error || 'Voice message was refused');
      throw unconfirmed('Message confirmation was lost. Check the room before trying again.');
    }
    const posted = res.data?.message;
    if (typeof posted?.id !== 'string' || !posted.id || posted.roomId !== turn.roomId ||
        posted.from?.kind !== 'user' || posted.spoken !== true || !Array.isArray(posted.to) || !posted.to.includes(turn.memberId)) {
      this._carTurn = null;
      throw unconfirmed('No matching message confirmation. Check the room before trying again.');
    }
    turn.id = posted.id;
    this._diag?.('voice:post-confirmed', { roomId: turn.roomId, memberId: turn.memberId, messageId: turn.id, generation: turn.generation, openGeneration: turn.openGeneration,
      elapsedMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - turn.started) });
    const early = turn.early.find(message => message.replyTo === turn.id);
    turn.early = [];
    if (early) this._carModeOnMessage({ roomId: turn.roomId, message: early });
    else if (turn.overflow) {
      this._carTurn = null;
      throw unconfirmed('Too many early replies to confirm the answer. Check the room.');
    }
  },

  /** Car conversations read only an exact answer to their acknowledged spoken turn. */
  _carModeOnMessage(data) {
    if (!this._car || this._carScreen?.hidden) return;
    const m = data?.message, turn = this._carTurn;
    if (!m || typeof m.id !== 'string' || !m.id || !this._carTurnCurrent(turn) || turn.answered || m.deleted || data.roomId !== turn.roomId) return;
    if (m.from?.kind !== 'agent' || m.from.sessionId !== turn.memberId || m.voice) return;
    if (m.to !== 'all' && (!Array.isArray(m.to) || !m.to.includes('user'))) return;
    if (typeof m.replyTo !== 'string' || !m.replyTo) return;
    if (!turn.id) {
      if (turn.early.some(message => message.id === m.id)) return;
      if (turn.early.length < 32) turn.early.push(m);
      else turn.overflow = true;
      return;
    }
    if (m.replyTo !== turn.id) return;
    const phrase = typeof chatAttachmentPhrase === 'function' ? chatAttachmentPhrase(m.attachments) : '';
    const spokenText = [m.text, phrase ? `${m.from.name.split(': ').pop()} ${phrase}.` : ''].filter(Boolean).join(' ');
    turn.answered = true;
    this._diag?.('voice:linked-reply', { roomId: turn.roomId, memberId: turn.memberId, messageId: m.id, replyTo: turn.id,
      elapsedMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - turn.started) });
    this._car.reply(spokenText, { turnId: turn.id, messageId: m.id });
  },

  /** The member's own server voice is chosen in the menu (the default). */
  _carUsesTeamVoice() {
    const select = this._carScreen?.querySelector('.car-voice');
    return !select || !select.value || select.value === CAR_TEAM_VOICE;
  },

  /** The server-voice synthesizer: Kokoro audio on the chat panel's one unlocked audio element. */
  _carTeamSynth(synth, diag) {
    let settle = null;
    const stopPhone = () => {
      if (synth.speaking || synth.pending) synth.cancel();
    };
    this._carSynthesisQueue ||= new CarSynthesisQueue();
    return new CarServerSynth({
      requests: this._carSynthesisQueue,
      onSynthesis: info => diag('team:synthesis', info),
      phoneVoice: () => carModeFallbackVoice(synth.getVoices?.() || [], this._carSavedVoice(this._carVoiceMember()?.sessionId)),
      resolvePhoneVoice: (choice, fallback) => (choice?.provider === 'browser' ? synth.getVoices?.().find(voice => voice.voiceURI === choice.id || voice.name === choice.id) : null) || fallback,
      onVoice: info => { diag('team:voice', info); this._carVoiceNotice(info); },
      fetchAudio: async (text, utterance, remaining = CAR_TEAM_FETCH_MS) => {
        const member = this._carVoiceMember();
        if (!member) return null;
        const started = globalThis.performance?.now?.() ?? Date.now();
        const link = { turnId: utterance?.turnId, messageId: utterance?.replyMessageId };
        diag('team:request', { ...link, chars: text.length });
        const res = await this._chatApi('/api/voice/speak', {
          method: 'POST',
          body: { room: this._chatRoomId, member: member.sessionId, text },
          signal: AbortSignal.timeout?.(Math.max(1, Math.ceil(remaining))),
        });
        diag('team:speak', { ...link, ok: res.ok, engine: res.data?.engine, voice: res.data?.voice?.id,
          chars: text.length, audioUrl: res.data?.audioUrl,
          elapsedMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - started) });
        if (res.ok && res.data?.voice?.provider === 'browser' && utterance) utterance.employeeVoice = res.data.voice;
        return res.ok && typeof res.data?.audioUrl === 'string' ? { url: res.data.audioUrl, engine: res.data.engine, voice: res.data.voice } : null;
      },
      play: (url) =>
        new Promise((resolve, reject) => {
          const audio = this._chatAudioEl();
          // A stream that stops arriving fires 'stalled' or 'waiting', then nothing: give it
          // CAR_TEAM_STALL_MS of no progress before the phone voice takes the line.
          let stallTimer = null, finished = false;
          const clearStall = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = null;
          };
          const onStall = () => {
            clearStall();
            const position = audio.currentTime;
            stallTimer = setTimeout(() => {
              if (audio.currentTime > position) { onStall(); return; }
              diag('team:stalled', {});
              audio.pause();
              done(new Error('audio stalled'));
            }, CAR_TEAM_STALL_MS);
          };
          const done = (err) => {
            if (finished) return;
            finished = true;
            clearStall();
            audio.removeEventListener('ended', onEnd);
            audio.removeEventListener('error', onError);
            audio.removeEventListener('stalled', onStall);
            audio.removeEventListener('waiting', onStall);
            audio.removeEventListener('timeupdate', clearStall);
            audio.removeEventListener('playing', clearStall);
            settle = null;
            if (err) reject(err);
            else resolve();
          };
          const onEnd = () => done(Number.isFinite(audio.duration) && audio.duration - audio.currentTime > 0.5 ? new Error('audio ended early') : null);
          const onError = () => done(new Error('audio error'));
          settle = () => done(null);
          audio.addEventListener('ended', onEnd);
          audio.addEventListener('error', onError);
          audio.addEventListener('stalled', onStall);
          audio.addEventListener('waiting', onStall);
          audio.addEventListener('timeupdate', clearStall);
          audio.addEventListener('playing', clearStall);
          // A line from the car or read aloud: not a spoken turn's answer (_carSpeakerId).
          this._chatAudioFrom = null;
          audio.src = this._chatUrl(url);
          audio.play().then(
            () => (this._chatAudioUnlocked = true),
            (err) => {
              diag('team:play-refused', { error: err?.name });
              done(err || new Error('play refused'));
            }
          );
        }),
      stop: () => {
        const audio = this._chatAudio;
        if (audio && !audio.paused) audio.pause();
        settle?.();
        stopPhone();
      },
      fallback: (u, fixed) =>
        new Promise((resolve, reject) => {
          const p = new SpeechSynthesisUtterance(u.text);
          const voice = fixed.voice;
          if (!voice) { reject(new Error('No matching device voice is available')); return; }
          if (voice) {
            p.voice = voice;
            p.lang = voice.lang;
          }
          p.onend = () => resolve();
          p.onerror = (e) => reject(e);
          // Held so Chrome does not drop it before it ends (crbug 509488).
          this._carFallbackUtterance = p;
          diag('team:fallback', { chars: u.text?.length });
          synth.speak(p);
        }),
    });
  },

  _carVoiceNotice(info) {
    const notice = this._carScreen?.querySelector?.('.car-voice-notice');
    if (!notice) return;
    const voice = info.voice ? ` (${info.voice}${info.language ? `, ${info.language}` : ''})` : '';
    const text = info.engine === 'server' ? 'Team voice' : info.engine === 'interrupted' ? 'Reply interrupted: device audio could not finish. The reply remains in chat.' :
      info.reason === 'selected' ? `Device voice${voice}` : info.restarted ? `Team audio interrupted. Replaying this reply from the start in device voice${voice}.` : `Using device voice${voice}: team audio unavailable.`;
    notice.hidden = false; notice.dataset.engine = info.engine;
    if (notice.textContent !== text) notice.textContent = text;
  },

  /** The phone voice (the team voice's backup): one chosen for this member on this device, else the member's default. */
  _carVoice() {
    const member = this._carVoiceMember();
    const id = member?.sessionId;
    return carModePickVoice(window.speechSynthesis?.getVoices?.() || [], this._carSavedVoice(id), id, member?.pronouns);
  },

  _carSavedVoice(id) {
    try {
      return id ? localStorage.getItem(carModeVoiceKey(id)) : null;
    } catch {
      return null;
    }
  },

  _buildCarMode(member) {
    if (!this._carScreen) {
      const screen = document.createElement('div');
      screen.className = 'car-mode';
      screen.id = 'carMode';
      screen.hidden = true;
      screen.setAttribute('role', 'dialog');
      screen.setAttribute('aria-label', 'Car mode');
      screen.setAttribute('data-i18n-skip', '');
      const bar = document.createElement('div');
      bar.className = 'car-bar';
      const who = document.createElement('span');
      who.className = 'car-who';
      const voice = document.createElement('select');
      voice.className = 'car-voice';
      voice.setAttribute('aria-label', 'Speaking voice');
      // Owner 10-20: no voice menu in the car. Each teammate speaks in their own voice; the
      // phone voice is only the backup (kept here, hidden, so a choice made earlier still holds).
      voice.hidden = true;
      voice.onchange = () => {
        const id = this._carVoiceMember()?.sessionId;
        if (!id) return;
        try {
          localStorage.setItem(carModeVoiceKey(id), voice.value);
        } catch {
          /* per-device convenience only */
        }
      };
      const exit = document.createElement('button');
      exit.type = 'button';
      exit.className = 'car-exit';
      exit.textContent = 'Exit';
      exit.onclick = (e) => {
        e.stopPropagation();
        this.closeCarMode();
      };
      const diagBtn = document.createElement('button');
      diagBtn.type = 'button';
      diagBtn.className = 'car-exit car-diag';
      diagBtn.textContent = 'Diag';
      diagBtn.title = 'Send diagnostics';
      diagBtn.onclick = (e) => {
        e.stopPropagation();
        this.sendChatDiagnostics?.();
      };
      const build = document.createElement('span');
      build.className = 'car-build';
      bar.append(who, voice, build, diagBtn, exit);
      const pad = document.createElement('button');
      pad.type = 'button';
      pad.className = 'car-pad';
      // Whoever is speaking, as on a video call: their avatar and name (_renderCarSpeaker).
      const speaker = document.createElement('span');
      speaker.className = 'car-speaker';
      speaker.hidden = true;
      // display is set only while shown: an inline display would override the hidden attribute.
      speaker.style.cssText = 'flex-direction:column;align-items:center;gap:8px;font-size:22px;';
      const status = document.createElement('span');
      status.className = 'car-status';
      const detail = document.createElement('span');
      detail.className = 'car-detail';
      const hint = document.createElement('span');
      hint.className = 'car-hint';
      pad.append(speaker, status, detail, hint);
      pad.onclick = () => this._carTap();
      const awake = document.createElement('div');
      awake.className = 'car-wake-notice';
      awake.setAttribute('role', 'status');
      awake.style.cssText = 'padding:8px 14px;background:#3d330b;color:#fff;font-size:14px;';
      const awakeText = document.createElement('span');
      awakeText.className = 'car-wake-text';
      awakeText.textContent = 'Requesting screen lock…';
      const retryAwake = document.createElement('button');
      retryAwake.type = 'button';
      retryAwake.className = 'car-exit';
      retryAwake.textContent = 'Retry keep awake';
      retryAwake.style.cssText = 'margin-left:8px;padding:4px 8px;font-size:14px;min-height:44px;';
      retryAwake.onclick = (event) => {
        event.stopPropagation();
        void this._carAwake?.retry();
      };
      awake.append(awakeText, retryAwake);
      const voiceNotice = document.createElement('div');
      voiceNotice.className = 'car-voice-notice'; voiceNotice.hidden = true;
      voiceNotice.setAttribute('role', 'status'); voiceNotice.setAttribute('aria-live', 'polite');
      voiceNotice.style.cssText = 'padding:4px 14px;color:#ddd;font-size:14px;';
      screen.append(bar, awake, voiceNotice, pad);
      document.body.append(screen);
      this._carScreen = screen;
      const fillVoices = () => this._fillCarVoices();
      window.speechSynthesis?.addEventListener?.('voiceschanged', fillVoices);
    }
    this._carScreen.querySelector('.car-who').textContent = `${member.icon ? `${member.icon} ` : ''}${member.name}`;
    this._carScreen.querySelector('.car-build').textContent = (this._pageBuildId || '').slice(0, 8);
    const voiceNotice = this._carScreen.querySelector('.car-voice-notice');
    if (voiceNotice) { voiceNotice.hidden = true; voiceNotice.textContent = ''; }
    this._fillCarVoices();
  },

  _fillCarVoices() {
    const select = this._carScreen?.querySelector('.car-voice');
    if (!select) return;
    const voices = (window.speechSynthesis?.getVoices?.() || []).filter((v) => /^en[-_]/i.test(v.lang || ''));
    select.replaceChildren(
      new Option('Team voice', CAR_TEAM_VOICE),
      ...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.name))
    );
    // Always the team voice; a phone voice chosen on this device is its backup (_carVoice).
    select.value = CAR_TEAM_VOICE;
  },

  _carTap() {
    if (this._carEngine === 'speech') {
      // A tap is a gesture: it lets the team voice play on browsers that need one first.
      this._unlockChatAudio?.();
      this._car?.tap();
      return;
    }
    // Server engine: hands-free listens, else the whole screen is the push-to-talk button (tap, speak, tap).
    this._unlockChatAudio?.();
    const member = this._carVoiceMember();
    if (!member) return;
    // Push-to-talk (/api/voice/turn) answers only a member marked as the voice; a DM's
    // agent is the voice here without that mark.
    if (member.voice !== true) {
      this._renderCarState('paused', 'Talking in a direct message needs a browser with speech recognition');
      return;
    }
    // Waiting for an answer: this tap stops the wait (the next one talks again).
    if (this._chatVoiceTurnStop) {
      this._chatVoiceTurnStop.abort();
      return;
    }
    // Hands-free (hands-free.js) listens on its own: a tap pauses it, the next listens again.
    if (this._carHandsFree?.() && this._chatRecorder?.state !== 'recording') {
      this._carHfPaused = !this._carHfPaused;
      this._diag?.('car:handsfree', { paused: this._carHfPaused });
      this._hfTick?.();
      return;
    }
    if (this._chatRecorder?.state === 'recording') {
      this._stopChatRecording();
      this._renderCarState('thinking', '');
      return;
    }
    this._chatEls.to.value = member.sessionId;
    this._syncChatMic?.();
    this._startChatRecording();
    this._renderCarState('listening', 'Tap again to send');
  },

  /**
   * Who is speaking now: a line being read aloud (its author), the car's own spoken
   * answer (the voice member), or a spoken turn's answer on the chat audio element.
   */
  _carSpeakerId() {
    const read = this._readAloud?.current?.item?.meta?.member;
    if (read) return read;
    if (this._car?.state === 'speaking') return this._carVoiceMember?.()?.sessionId || null;
    const a = this._chatAudio;
    if (a && !a.paused && !a.ended && this._chatAudioFrom) return this._chatAudioFrom;
    return null;
  },

  /** The car screen shows the speaker's avatar and name while they speak, nothing otherwise. */
  _renderCarSpeaker() {
    const el = this._carScreen?.querySelector('.car-speaker');
    if (!el) return;
    const id = this._carScreen.hidden ? null : this._carSpeakerId();
    if (el.dataset.member === (id || '')) return;
    el.dataset.member = id || '';
    const name = id ? this._chatMember?.(id)?.name : null;
    if (!name) {
      el.hidden = true;
      el.style.display = '';
      el.replaceChildren();
      return;
    }
    const avatar = this._chatAvatar?.(id, name);
    // Large on the car screen, inline so no stylesheet changes with it.
    if (avatar) avatar.style.cssText += 'width:96px;height:96px;font-size:48px;';
    const label = document.createElement('span');
    label.className = 'car-speaker-name';
    label.textContent = name;
    el.replaceChildren(...(avatar ? [avatar] : []), label);
    el.hidden = false;
    el.style.display = 'flex';
  },

  _renderCarState(state, detail) {
    const screen = this._carScreen;
    if (!screen) return;
    screen.dataset.state = state;
    screen.querySelector('.car-status').textContent = CAR_STATUS[state] || state;
    screen.querySelector('.car-detail').textContent = detail || '';
    const hint =
      this._carEngine === 'speech'
        ? state === 'listening'
          ? 'Just talk. Tap anywhere to pause.'
          : state === 'speaking'
            ? 'Tap to interrupt'
            : state === 'paused'
              ? 'Tap anywhere to listen'
              : 'Tap to stop waiting and listen'
        : state === 'thinking'
          ? 'Tap to stop waiting'
          : this._carHandsFree?.()
            ? state === 'listening'
              ? 'Just talk, pause to send. Tap anywhere to pause.'
              : 'Tap anywhere to listen'
            : 'Tap anywhere to talk, tap again to send';
    screen.querySelector('.car-hint').textContent = hint;
  },
});
