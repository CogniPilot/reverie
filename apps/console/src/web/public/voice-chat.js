/**
 * @fileoverview Voice for every agent in the chat panel: dictation to any recipient and
 * reading replies aloud. (The room's voice member keeps its own server pipeline:
 * /api/voice/turn, reply WAVs and car mode; none of this depends on that flag.)
 *
 * - Dictation: the composer mic works whatever the To menu says. For the voice member it
 *   is the /turn pipeline (chatroom-ui.js); for anyone else it transcribes, with the
 *   browser's SpeechRecognition when there is one, else by recording and asking
 *   /api/voice/stt, and puts the words in the input with a 2-second countdown (edit or
 *   cancel to stop it; a per-device setting sends at once). The message goes out as an
 *   ordinary one marked `spoken`, so its recipients answer it like typed text.
 * - Read aloud ("Speak replies", per device): replies addressed to the user are read with
 *   speechSynthesis, name first, one at a time, held while the mic records; a reply over
 *   about 80 words is announced instead of read.
 *
 * `chatMicRoute`, `readAloudText` and `ReadAloudQueue` are pure / dependency-injected
 * for tests (test/voice-chat.test.ts).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency chatroom-ui.js (_chatEls, _chatApi, _diag, push-to-talk helpers)
 * @loadorder 12.11 (after chatroom-ui.js, before car-mode.js)
 */

const DICTATION_PREVIEW_MS = 2000;
const READ_ALOUD_MAX_WORDS = 80;
/** Never wait longer than this for one read-aloud item (Chrome's speaking flag can stick). */
const READ_ALOUD_ITEM_CAP_MS = 60_000;

/**
 * Pure: what a press of the composer mic does.
 * @returns {'turn'|'local'|'server'|null} the voice member's pipeline, browser speech
 *   recognition, recording for /api/voice/stt, or nothing this browser can do.
 */
function chatMicRoute({ toVoiceMember, hasRecognition, hasRecorder }) {
  if (toVoiceMember) return hasRecorder ? 'turn' : null;
  if (hasRecognition) return 'local';
  return hasRecorder ? 'server' : null;
}

/** Browser results may repeat an entire growing utterance, rather than add a segment. */
function chatSpeechJoin(previous, next) {
  const a = String(previous || '').trim();
  const b = String(next || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(`${a} `)) return b;
  return `${a} ${b}`;
}

/** Rebuild from the current result snapshot; resultIndex is an update offset, not an append instruction. */
function chatSpeechSnapshot(results) {
  let final = '', interim = '';
  for (let i = 0; i < results.length; i++) {
    const text = results[i]?.[0]?.transcript || '';
    if (results[i].isFinal) final = chatSpeechJoin(final, text);
    else interim = chatSpeechJoin(interim, text);
  }
  return { final, interim, text: chatSpeechJoin(final, interim) };
}

/** Room-wide replies are addressed to the owner only by an exact mention or an actual spoken-owner reply. */
function chatReadAloudAddressed(message, ownerNames, messages) {
  if (Array.isArray(message.to) && message.to.includes('user')) return true;
  if (message.to !== 'all') return false;
  const names = ['user', 'owner', ...(Array.isArray(ownerNames) ? ownerNames : [])];
  if (names.some((name) => {
    if (typeof name !== 'string' || !name.trim()) return false;
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').test(message.text || '');
  })) return true;
  const original = (messages || []).find((m) => m.id === message.replyTo);
  return original?.from?.kind === 'user' && original.spoken === true;
}

/** Pure: what to say for a reply. */
function readAloudText(name, text, maxWords = READ_ALOUD_MAX_WORDS) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  if (words.length > maxWords) return `Long reply from ${name}, see the panel.`;
  return `${name} says: ${words.join(' ')}`;
}

/**
 * Speaks queued texts one at a time. deps: { synth, createUtterance(text),
 * setTimeout, clearTimeout, voice?() }. Muted, it holds the queue until unmuted.
 */
class ReadAloudQueue {
  constructor(deps) {
    this.deps = deps;
    this.items = [];
    this.current = null;
    this.muted = false;
    this.guard = null;
  }

  push(text) {
    if (!text) return;
    this.items.push(text);
    this._next();
  }

  /** Hold (true) or release (false) the queue; muting cuts what is being said. */
  mute(on) {
    this.muted = on;
    if (on && this.current) {
      // What was interrupted is said again afterwards, rather than lost.
      this.items.unshift(this.current.text);
      this._finish(true);
    }
    if (!on) this._next();
  }

  clear() {
    this.items = [];
    if (this.current) this._finish(true);
  }

  _next() {
    if (this.muted || this.current || !this.items.length) return;
    const text = this.items.shift();
    const u = this.deps.createUtterance(text);
    const voice = this.deps.voice?.();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    const token = { text, u };
    this.current = token;
    const done = () => {
      if (this.current === token) this._finish(false);
    };
    u.onend = done;
    u.onerror = done;
    // A stuck "speaking" flag or a lost onend must not stall the queue for good.
    this.guard = this.deps.setTimeout(done, Math.min(READ_ALOUD_ITEM_CAP_MS, (text.length / 12) * 1000 + 4000));
    this.deps.synth.speak(u);
  }

  _finish(cancel) {
    if (this.guard) this.deps.clearTimeout(this.guard);
    this.guard = null;
    this.current = null;
    if (cancel) this.deps.synth.cancel();
    this._next();
  }
}

Object.assign(CodemanApp.prototype, {
  _voiceSetting(key) {
    try {
      return localStorage.getItem(`codeman:${key}`) === '1';
    } catch {
      return false;
    }
  },

  _setVoiceSetting(key, on) {
    try {
      if (on) localStorage.setItem(`codeman:${key}`, '1');
      else localStorage.removeItem(`codeman:${key}`);
    } catch {
      /* per-device convenience only */
    }
  },

  /** Where a mic press goes right now (see chatMicRoute). */
  _chatMicRoute() {
    const id = this._chatEls?.to.value;
    const member = id && this._chatRoom?.members.find((m) => m.sessionId === id);
    return chatMicRoute({
      toVoiceMember: !!member && member.voice === true,
      hasRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      hasRecorder: typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    });
  },

  _chatToLabel() {
    const { to } = this._chatEls;
    return to.value ? to.options[to.selectedIndex]?.textContent.replace(/^To:\s*/, '') : 'everyone';
  },

  // ─── Dictation with the browser's recognizer ───────────────────────────────────

  _startLocalDictation() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    let transcript = { final: '', interim: '', text: '' };
    rec.onresult = (e) => {
      if (this._chatDictation !== rec) return;
      transcript = chatSpeechSnapshot(e.results);
      this._chatVoiceStatus(`● ${transcript.text || 'Listening…'}`, 'recording');
    };
    rec.onerror = (e) => {
      this._diag?.('dictation:error', { error: e.error });
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this._chatVoiceStatus('Microphone or speech recognition was refused', 'error');
      }
    };
    rec.onend = () => {
      if (this._chatDictation !== rec) return;
      this._chatDictation = null;
      this._setChatRecording(false);
      this._dictationDone(transcript.text);
    };
    this._chatDictation = rec;
    this._setChatRecording(true);
    this._chatVoiceStatus(`● Listening for ${this._chatToLabel()}… release (or tap) to finish`, 'recording');
    try {
      rec.start();
    } catch {
      /* already running */
    }
  },

  _stopLocalDictation() {
    try {
      this._chatDictation?.stop();
    } catch {
      /* already stopped */
    }
  },

  /** Recording for /api/voice/stt finished (chatroom-ui.js hands the blob over). */
  async _transcribeOnServer(blob) {
    this._chatVoiceStatus('Transcribing…', 'busy');
    let res;
    try {
      res = await fetch(this._chatUrl('/api/voice/stt'), {
        method: 'POST',
        headers: { 'Content-Type': blob.type.split(';')[0] || 'audio/webm' },
        body: blob,
      });
    } catch {
      this._chatVoiceStatus('Network error: the recording was not sent', 'error');
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok || body?.success === false) {
      this._chatVoiceStatus(body?.error || `Transcription failed (HTTP ${res.status})`, 'error');
      return;
    }
    this._dictationDone(body?.data?.transcript || '');
  },

  /** The words are in: preview them for 2 s (or send at once, per the setting). */
  _dictationDone(text) {
    if (!text) {
      this._chatVoiceStatus("Didn't catch that. Try again, a little closer to the mic.", 'error');
      return;
    }
    const { input, voiceStatus } = this._chatEls;
    input.value = text;
    if (this._voiceSetting('dictationSendNow')) {
      this._chatVoiceStatus('');
      this._sendChatMessage({ spoken: true });
      return;
    }
    clearTimeout(this._dictationTimer);
    const cancel = () => {
      clearTimeout(this._dictationTimer);
      this._dictationTimer = null;
      input.removeEventListener('input', cancel);
      this._chatVoiceStatus('Edit, then press Send', '');
      this._pendingSpoken = true;
    };
    input.addEventListener('input', cancel, { once: true });
    voiceStatus.hidden = false;
    voiceStatus.className = 'chatroom-voice-status';
    const label = this._chatEl('span', '', `Sending to ${this._chatToLabel()} in 2 s… `);
    const now = this._chatEl('button', 'chatroom-link', 'Send now');
    now.type = 'button';
    const stop = this._chatEl('button', 'chatroom-link', 'Cancel');
    stop.type = 'button';
    voiceStatus.replaceChildren(label, now, document.createTextNode(' · '), stop);
    const send = () => {
      clearTimeout(this._dictationTimer);
      this._dictationTimer = null;
      input.removeEventListener('input', cancel);
      this._chatVoiceStatus('');
      this._sendChatMessage({ spoken: true });
    };
    now.onclick = send;
    stop.onclick = () => {
      cancel();
      input.value = '';
      this._pendingSpoken = false;
      this._chatVoiceStatus('');
    };
    this._dictationTimer = setTimeout(send, DICTATION_PREVIEW_MS);
  },

  // ─── Read aloud ───────────────────────────────────────────────────────────────

  _readAloudQueue() {
    if (!this._readAloud && window.speechSynthesis) {
      this._readAloud = new ReadAloudQueue({
        synth: window.speechSynthesis,
        createUtterance: (text) => new SpeechSynthesisUtterance(text),
        voice: () => this._carVoice?.() || null,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t),
      });
    }
    return this._readAloud;
  },

  /** Called for every room message (chatroom-ui.js). */
  _readAloudOnMessage(data) {
    const m = data?.message;
    if (!m || !this._voiceSetting('speakReplies')) return;
    if (data.roomId !== this._chatRoomId || m.from.kind !== 'agent' || m.voice) return;
    if (!chatReadAloudAddressed(m, this._chatOwnerNames, this._chatRoom?.messages)) return;
    // Car mode reads its own member's answers; never say one twice.
    if (this._carScreen && !this._carScreen.hidden && this._carVoiceMember?.()?.sessionId === m.from.sessionId) return;
    const name = m.from.name.split(': ').pop();
    const phrase = typeof chatAttachmentPhrase === 'function' ? chatAttachmentPhrase(m.attachments) : '';
    const said = m.text ? readAloudText(name, m.text) : '';
    this._readAloudQueue()?.push(phrase ? (said ? `${said}, and ${phrase}.` : `${name} ${phrase}.`) : said);
  },
});
