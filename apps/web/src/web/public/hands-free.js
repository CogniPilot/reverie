/**
 * @fileoverview Hands-free voice in the chat panel on a computer: speaking starts a
 * recording and a pause sends it, with no button. A per-room Voice control is available on phones and desktops. Desktop panel
 * listening defaults on only after the speech service is ready; touch devices start off.
 * Car screen is offered by default on touch devices with a voice member. Push-to-talk (hold or tap the mic) works as before, and
 * hands-free steps aside while it is used.
 *
 * - Detection: a level meter on the mic (AnalyserNode). Sound clearly above the room's
 *   noise for `onsetMs` starts a take; `quietMs` of quiet ends it, and it is sent the way
 *   a mic press is sent: a turn to the voice member (`_sendChatVoice`), otherwise
 *   dictation (`_transcribeOnServer`, with its 2 s preview). A take under `minSpeechMs`
 *   of sound (a cough, a door) is dropped.
 * - The first word is kept: recorders run before speech starts and are renewed every
 *   `rotateMs` with an overlap, and the take uses one that started at least
 *   `preRollMs` before the speech did.
 * - Listening pauses (and an unfinished take is dropped) while a reply plays (turn audio,
 *   read-aloud) or a spoken turn is still waiting for its answer, while dictation is
 *   being transcribed or previewed, while the composer holds typed text, and while
 *   push-to-talk records. It resumes `holdoffMs` after, so a reply's tail is not heard.
 *   Read-aloud is held while a take is being recorded.
 * - The mic stream is open only while the panel is open on a visible tab with a mic
 *   route; otherwise it is released. Car mode with the server engine listens the same
 *   way on its own screen (on phones too, a tap pauses it); its speech engine has its own loop.
 *
 * `HandsFreeDetector` is pure (test/hands-free.test.ts).
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency chatroom-ui.js (_chatEls, _sendChatVoice, _chatVoiceStatus, _diag),
 *   voice-chat.js (_chatMicRoute, _transcribeOnServer, _readAloud, _voiceSetting), car-mode.js (_carScreen)
 * @loadorder 12.13 (after car-mode.js)
 */

const HANDS_FREE = {
  tickMs: 60,
  /** Sound above the threshold this long starts a take. */
  onsetMs: 120,
  /** Quiet this long after speech ends the take. */
  quietMs: 1200,
  /** A take with less sound than this is dropped. */
  minSpeechMs: 300,
  /** A take is sent at this length even without a pause. */
  maxMs: 60_000,
  /** Threshold: at least `floor` (RMS), and `ratio` times the room's noise. */
  floor: 0.012,
  ratio: 3,
  /** The first this-many ms after the mic opens only learn the room's noise. */
  warmMs: 800,
  rotateMs: 6000,
  overlapMs: 1000,
  preRollMs: 400,
  holdoffMs: 600,
};

/**
 * Pure: speech start and end from a stream of mic levels (RMS, 0..1) with times in ms,
 * after `warmMs` spent learning the room's noise.
 * `feed` returns 'start' when speech has begun, 'end' (send) or 'discard' (too little
 * sound) when it is over, otherwise null. `speechAt` is when the speech began.
 */
class HandsFreeDetector {
  constructor(opts = {}) {
    this.o = { ...HANDS_FREE, ...opts };
    this.noise = 0;
    this.firstAt = null;
    this.reset();
  }

  /** Forget a take in progress (the room's noise level is kept). */
  reset() {
    this.speechAt = null;
    this.aboveAt = null;
    this.lastLoud = 0;
    this.loudMs = 0;
    this.prev = 0;
  }

  feed(level, now) {
    const o = this.o;
    if (this.firstAt === null) this.firstAt = now;
    if (now - this.firstAt < o.warmMs) {
      this.noise = this.noise ? this.noise * 0.8 + level * 0.2 : level;
      return null;
    }
    const loud = level > Math.max(o.floor, this.noise * o.ratio);
    if (this.speechAt === null) {
      if (!loud) {
        this.noise = this.noise ? this.noise * 0.95 + level * 0.05 : level;
        this.aboveAt = null;
        return null;
      }
      if (this.aboveAt === null) this.aboveAt = now;
      if (now - this.aboveAt < o.onsetMs) return null;
      this.speechAt = this.aboveAt;
      this.loudMs = now - this.aboveAt;
      this.lastLoud = now;
      this.prev = now;
      return 'start';
    }
    if (loud) {
      this.loudMs += now - this.prev;
      this.lastLoud = now;
    }
    this.prev = now;
    if (now - this.speechAt >= o.maxMs) {
      // No pause in a whole minute is more likely a new steady noise (a fan) than speech: learn it as the room's level.
      this.noise = Math.max(this.noise, level);
      return this._over('end');
    }
    if (now - this.lastLoud >= o.quietMs) return this._over(this.loudMs >= o.minSpeechMs ? 'end' : 'discard');
    return null;
  }

  _over(event) {
    this.reset();
    return event;
  }
}

const HANDS_FREE_TITLES = {
  off: 'Voice is off; choose a mode to listen',
  checking: 'Voice is off while the speech service is checked',
  unavailable: 'Voice is off because the speech service is unavailable; choose Retry or Browser dictation',
  listening: 'Hands-free: listening. Speak to start, pause to send. Click to turn off',
  hearing: 'Hands-free: hearing you. Pause to send. Click to turn off',
  reply: 'Hands-free: paused while the reply plays',
  waiting: 'Hands-free: paused while the answer is on its way',
  busy: 'Hands-free: paused while your words are sent',
  preview: 'Hands-free: paused while the dictation is about to send',
  typing: 'Hands-free: paused while the message box has text',
  'push-to-talk': 'Hands-free: paused while push-to-talk records',
  'needs-click': 'Hands-free: click anywhere on the page to start listening',
  starting: 'Hands-free: opening the microphone',
  blocked: 'Hands-free: the microphone was refused. Click to try again',
  hidden: 'Hands-free: paused while this tab is hidden',
  car: 'Hands-free: car mode is listening instead',
  paused: 'Hands-free: paused in car mode. Tap the screen to listen',
};

Object.assign(ReverieApp.prototype, {
  /** Called once when the composer is built (chatroom-ui.js): the toggle goes right after the mic. */
  _buildHandsFree(mic) {
    const btn = this._chatEl('select', 'chatroom-handsfree chatroom-voice-control');
    btn.hidden = true;
    btn.setAttribute('aria-label', 'Voice mode for this room');
    btn.onchange = () => {
      const mode = btn.value;
      if (mode === 'retry') {
        this._hfService = null;
      } else if (mode === 'dictate') {
        this.closeCarMode?.();
        this._setRoomVoiceMode('off');
        if (!this._chatDictation && !this._chatRecorder) this._startLocalDictation?.();
      } else {
        if (mode !== 'car') this.closeCarMode?.();
        this._setRoomVoiceMode(mode);
        this._hfBlocked = false;
        if (mode !== 'off') this._hfService = null;
      }
      this._hfGesture();
      this._hfTick();
    };
    mic.after(btn);
    this._hfButton = btn;
    this._hfDet = new HandsFreeDetector();
    this._hfRecs = [];
    this._hfResumeAt = 0;
    // Audio may start only after a user gesture: the first click or key on the page unlocks both.
    const gesture = () => this._hfGesture();
    document.addEventListener('pointerdown', gesture, true);
    document.addEventListener('keydown', gesture, true);
    this._hfTimer = setInterval(() => this._hfTick(), HANDS_FREE.tickMs);
  },

  _roomVoiceMode() {
    try {
      const mode = localStorage.getItem(`reverie:voiceMode:${this._chatRoomId || ''}`);
      if (['off', 'panel', 'car'].includes(mode)) return mode;
    } catch { /* per-device convenience only */ }
    return this._voiceSetting('handsFreeOff') || this._voiceTouch() ? 'off' : 'panel';
  },

  _setRoomVoiceMode(mode) {
    this._voiceModeRevision = (this._voiceModeRevision || 0) + 1;
    try { localStorage.setItem(`reverie:voiceMode:${this._chatRoomId || ''}`, mode); } catch {}
  },

  _voiceTouch() {
    return navigator.maxTouchPoints > 0 || window.matchMedia?.('(pointer: coarse)').matches === true;
  },

  _voiceEngineInfo() {
    const recognition = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const mode = this._roomVoiceMode();
    const browser = !!this._chatDictation || (mode === 'car' ? typeof carModeEngine === 'function' && carModeEngine(window) === 'speech' : mode !== 'panel' && recognition && this._chatMicRoute?.() === 'local');
    return {
      mode, engine: browser ? 'speech' : 'server', recognition,
      server: this._hfService?.state || 'unchecked',
      reason: browser ? 'Browser SpeechRecognition is available and selected' :
        `${recognition ? mode === 'panel' ? 'Panel hands-free uses recorded audio' : 'Spoken turns to a voice member use server speech' : 'Browser SpeechRecognition is unavailable'}; ${this._hfService?.message || 'speech service has not been checked'}`,
    };
  },

  async _hfProbeService() {
    if (this._hfProbePending) return this._hfProbePending;
    this._hfService = { state: 'checking', message: 'Checking Whisper/Piper speech service…' };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 4000);
    const check = async () => {
      try {
        const response = await this._chatApi('/api/voice/status', { signal: stop.signal });
        const data = response?.data;
        if (!response?.ok || typeof data?.available !== 'boolean') throw new Error('probe failed');
        this._hfService = { state: data.available ? 'ready' : 'unavailable', service: data.service || 'Whisper/Piper speech service', message: data.message || 'Whisper/Piper speech service is unavailable' };
      } catch {
        this._hfService = { state: 'unavailable', message: 'Cannot check the Whisper/Piper speech service. Retry when the console is reachable.' };
      } finally {
        clearTimeout(timer);
        this._hfProbePending = null;
      }
      this._diag?.('voice:engine', this._voiceEngineInfo());
      this._hfTick();
    };
    this._hfProbePending = check();
    return this._hfProbePending;
  },

  _hfServiceFailed(message) {
    const service = this._hfService?.service || 'Whisper/Piper speech service';
    this._hfService = { state: 'unavailable', service, message: message ? `${service}: ${message}` : `${service} failed. Retry before listening again.` };
    if (this._hfStream) this._hfClose('service-unavailable');
    this._chatVoiceStatus(this._hfService.message, 'error');
    this._hfRender('unavailable');
  },

  _handsFreeOn() {
    return this._roomVoiceMode() === 'panel';
  },

  _hfGesture() {
    if (this._hfCtx?.state === 'suspended') this._hfCtx.resume?.().catch(() => {});
    if (this._handsFreeOn() && this._chatEls && !this._chatEls.mic.hidden) this._unlockChatAudio?.();
  },

  _hfNow() {
    return performance.now();
  },

  /** Why the mic stream should be closed now, or '' when hands-free may listen. */
  _hfOff() {
    if (this._chatApp?.embassy?.selected || !this.isChatroomOpen?.()) return 'closed';
    if (this._roomVoiceMode() === 'off') return 'off';
    if (this._carScreen && !this._carScreen.hidden) {
      if (this._roomVoiceMode() !== 'car' || (this._carRoomId !== undefined && this._carRoomId !== this._chatRoomId)) return 'closed';
      return this._carHfOff();
    }
    if (!this._handsFreeOn()) return 'off';
    if (this._hfBlocked) return 'blocked';
    if (this._chatApp?.embassy?.selected || !this.isChatroomOpen?.() || !this._chatEls || !this._chatMicRoute?.()) return 'closed';
    if (document.hidden) return 'hidden';
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'closed';
    return '';
  },

  /**
   * Car mode, server engine: the car screen listens the same way (talk, pause to send to
   * the car's voice member), on phones too, while this room's Voice mode is Car. A tap pauses
   * it (`_carHfPaused`). The speech engine has its own loop.
   */
  _carHfOff() {
    if (this._carEngine !== 'server') return 'car';
    if (this._hfBlocked) return 'blocked';
    if (document.hidden) return 'hidden';
    if (this._carHfPaused) return 'paused';
    if (this._carVoiceMember?.()?.voice !== true) return 'car';
    return '';
  },

  /** Car mode is listening on its own: a tap pauses it rather than recording. */
  _carHandsFree() {
    return !!this._hfButton && this._carEngine === 'server' && !this._hfBlocked && this._carVoiceMember?.()?.voice === true;
  },

  /** Why listening holds now (the stream stays open), or ''. */
  _hfHold() {
    if (this._chatRecorder || this._chatDictation) return 'push-to-talk';
    const a = this._chatAudio;
    if (a && !a.paused && !a.ended && !String(a.src || '').endsWith('/silence.wav')) return 'reply';
    if (this._readAloud?.current || window.speechSynthesis?.speaking) return 'reply';
    if (this._chatVoiceTurnFor) return 'waiting';
    if (this._hfSending) return 'busy';
    if (this._dictationTimer) return 'preview';
    if (this._chatEls.input.value.trim()) return 'typing';
    return '';
  },

  _hfTick() {
    if (!this._hfButton) return;
    const active = this.isChatroomOpen?.() && !this._chatApp?.embassy?.selected && !document.hidden;
    if (this._carScreen && !this._carScreen.hidden && (!active || this._roomVoiceMode() !== 'car' || (this._carRoomId !== undefined && this._carRoomId !== this._chatRoomId))) this.closeCarMode?.({ preserveMode: true });
    if (this._hfStream && (this._hfStreamRoomId !== this._chatRoomId || this._hfStreamMode !== this._roomVoiceMode())) this._hfClose('room-mode-changed');
    if (!this._hfService && this.isChatroomOpen?.() && !this._chatApp?.embassy?.selected && !document.hidden) this._hfProbeService();
    if (this._roomVoiceMode() === 'car' && active && (!this._carScreen || this._carScreen.hidden)) {
      if ((typeof carModeEngine === 'function' && carModeEngine(window) === 'speech') || this._hfService?.state === 'ready') this.openCarMode?.();
    }
    const off = this._hfOff();
    if (off) {
      if (this._hfStream) this._hfClose(off);
      return this._hfRender(off);
    }
    if (this._hfService?.state !== 'ready') {
      if (this._hfStream) this._hfClose('service-unavailable');
      return this._hfRender(this._hfService?.state === 'checking' ? 'checking' : 'unavailable');
    }
    if (!this._hfStream) {
      if (!this._hfOpening) this._hfOpen();
      return this._hfRender('starting');
    }
    if (this._hfCtx.state === 'suspended') return this._hfRender('needs-click');
    const now = this._hfNow();
    const hold = this._hfHold();
    if (hold) {
      if (this._hfDet.speechAt !== null) this._diag?.('handsfree:dropped', { hold });
      this._hfDropAll();
      this._hfResumeAt = now + HANDS_FREE.holdoffMs;
      return this._hfRender(hold);
    }
    if (now < this._hfResumeAt) return this._hfRender('listening');
    this._hfRotate(now);
    const event = this._hfDet.feed(this._hfLevel(), now);
    if (event === 'start') this._hfTakeStart();
    else if (event) this._hfTakeEnd(event === 'end');
    this._hfRender(this._hfTake ? 'hearing' : 'listening');
  },

  async _hfOpen() {
    const roomId = this._chatRoomId, revision = this._voiceModeRevision;
    this._hfOpening = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this._hfOpening = false;
      // No retry loop: a refused mic stays refused until the toggle is clicked.
      this._hfBlocked = true;
      this._chatVoiceStatus(`Hands-free: microphone blocked: ${err?.message || err}`, 'error');
      this._hfRender('blocked');
      return;
    }
    this._hfOpening = false;
    // Closed, hidden or switched off while the browser was asking: let it go at once.
    if (this._hfOff() || roomId !== this._chatRoomId || revision !== this._voiceModeRevision) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    this._hfStream = stream;
    this._hfStreamRoomId = roomId;
    this._hfStreamMode = this._roomVoiceMode();
    this._hfCtx = ctx;
    this._hfAnalyser = analyser;
    this._hfBuf = new Float32Array(analyser.fftSize);
    this._hfDet = new HandsFreeDetector();
    this._diag?.('handsfree:open', { state: ctx.state });
  },

  _hfClose(why) {
    this._hfDropAll();
    for (const t of this._hfStream.getTracks()) t.stop();
    this._hfCtx?.close?.().catch(() => {});
    this._hfStream = null;
    this._hfCtx = null;
    this._hfAnalyser = null;
    this._diag?.('handsfree:closed', { why });
  },

  _hfLevel() {
    this._hfAnalyser.getFloatTimeDomainData(this._hfBuf);
    let sum = 0;
    for (const x of this._hfBuf) sum += x * x;
    return Math.sqrt(sum / this._hfBuf.length);
  },

  _hfRecorder(now) {
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t));
    const rec = new MediaRecorder(this._hfStream, type ? { mimeType: type } : undefined);
    const r = { rec, at: now, chunks: [], send: false, type };
    const roomId = this._chatRoomId, revision = this._voiceModeRevision;
    rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    rec.onstop = () => {
      if (!r.send || this._hfOff() || roomId !== this._chatRoomId || revision !== this._voiceModeRevision) return;
      const blob = new Blob(r.chunks, { type: rec.mimeType || type || 'audio/webm' });
      this._hfSend(blob);
    };
    rec.start();
    this._hfRecs.push(r);
    return r;
  },

  _hfStop(r) {
    if (r.rec.state !== 'inactive') r.rec.stop();
  },

  /** Before speech: keep a recorder running, renewed with an overlap so one always has pre-roll. */
  _hfRotate(now) {
    if (this._hfTake) return;
    const newest = this._hfRecs.at(-1);
    if (!newest || now - newest.at >= HANDS_FREE.rotateMs) this._hfRecorder(now);
    while (this._hfRecs.length > 1 && now - this._hfRecs.at(-1).at >= HANDS_FREE.overlapMs) {
      this._hfStop(this._hfRecs.shift());
    }
  },

  _hfTakeStart() {
    const at = this._hfDet.speechAt;
    const keep =
      [...this._hfRecs].reverse().find((r) => at - r.at >= HANDS_FREE.preRollMs) ||
      this._hfRecs[0] ||
      this._hfRecorder(at);
    for (const r of this._hfRecs) if (r !== keep) this._hfStop(r);
    this._hfRecs = [keep];
    this._hfTake = keep;
    // A reply arriving now waits until the take is over.
    this._readAloud?.mute(true);
    this._hfStatus = `● Hands-free: hearing you… pause to send to ${this._hfTargetLabel()}`;
    this._chatVoiceStatus(this._hfStatus, 'recording');
  },

  _hfTakeEnd(send) {
    const take = this._hfTake;
    this._hfTake = null;
    this._hfRecs = this._hfRecs.filter((r) => r !== take);
    take.send = send;
    this._hfStop(take);
    this._hfClearStatus();
    this._readAloud?.mute(false);
    this._diag?.('handsfree:take', { send });
  },

  /** Drop every recorder and any take in progress, sending nothing. */
  _hfDropAll() {
    const hadTake = !!this._hfTake;
    for (const r of this._hfRecs) this._hfStop(r);
    this._hfRecs = [];
    this._hfTake = null;
    this._hfDet.reset();
    if (hadTake) {
      this._hfClearStatus();
      this._readAloud?.mute(false);
    }
  },

  _hfClearStatus() {
    if (this._hfStatus && this._chatEls.voiceStatus.textContent === this._hfStatus) this._chatVoiceStatus('');
    this._hfStatus = null;
  },

  _hfTargetLabel() {
    if (this._carScreen && !this._carScreen.hidden) return this._carVoiceMember?.()?.name || 'everyone';
    const target = this._chatMicRoute?.() === 'turn' ? this._chatVoiceTarget() : null;
    return target ? target.name : this._chatToLabel?.() || 'everyone';
  },

  /** A finished take goes where a mic press would send it. */
  async _hfSend(blob) {
    this._hfSending = true;
    try {
      if (blob.size < 1000) return;
      const car = this._carScreen && !this._carScreen.hidden ? this._carVoiceMember?.() : null;
      if (car) this._chatEls.to.value = car.sessionId;
      const route = car ? 'turn' : this._chatMicRoute?.();
      const target = car || (route === 'turn' ? this._chatVoiceTarget() : null);
      this._diag?.('handsfree:send', { size: blob.size, route: route || null });
      const success = target ? await this._sendChatVoice(blob, target) : route ? await this._transcribeOnServer?.(blob) : false;
      if (success === false) this._hfServiceFailed(this._chatEls.voiceStatus.textContent);
    } catch {
      this._hfServiceFailed();
    } finally {
      this._hfSending = false;
    }
  },

  _hfRender(state) {
    if (this._carScreen && !this._carScreen.hidden && this._carEngine === 'server') this._carHfRender(state);
    const btn = this._hfButton;
    const recognition = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const recorder = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    const member = this._carVoiceMember?.();
    const hidden = !!this._chatApp?.embassy?.selected || (!recognition && !recorder && !member);
    btn.hidden = hidden;
    const service = this._hfService;
    const ready = service?.state === 'ready';
    const mode = this._roomVoiceMode();
    const active = state !== 'blocked' && (mode === 'panel' ? ready && !['unavailable', 'checking'].includes(state) : mode === 'car' && this._carScreen && !this._carScreen.hidden);
    const current = active ? mode : 'off';
    const key = `${state}|${hidden}|${mode}|${ready}|${recognition}|${!!member}|${this._voiceTouch()}`;
    if (this._hfShown !== key) {
      this._hfShown = key;
      btn.replaceChildren();
      const option = (value, label, disabled = false) => {
        const el = this._chatEl('option', '', label);
        el.value = value;
        el.disabled = disabled;
        btn.append(el);
      };
      option('off', 'Voice: Off');
      option('panel', 'Hands-free in panel', !recorder || service?.state === 'unavailable');
      if (member && (this._voiceTouch() || mode === 'car')) option('car', 'Car screen', !(typeof carModeEngine === 'function' && carModeEngine(window) === 'speech') && service?.state === 'unavailable');
      if (recognition) option('dictate', 'Browser dictation');
      if (service?.state === 'unavailable') option('retry', 'Retry speech service');
      btn.value = current;
      btn.setAttribute('aria-pressed', String(!!active));
      btn.dataset.state = state;
      btn.classList.toggle('is-on', active);
      btn.classList.toggle('is-hearing', state === 'hearing');
    }
    const info = this._voiceEngineInfo();
    const status = service?.message || 'Whisper/Piper speech service has not been checked';
    btn.title = `${HANDS_FREE_TITLES[state] || 'Voice is off'}. ${status}`;
    const mic = this._chatEls?.mic;
    if (mic) mic.title = `${mic.dataset.voiceBaseTitle || 'Push to talk'}. ${status}`;
    const diag = this._chatroomPanel?.querySelector('.chatroom-diag');
    if (diag) diag.title = `Engine: ${info.engine}. ${info.reason}`;

  },

  /**
   * The car screen follows hands-free on changes only: an answer's text or "You said …"
   * stays on screen while it listens again; waiting, sending and replies are drawn by the
   * turn itself.
   */
  _carHfRender(state) {
    const was = this._carHfShown;
    if (was === state) return;
    this._carHfShown = state;
    const detail = this._carScreen.querySelector('.car-detail')?.textContent || '';
    if (state === 'hearing') this._renderCarState('listening', `Hearing you\u2026 pause to send to ${this._hfTargetLabel()}`);
    else if (state === 'listening') this._renderCarState('listening', was === 'hearing' ? '' : detail);
    else if (state === 'paused') this._renderCarState('paused', detail);
    else if (state === 'needs-click') this._renderCarState('paused', 'Tap anywhere to start listening');
    else if (state === 'blocked') this._renderCarState('paused', 'The microphone was refused: tap to talk instead');
  },
});
