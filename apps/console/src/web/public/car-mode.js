/**
 * @fileoverview Car mode: a full-screen, hands-free conversation with the room's voice
 * member (the member marked `voice`), built for a phone in a car.
 *
 * Two engines, chosen by what the browser offers:
 * - `speech` (Android Chrome, desktop Chrome): the browser's SpeechRecognition listens
 *   continuously with its own voice-activity detection. A final transcript is posted
 *   as an ordinary room message (`spoken: true`, so the member answers it like a typed
 *   one), the member's reply is spoken with `speechSynthesis` (the phone's own voice:
 *   nothing to download, no autoplay policy, nothing to truncate), and listening
 *   pauses while she speaks so she is never transcribed, then resumes on its own.
 * - `server` (no SpeechRecognition): the whole screen is the push-to-talk button of
 *   the chat panel (tap to talk, tap to send), using the /api/voice/turn path.
 *
 * A tap anywhere toggles listening; a tap while she speaks cuts her off and listens.
 * The mode is remembered per device (`codeman:carMode`) and the screen is kept awake.
 *
 * `CarModeController` is the state machine with every browser API injected, so it is
 * unit-tested with fakes (test/car-mode.test.ts); the rest is DOM glue.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js, chatroom-ui.js (_chatApi, _chatRoom, push-to-talk helpers), voice-chat.js (snapshot helpers)
 * @loadorder 12.12 (after voice-chat.js)
 */

/** How long to wait for the member's answer before listening again. */
const CAR_REPLY_TIMEOUT_MS = 180_000;
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

/** Pure: the default voice: an English female-sounding one if the platform names one. */
function carModePickVoice(voices, savedName) {
  const english = (voices || []).filter((v) => /^en[-_](US|GB)/i.test(v.lang || ''));
  const saved = english.find((v) => v.name === savedName);
  if (saved) return saved;
  const female =
    /female|woman|samantha|karen|victoria|zira|aria|jenny|libby|sonia|amy|serena|moira|tessa|google uk english female|google us english/i;
  return english.find((v) => female.test(v.name)) || english[0] || null;
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
    // Stop listening while she thinks and speaks, so she is never transcribed.
    this._clearListenTimer();
    this.interim = '';
    this.utteranceAt = 0;
    this._stopRecognition();
    this._set('thinking', text);
    this.sentAt = Date.now();
    try {
      await this.deps.send(text);
    } catch (err) {
      this._set('paused', `Not sent: ${err?.message || err}`);
      return;
    }
    this._clearReplyTimer();
    this.replyTimer = this.deps.setTimeout(() => {
      this.replyTimer = null;
      if (this.state === 'thinking') this._listen();
    }, CAR_REPLY_TIMEOUT_MS);
  }

  /** The voice member answered: speak it, then listen again. */
  reply(text) {
    if (this.state === 'off' || this.state === 'paused') return false;
    this._clearReplyTimer();
    this._stopRecognition();
    const parts = carModeUtterances(text);
    if (!parts.length || !this.deps.synth) {
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
      const synth = this.deps.synth;
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
    const batch = parts.map((part, i) => {
      const u = this.deps.createUtterance(part);
      const voice = this.deps.voice();
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
      for (const u of batch) this.deps.synth.speak(u);
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

Object.assign(CodemanApp.prototype, {
  /** The member car mode talks to: the one marked as the room's voice. */
  _carVoiceMember() {
    return this._chatRoom?.members.find((m) => m.voice === true) || null;
  },

  async openCarMode() {
    // Idempotent: a second open (a double tap, the restore after a reload racing a
    // click) must never leave two recognizers listening and sending the same words.
    if (this._carOpening || (this._car && this._carScreen && !this._carScreen.hidden)) return;
    this._carOpening = true;
    try {
      await this._openCarMode();
    } finally {
      this._carOpening = false;
    }
  },

  async _openCarMode() {
    if (!this.isChatroomOpen?.()) await this.openChatroom?.();
    const member = this._carVoiceMember();
    if (!member) {
      this.showToast?.('Mark a member as Voice in the chat panel first', 'info');
      return;
    }
    try {
      localStorage.setItem('codeman:carMode', '1');
    } catch {
      /* per-device convenience only */
    }
    this._buildCarMode(member);
    this._carEngine = carModeEngine(window);
    this._carScreen.hidden = false;
    document.documentElement.classList.add('car-mode-open');
    this._keepCarScreenAwake();
    this._car?.stop();
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
          synth.speak(u);
        },
        cancel: () => {
          diag('tts:cancel', flags());
          synth.cancel();
        },
      };
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
        synth: tracedSynth,
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

  closeCarMode() {
    if (!this._carScreen || this._carScreen.hidden) return;
    this._car?.stop();
    this._car = null;
    this._stopChatRecording?.();
    this._carScreen.hidden = true;
    document.documentElement.classList.remove('car-mode-open');
    this._carAwake?.stop();
    this._carAwake = null;
    try {
      localStorage.removeItem('codeman:carMode');
    } catch {
      /* per-device convenience only */
    }
  },

  /** Reopen car mode after a reload if it was on when the page went away. */
  _restoreCarMode() {
    if (this._carRestored) return;
    this._carRestored = true;
    let on = false;
    try {
      on = localStorage.getItem('codeman:carMode') === '1';
    } catch {
      on = false;
    }
    if (on) setTimeout(() => this.openCarMode(), 500);
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

  async _carSend(text) {
    const member = this._carVoiceMember();
    if (!member) throw new Error('no voice member');
    const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/messages`, {
      method: 'POST',
      body: { text, to: [member.sessionId], spoken: true },
    });
    if (!res.ok) throw new Error(res.error);
  },

  /** Called for every room message (chatroom-ui.js): speak the voice member's answers. */
  _carModeOnMessage(data) {
    if (!this._car || this._carScreen?.hidden) return;
    const m = data?.message;
    const member = this._carVoiceMember();
    if (!m || !member || data.roomId !== this._chatRoomId) return;
    if (m.from.kind !== 'agent' || m.from.sessionId !== member.sessionId) return;
    if (m.voice) return; // a /turn reply already carries its own audio
    if (m.to !== 'all' && !m.to.includes('user')) return;
    // The same answer posted twice in a row (seen in the room) is spoken once.
    const now = Date.now();
    if (m.text === this._carLastReply && now - (this._carLastReplyAt || 0) < 30_000) return;
    const phrase = typeof chatAttachmentPhrase === 'function' ? chatAttachmentPhrase(m.attachments) : '';
    const spokenText = [m.text, phrase ? `${m.from.name.split(': ').pop()} ${phrase}.` : ''].filter(Boolean).join(' ');
    if (this._car.reply(spokenText)) {
      this._carLastReply = m.text;
      this._carLastReplyAt = now;
    }
  },

  _carVoice() {
    const name = this._carScreen?.querySelector('.car-voice')?.value;
    return carModePickVoice(window.speechSynthesis?.getVoices?.() || [], name);
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
      voice.onchange = () => {
        try {
          localStorage.setItem('codeman:carVoice', voice.value);
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
      const status = document.createElement('span');
      status.className = 'car-status';
      const detail = document.createElement('span');
      detail.className = 'car-detail';
      const hint = document.createElement('span');
      hint.className = 'car-hint';
      pad.append(status, detail, hint);
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
      screen.append(bar, awake, pad);
      document.body.append(screen);
      this._carScreen = screen;
      const fillVoices = () => this._fillCarVoices();
      window.speechSynthesis?.addEventListener?.('voiceschanged', fillVoices);
    }
    this._carScreen.querySelector('.car-who').textContent = `${member.icon ? `${member.icon} ` : ''}${member.name}`;
    this._carScreen.querySelector('.car-build').textContent = (this._pageBuildId || '').slice(0, 8);
    this._fillCarVoices();
  },

  _fillCarVoices() {
    const select = this._carScreen?.querySelector('.car-voice');
    if (!select) return;
    const voices = (window.speechSynthesis?.getVoices?.() || []).filter((v) => /^en[-_](US|GB)/i.test(v.lang || ''));
    select.hidden = voices.length === 0;
    let saved = null;
    try {
      saved = localStorage.getItem('codeman:carVoice');
    } catch {
      saved = null;
    }
    const pick = carModePickVoice(voices, saved);
    select.replaceChildren(...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.name)));
    if (pick) select.value = pick.name;
  },

  _carTap() {
    if (this._carEngine === 'speech') {
      this._car?.tap();
      return;
    }
    // Server engine: the whole screen is the push-to-talk button (tap, speak, tap).
    this._unlockChatAudio?.();
    const member = this._carVoiceMember();
    if (!member) return;
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
        : 'Tap anywhere to talk, tap again to send';
    screen.querySelector('.car-hint').textContent = hint;
  },
});
