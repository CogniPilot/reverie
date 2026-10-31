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
 * - Read aloud (per device and per room, every room silent until it is turned on there):
 *   "Replies to me" reads posts that mention the user, are sent to the user or reply to one
 *   of the user's messages; "Everyone" reads every new agent post. Each is read in
 *   the speaker's own server voice (the car's team voice, /api/voice/speak; the phone's
 *   speechSynthesis when that fails or while the car screen is open), name first, one at
 *   a time, held while the mic records; the default announces replies over 80 words,
 *   with optional per-room approximate duration and emoji preferences on this device.
 *
 * `chatMicRoute`, `readAloudText` and `ReadAloudQueue` are pure / dependency-injected
 * for tests (test/voice-chat.test.ts).
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency chatroom-ui.js (_chatEls, _chatApi, _diag, push-to-talk helpers)
 * @loadorder 12.11 (after chatroom-ui.js, before car-mode.js)
 */

const DICTATION_PREVIEW_MS = 2000;
const READ_ALOUD_MAX_WORDS = 80;
/** Never wait longer than this for one read-aloud item (Chrome's speaking flag can stick). */
const READ_ALOUD_ITEM_CAP_MS = 60_000;
/** Time allowed on top of the speech itself: the phone starts at once, a server line is fetched first. */
const READ_ALOUD_SLACK_MS = 4000;
const READ_ALOUD_SERVER_SLACK_MS = 15_000;

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
  const finals = [], interims = [], all = [];
  const append = (parts, raw) => {
    const text = String(raw || '').trim();
    if (!text) return;
    // An equal final remains a separate segment. Only a later STRICT extension
    // replaces its trailing prefix segments, even if that prefix was repeated.
    let start = parts.length;
    while (start > 0 && text.startsWith(`${parts[start - 1]} `)) start--;
    parts.splice(start, parts.length - start, text);
  };
  for (let i = 0; i < results.length; i++) {
    const text = results[i]?.[0]?.transcript || '';
    append(results[i].isFinal ? finals : interims, text);
    append(all, text);
  }
  return { final: finals.join(' '), interim: interims.join(' '), text: all.join(' ') };
}

/** Room-wide replies are addressed to the owner only by an exact mention or a reply linked to an owner message (typed or spoken). */
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
  return original?.from?.kind === 'user';
}

/**
 * Pure: the member a room speaks with: the one marked as its voice, or, in the user's own
 * direct message with a single agent, that agent (a DM has no Voice toggle and only one
 * agent could answer). A group DM has no implicit voice: who hears a spoken question there
 * is the user's to choose.
 */
function chatVoiceMember(room) {
  if (!room || !Array.isArray(room.members)) return null;
  const marked = room.members.find((m) => m && m.voice === true);
  if (marked) return marked;
  // One to one only: the user and exactly one agent, who is still in it.
  if (!chatIsUserDm(room) || room.dm.length !== 2 || room.members.length !== 1) return null;
  const agent = room.members[0];
  return agent && room.dm.includes(agent.sessionId) ? agent : null;
}

/** Pure: a direct message the user is part of (every agent message in it is to the user). */
function chatIsUserDm(room) {
  return !!room && room.kind === 'dm' && Array.isArray(room.dm) && room.dm.includes('user');
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

function readAloudClean(text, names = [], emojis = true) {
  let spoken = String(text || '');
  const known = [...new Set(['user', 'owner', 'everyone', 'all', 'here', ...names])]
    .filter(name => typeof name === 'string' && name.trim())
    .sort((first, second) => second.length - first.length);
  for (const name of known) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    spoken = spoken.replace(new RegExp(`(^|[^\\p{L}\\p{N}_.@])@(${escaped})(?![\\p{L}\\p{N}_@-]|\\.[\\p{L}\\p{N}])`, 'giu'), '$1$2');
  }
  if (!emojis) spoken = spoken.replace(/[#*0-9]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})*)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?/gu, '');
  return spoken.replace(/[ \t]+/g, ' ').trim();
}

function readAloudSeconds(text) {
  return Math.max(String(text).trim().split(/\s+/).filter(Boolean).length / 2.5, Array.from(text).length / 12);
}

function readAloudSentences(text) {
  if (typeof Intl?.Segmenter === 'function') return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)].map(part => part.segment.trim()).filter(Boolean);
  return String(text).match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)]*|$)/gu)?.map(part => part.trim()).filter(Boolean) || [];
}

function readAloudLimit(text, seconds) {
  if (!seconds) return text;
  let kept = '';
  for (const sentence of readAloudSentences(text)) {
    const next = kept ? `${kept} ${sentence}` : sentence;
    if (readAloudSeconds(next) <= seconds) kept = next;
    else {
      if (!kept) for (const word of sentence.split(/\s+/)) {
        const partial = kept ? `${kept} ${word}` : word;
        if (readAloudSeconds(partial) > seconds) break;
        kept = partial;
      }
      break;
    }
  }
  return kept;
}

function readAloudChunks(text, maximum = 600) {
  const chunks = [];
  let remaining = String(text).trim();
  while (remaining.length > maximum) {
    const prefix = remaining.slice(0, maximum);
    const sentences = readAloudSentences(remaining).filter(sentence => sentence.length <= maximum);
    let split = sentences[0] && prefix.startsWith(sentences[0]) ? sentences[0].length : prefix.lastIndexOf(' ');
    if (split <= 0) split = /[\uD800-\uDBFF]$/.test(prefix) ? maximum - 1 : maximum;
    chunks.push(remaining.slice(0, split).trim());
    remaining = remaining.slice(split).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Speaks queued texts one at a time. deps: { synth, createUtterance(text, meta),
 * setTimeout, clearTimeout, voice?(), slackMs?, onDone?(item, how) }. `meta` is what push()
 * was given with the text (who said it, for a server voice). Muted, it holds the queue until
 * unmuted. onDone says how each line left the queue: 'ended', 'error', 'timeout' (no end
 * signal in time), 'cancelled' (cut by clear()) or 'dropped' (cleared before it was said).
 */
/** How a read-aloud line left the queue (ReadAloudQueue onDone) to the playback notice its author gets; 'ended' is played. */
const READ_ALOUD_NOTICE = {
  error: ['interrupted', 'audio-failed'],
  timeout: ['interrupted', 'timed-out'],
  cancelled: ['interrupted', 'stopped'],
  dropped: ['not-played', 'stopped'],
};

class ReadAloudQueue {
  constructor(deps) {
    this.deps = deps;
    this.items = [];
    this.current = null;
    this.muted = false;
    this.guard = null;
  }

  push(text, meta) {
    if (!text || !String(text).trim()) return;
    this.items.push({ text, meta });
    this._next();
  }

  /**
   * Say this next, cutting what is being said: a line from another message goes back in the queue right after this one
   * (as mute() does), the same message starts over.
   */
  playNow(text, meta) {
    if (!text || !String(text).trim()) return;
    const item = { text, meta };
    const current = this.current;
    if (current) {
      const again = meta?.messageId && current.item.meta?.messageId === meta.messageId;
      this.items.unshift(item, ...(again ? [] : [{ ...current.item, chunks: current.chunks.slice(current.index) }]));
      this._finish(true);
      return;
    }
    this.items.unshift(item);
    this._next();
  }

  /** Stop one message: what is being said of it now is cut, and its queued lines are dropped. */
  stopMessage(messageId) {
    if (!messageId) return;
    const dropped = this.items.filter((item) => item.meta?.messageId === messageId);
    this.items = this.items.filter((item) => item.meta?.messageId !== messageId);
    for (const item of dropped) this._done(item, 'dropped');
    if (this.current?.item.meta?.messageId === messageId) this._finish(true, 'cancelled');
  }

  /** The message being said now, or null. */
  get playingMessageId() {
    return this.current?.item.meta?.messageId || null;
  }

  /** Hold (true) or release (false) the queue; muting cuts what is being said. */
  mute(on) {
    this.muted = on;
    if (on && this.current) {
      // What was interrupted is said again afterwards, rather than lost.
      this.items.unshift({ ...this.current.item, chunks: this.current.chunks.slice(this.current.index) });
      this._finish(true);
    }
    if (!on) this._next();
  }

  clear() {
    const dropped = this.items;
    this.items = [];
    if (this.current) this._finish(true, 'cancelled');
    for (const item of dropped) this._done(item, 'dropped');
  }

  _next() {
    if (this.muted || this.current || !this.items.length) return;
    const item = this.items.shift();
    const prefix = item.meta?.text && item.text.endsWith(item.meta.text) ? item.text.slice(0, -item.meta.text.length) : '';
    const token = { item, prefix, chunks: item.chunks || readAloudChunks(item.text), index: 0, u: null };
    this.current = token;
    this._speakChunk(token);
  }

  _speakChunk(token) {
    const text = token.chunks[token.index];
    const original = token.item.meta;
    const meta = original && typeof original.text === 'string'
      ? { ...original, text: token.index === 0 && token.prefix && text.startsWith(token.prefix) ? text.slice(token.prefix.length) : text }
      : original;
    const u = this.deps.createUtterance(text, meta);
    const voice = this.deps.voice?.();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    token.u = u;
    const done = (how) => {
      if (this.current !== token || token.u !== u) return;
      if (this.guard) this.deps.clearTimeout(this.guard);
      this.guard = null;
      if (how === 'ended' && ++token.index < token.chunks.length) this._speakChunk(token);
      else this._finish(how === 'timeout', how);
    };
    u.onend = () => done('ended');
    u.onerror = () => done('error');
    // A stuck "speaking" flag or a lost onend must not stall the queue for good.
    const slack = this.deps.slackMs ?? READ_ALOUD_SLACK_MS;
    this.guard = this.deps.setTimeout(() => done('timeout'), Math.min(READ_ALOUD_ITEM_CAP_MS, (text.length / 12) * 1000 + slack));
    this.deps.synth.speak(u);
  }

  /** how: see the class comment; none when mute() puts the line back to be said again. */
  _finish(cancel, how) {
    const item = this.current?.item;
    if (this.guard) this.deps.clearTimeout(this.guard);
    this.guard = null;
    this.current = null;
    if (cancel) this.deps.synth.cancel();
    if (item && how) this._done(item, how);
    this._next();
  }

  _done(item, how) {
    try {
      this.deps.onDone?.(item, how);
    } catch {
      /* a report must not stall the queue */
    }
  }
}

Object.assign(ReverieApp.prototype, {
  _voiceSetting(key) {
    try {
      return localStorage.getItem(`reverie:${key}`) === '1';
    } catch {
      return false;
    }
  },

  _setVoiceSetting(key, on) {
    try {
      if (on) localStorage.setItem(`reverie:${key}`, '1');
      else localStorage.removeItem(`reverie:${key}`);
    } catch {
      /* per-device convenience only */
    }
  },

  /**
   * Read aloud in one room on this device: 'off' (every room starts silent), 'mine'
   * (replies to me) or 'all' (everyone). Stored as '1' or 'all'.
   */
  _speakRepliesMode(roomId) {
    if (!roomId) return 'off';
    try {
      const v = localStorage.getItem(`reverie:speakReplies:${roomId}`);
      return v === 'all' ? 'all' : v === '1' ? 'mine' : 'off';
    } catch {
      return 'off';
    }
  },

  _speakRepliesIn(roomId) {
    return this._speakRepliesMode(roomId) !== 'off';
  },

  /** Set one room's read aloud: 'off', 'mine', 'all' (true is 'mine'). Off silences what is being read. */
  _setSpeakReplies(roomId, mode) {
    if (!roomId) return;
    const m = mode === true ? 'mine' : mode === 'mine' || mode === 'all' ? mode : 'off';
    try {
      if (m === 'off') localStorage.removeItem(`reverie:speakReplies:${roomId}`);
      else localStorage.setItem(`reverie:speakReplies:${roomId}`, m === 'all' ? 'all' : '1');
    } catch {
      /* per-device convenience only */
    }
    if (m === 'off') this._readAloud?.clear();
  },

  _readAloudOptions(roomId) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(`reverie:readAloudOptions:${roomId}`) || '{}'); } catch {}
    return {
      seconds: [0, 5, 10, 20, 30].includes(saved?.seconds) ? saved.seconds : null,
      emojis: saved?.emojis !== false,
    };
  },

  _setReadAloudOptions(roomId, change) {
    if (!roomId) return;
    const options = { ...this._readAloudOptions(roomId), ...change };
    options.seconds = [0, 5, 10, 20, 30].includes(options.seconds) ? options.seconds : null;
    options.emojis = options.emojis !== false;
    try { localStorage.setItem(`reverie:readAloudOptions:${roomId}`, JSON.stringify(options)); } catch {}
    if (roomId === this._chatRoomId) this._readAloud?.clear();
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
      return false;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok || body?.success === false) {
      this._chatVoiceStatus(body?.error || `Transcription failed (HTTP ${res.status})`, 'error');
      return false;
    }
    this._dictationDone(body?.data?.transcript || '');
    return true;
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
      const team = this._readAloudTeamSynth(window.speechSynthesis);
      this._readAloud = new ReadAloudQueue({
        synth: team || window.speechSynthesis,
        createUtterance: (text, meta) => {
          if (meta?.messageId) (this._readAloudSpoken ??= new Set()).add(meta.messageId);
          // The car screen shows who is speaking (car-mode.js _renderCarSpeaker), so it is not said there either.
          const car = this._carScreen && !this._carScreen.hidden;
          const u = new SpeechSynthesisUtterance(car && meta?.text ? meta.text : text);
          u.readAloud = meta || null;
          return u;
        },
        voice: () => this._carVoice?.() || null,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t),
        slackMs: team ? READ_ALOUD_SERVER_SLACK_MS : READ_ALOUD_SLACK_MS,
        onDone: (item, how) => {
          const n = item.meta?.notice;
          const why = READ_ALOUD_NOTICE[how];
          if (n && why) this._chatPlaybackNotice(n.room, n.id, ...why);
        },
      });
    }
    return this._readAloud;
  },

  /**
   * The speechSynthesis surface for read-aloud in each member's own server voice: the car's
   * team synth (car-mode.js), asking /api/voice/speak for the member who wrote the line, with
   * the phone voice as its backup. While the car screen is open the car owns the one audio
   * element, so lines go to the phone voice then. Null when car mode is not loaded.
   */
  _readAloudTeamSynth(phone) {
    if (typeof this._carTeamSynth !== 'function') return null;
    const diag = (kind, data) => this._diag?.(kind, data);
    const team = this._carTeamSynth(phone, diag);
    // Synthesis may start later in the shared lane. Capture each utterance's
    // source now, rather than relying on transient synchronous caller state.
    const sources = new WeakMap();
    team.deps = {
      ...team.deps,
      fetchAudio: async (text, utterance, remaining = CAR_TEAM_FETCH_MS) => {
        const who = sources.get(utterance);
        if (!who?.room || !who?.member) return null;
        if (this._carScreen && !this._carScreen.hidden) return null;
        const res = await this._chatApi('/api/voice/speak', {
          method: 'POST',
          body: { room: who.room, member: who.member, text: who.text || text },
          signal: AbortSignal.timeout?.(Math.max(1, Math.ceil(remaining))),
        });
        diag('readaloud:speak', { ok: res.ok, engine: res.data?.engine, chars: text.length });
        if (res.ok && res.data?.voice?.provider === 'browser' && utterance) utterance.employeeVoice = res.data.voice;
        return res.ok && typeof res.data?.audioUrl === 'string' ? res.data.audioUrl : null;
      },
    };
    return {
      get speaking() {
        return team.speaking;
      },
      get pending() {
        return team.pending;
      },
      speak(u) {
        sources.set(u, u.readAloud ? { ...u.readAloud } : null);
        team.speak(u);
      },
      cancel() {
        team.cancel();
      },
    };
  },

  /** Called for every room message (chatroom-ui.js). */
  _readAloudOnMessage(data) {
    const m = data?.message;
    const here = data?.roomId === this._chatRoomId;
    const mode = here ? this._speakRepliesMode(data.roomId) : 'off';
    if (!m || m.from?.kind !== 'agent' || m.voice) return;
    // In car mode the author of a line addressed to the user hears what the app did with it (_chatPlaybackNotice).
    const car = !!this._carScreen && !this._carScreen.hidden;
    const notice =
      car &&
      !(here && this._carVoiceMember?.()?.sessionId === m.from.sessionId) &&
      ((here && chatIsUserDm(this._chatRoom)) ||
        chatReadAloudAddressed(m, this._chatOwnerNames, here ? this._chatRoom?.messages : null))
        ? { room: data.roomId, id: m.id }
        : null;
    if (mode === 'off') {
      if (notice) this._chatPlaybackNotice(notice.room, notice.id, 'not-played', here ? 'read-aloud-off' : 'other-room');
      return;
    }
    // "Replies to me": in a room, only what is addressed to the user; "Everyone" reads every post.
    if (
      mode === 'mine' &&
      !chatIsUserDm(this._chatRoom) &&
      !chatReadAloudAddressed(m, this._chatOwnerNames, this._chatRoom?.messages)
    )
      return;
    // A pending spoken turn plays this member's linked answer itself (chatroom-ui.js _sendChatVoice); its other posts are still read.
    if (this._chatVoiceTurnFor && this._chatVoiceTurnFor === m.from.sessionId && m.replyTo) {
      const asked = this._chatRoom?.messages?.find((x) => x.id === m.replyTo);
      if (asked && asked.spoken && asked.from?.kind === 'user') return;
    }
    // Car mode reads its own member's answers; never say one twice.
    if (this._carScreen && !this._carScreen.hidden && this._carVoiceMember?.()?.sessionId === m.from.sessionId) return;
    const said = this._readAloudLine(data.roomId, m);
    if (!said) return;
    this._readAloudQueue()?.push(said.line, { ...said.meta, ...(notice ? { notice } : {}) });
  },

  /**
   * What read-aloud says for a message and who says it, or null. `whole` (asked for one message) reads all of it; the room's
   * automatic read-aloud keeps its word and seconds limits.
   */
  _readAloudLine(roomId, m, { whole = false } = {}) {
    const phrase = typeof chatAttachmentPhrase === 'function' ? chatAttachmentPhrase(m.attachments) : '';
    // Spoken as car mode would say it (car-mode.js): no markdown stars, code and paths as stand-ins.
    const options = this._readAloudOptions(roomId);
    const name = readAloudClean(m.from.name.split(': ').pop(), [], options.emojis) || 'Agent';
    const names = [...(this._chatOwnerNames || []), ...(this._chatRoom?.members || []).flatMap(member => [member.name, member.name?.split(': ').pop()])];
    const cleaned = readAloudClean(m.text, names, options.emojis);
    const text = typeof carModeSpeakable === 'function' ? carModeSpeakable(cleaned) : cleaned;
    const said = text ? readAloudText(name, text, whole || options.seconds !== null ? Infinity : READ_ALOUD_MAX_WORDS) : '';
    const complete = phrase ? (said ? `${said}, and ${phrase}.` : `${name} ${phrase}.`) : said;
    const line = whole ? complete : readAloudLimit(complete, options.seconds);
    if (!line) return null;
    // Their own voice says who it is, so the server line drops "Name says:"; the phone voice (the backup) keeps it.
    const prefix = `${name} says: `;
    return { line, meta: { room: roomId, member: m.from.sessionId, messageId: m.id, text: line.startsWith(prefix) ? line.slice(prefix.length) : line } };
  },

  /** "Read aloud" / "Speak again" on one agent message: said now, in full, in its author's voice. False when it cannot be. */
  _readAloudMessage(roomId, m) {
    if (!m || m.from?.kind !== 'agent' || m.deleted || !m.text) return false;
    const said = this._readAloudLine(roomId, m, { whole: true });
    const queue = said && this._readAloudQueue();
    if (!queue) return false;
    queue.playNow(said.line, said.meta);
    return true;
  },

  _readAloudStopMessage(messageId) {
    this._readAloud?.stopMessage(messageId);
  },

  /**
   * Tell the author of a line addressed to the user that car mode did not play it aloud, or cut it short (the server sends one
   * private line, once per message). Best effort: a failed report is only logged.
   */
  _chatPlaybackNotice(roomId, messageId, outcome, reason) {
    if (!roomId || !messageId) return;
    this._chatPlaybackNoticed ??= new Set();
    if (this._chatPlaybackNoticed.has(messageId)) return;
    this._chatPlaybackNoticed.add(messageId);
    this._diag?.('car:playback-notice', { outcome, reason });
    this._chatApi?.(`/api/chatrooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/playback`, {
      method: 'POST',
      body: { outcome, reason },
    })?.catch?.(() => {});
  },
});
