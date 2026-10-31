/**
 * @fileoverview Discord-style chat media: emoji (picker, :shortcode: autocomplete),
 * reactions, custom emotes and attachments, for the chat panel (chatroom-ui.js).
 *
 * - Emoji: a built-in set with shortcodes (no external data), a searchable picker, and
 *   `:short` autocomplete in the input (Tab/Enter picks, Escape closes). Custom emotes
 *   (`:name:`, per room or global) appear in both and render inline at text size.
 * - Reactions: chips under each message (emoji and count, who in the tooltip); tap to
 *   toggle yours, "+" to add one from the picker. Live over `chatroom:reaction`.
 * - Attachments: paperclip, drag-and-drop onto the panel, or paste. Files upload at once
 *   (raw bytes to POST /api/chatrooms/:id/files) and ride the next message; images show
 *   as thumbnails with a lightbox, other files as cards with name, size and download.
 *
 * Everything user-supplied is rendered with textContent / element attributes; emote
 * images come only from this room's own emote route.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency chatroom-ui.js (_chatEl, _chatApi, _chatEls, _chatRoom, _chatUrl)
 * @loadorder 12.105 (after chatroom-ui.js, before voice-chat.js)
 */

/** [shortcode, emoji] pairs: the common set, searchable by shortcode. */
const CHAT_EMOJI = [
  ['thumbsup', '\u{1F44D}'],
  ['thumbsdown', '\u{1F44E}'],
  ['heart', '❤️'],
  ['joy', '\u{1F602}'],
  ['smile', '\u{1F604}'],
  ['grin', '\u{1F601}'],
  ['laughing', '\u{1F606}'],
  ['wink', '\u{1F609}'],
  ['blush', '\u{1F60A}'],
  ['slight_smile', '\u{1F642}'],
  ['upside_down', '\u{1F643}'],
  ['thinking', '\u{1F914}'],
  ['neutral', '\u{1F610}'],
  ['expressionless', '\u{1F611}'],
  ['unamused', '\u{1F612}'],
  ['rolling_eyes', '\u{1F644}'],
  ['grimacing', '\u{1F62C}'],
  ['relieved', '\u{1F60C}'],
  ['pensive', '\u{1F614}'],
  ['sleepy', '\u{1F62A}'],
  ['sleeping', '\u{1F634}'],
  ['mask', '\u{1F637}'],
  ['nerd', '\u{1F913}'],
  ['sunglasses', '\u{1F60E}'],
  ['confused', '\u{1F615}'],
  ['worried', '\u{1F61F}'],
  ['frowning', '☹️'],
  ['open_mouth', '\u{1F62E}'],
  ['astonished', '\u{1F632}'],
  ['flushed', '\u{1F633}'],
  ['pleading', '\u{1F97A}'],
  ['cry', '\u{1F622}'],
  ['sob', '\u{1F62D}'],
  ['scream', '\u{1F631}'],
  ['angry', '\u{1F620}'],
  ['rage', '\u{1F621}'],
  ['exploding_head', '\u{1F92F}'],
  ['partying', '\u{1F973}'],
  ['star_struck', '\u{1F929}'],
  ['heart_eyes', '\u{1F60D}'],
  ['kissing_heart', '\u{1F618}'],
  ['yum', '\u{1F60B}'],
  ['stuck_out_tongue', '\u{1F61B}'],
  ['zany', '\u{1F92A}'],
  ['money_mouth', '\u{1F911}'],
  ['hugging', '\u{1F917}'],
  ['shushing', '\u{1F92B}'],
  ['zipper_mouth', '\u{1F910}'],
  ['skull', '\u{1F480}'],
  ['ghost', '\u{1F47B}'],
  ['alien', '\u{1F47D}'],
  ['robot', '\u{1F916}'],
  ['clown', '\u{1F921}'],
  ['poop', '\u{1F4A9}'],
  ['wave', '\u{1F44B}'],
  ['ok_hand', '\u{1F44C}'],
  ['clap', '\u{1F44F}'],
  ['raised_hands', '\u{1F64C}'],
  ['pray', '\u{1F64F}'],
  ['handshake', '\u{1F91D}'],
  ['muscle', '\u{1F4AA}'],
  ['point_up', '☝️'],
  ['point_right', '\u{1F449}'],
  ['crossed_fingers', '\u{1F91E}'],
  ['v', '✌️'],
  ['metal', '\u{1F918}'],
  ['eyes', '\u{1F440}'],
  ['brain', '\u{1F9E0}'],
  ['fire', '\u{1F525}'],
  ['sparkles', '✨'],
  ['star', '⭐'],
  ['zap', '⚡'],
  ['boom', '\u{1F4A5}'],
  ['100', '\u{1F4AF}'],
  ['tada', '\u{1F389}'],
  ['confetti', '\u{1F38A}'],
  ['rocket', '\u{1F680}'],
  ['trophy', '\u{1F3C6}'],
  ['medal', '\u{1F3C5}'],
  ['crown', '\u{1F451}'],
  ['gem', '\u{1F48E}'],
  ['money', '\u{1F4B0}'],
  ['bulb', '\u{1F4A1}'],
  ['gear', '⚙️'],
  ['wrench', '\u{1F527}'],
  ['hammer', '\u{1F528}'],
  ['tools', '\u{1F6E0}️'],
  ['bug', '\u{1F41B}'],
  ['computer', '\u{1F4BB}'],
  ['keyboard', '⌨️'],
  ['chart', '\u{1F4C8}'],
  ['chart_down', '\u{1F4C9}'],
  ['memo', '\u{1F4DD}'],
  ['books', '\u{1F4DA}'],
  ['pushpin', '\u{1F4CC}'],
  ['paperclip', '\u{1F4CE}'],
  ['lock', '\u{1F512}'],
  ['key', '\u{1F511}'],
  ['link', '\u{1F517}'],
  ['mag', '\u{1F50D}'],
  ['hourglass', '⏳'],
  ['stopwatch', '⏱️'],
  ['alarm', '⏰'],
  ['calendar', '\u{1F4C5}'],
  ['bell', '\u{1F514}'],
  ['mega', '\u{1F4E3}'],
  ['speech', '\u{1F4AC}'],
  ['thought', '\u{1F4AD}'],
  ['white_check_mark', '✅'],
  ['heavy_check_mark', '✔️'],
  ['x', '❌'],
  ['warning', '⚠️'],
  ['no_entry', '⛔'],
  ['stop_sign', '\u{1F6D1}'],
  ['question', '❓'],
  ['exclamation', '❗'],
  ['red_circle', '\u{1F534}'],
  ['green_circle', '\u{1F7E2}'],
  ['yellow_circle', '\u{1F7E1}'],
  ['blue_circle', '\u{1F535}'],
  ['arrow_up', '⬆️'],
  ['arrow_down', '⬇️'],
  ['arrows_cycle', '\u{1F504}'],
  ['recycle', '♻️'],
  ['coffee', '☕'],
  ['pizza', '\u{1F355}'],
  ['beer', '\u{1F37A}'],
  ['cake', '\u{1F370}'],
  ['dog', '\u{1F436}'],
  ['cat', '\u{1F431}'],
  ['unicorn', '\u{1F984}'],
  ['parrot', '\u{1F99C}'],
  ['sun', '☀️'],
  ['moon', '\u{1F319}'],
  ['rainbow', '\u{1F308}'],
  ['snowflake', '❄️'],
  ['car', '\u{1F697}'],
  ['airplane', '✈️'],
  ['satellite', '\u{1F6F0}️'],
  ['drone', '\u{1F681}'],
  ['compass', '\u{1F9ED}'],
  ['joker', '\u{1F0CF}'],
  ['microphone', '\u{1F3A4}'],
  ['headphones', '\u{1F3A7}'],
];

/** Pure: emoji and emotes whose shortcode starts with (then contains) `query`. */
function chatEmojiMatches(query, emotes = [], limit = 8) {
  const q = String(query || '').toLowerCase();
  const all = [
    ...(emotes || []).map((e) => ({ code: e.name, emote: e.name })),
    ...CHAT_EMOJI.map(([code, ch]) => ({ code, ch })),
  ];
  const starts = all.filter((e) => e.code.startsWith(q));
  const contains = all.filter((e) => !e.code.startsWith(q) && e.code.includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Pure: split text into plain runs and ``` fenced code blocks, retaining an explicit language label.
 * An opening fence with no closing one stays plain text, so a stray ``` never swallows the rest of a message.
 */
function chatCodeSegments(text) {
  const out = [];
  const src = String(text ?? '');
  const re = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const language = m[1].trim().split(/\s+/, 1)[0].toLowerCase();
    out.push({ code: m[2].replace(/\n$/, ''), ...(language ? { language } : {}) });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/** Pure: split a plain run into text and `inline code` spans (`{inline}`); an unclosed backtick stays plain. */
function chatInlineCodeSegments(text) {
  const out = [];
  const src = String(text ?? '');
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    out.push({ inline: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/**
 * Pure: split a plain run into text and **bold** spans (`{bold}`). The span stays on one line and does not start or end with a
 * space, so a lone ** or "2 ** 3" stays plain text.
 */
function chatBoldSegments(text) {
  const out = [];
  const src = String(text ?? '');
  const re = /\*\*(?=\S)([^\n]*?\S)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    out.push({ bold: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/** Pure: split text into plain runs and `:emote:` tokens that exist in `names`. */
function chatTextSegments(text, names) {
  const out = [];
  const re = /:([a-z0-9_]{2,32}):/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!names.has(m[1])) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ emote: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The characters that end a link: invisible, format, direction-changing and lookalike ones (the same set the pane quoting escapes). */
const CHAT_LINK_STOP =
  '\\s<>"\'`\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\u00a0\\u034f\\u1680\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u2000-\\u200a\\u202f\\u205f\\u2800\\u3000\\u3164\\uffa0' +
  '\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}\\u201c-\\u201f\\uff02\\u2033\\u301d-\\u301f';
/** Sentence punctuation (ASCII, curly, ellipsis, CJK) that belongs after a link, not in it. */
const CHAT_LINK_TRAIL = /[.,;:!?*_~\u2018\u2019\u201a\u201b\u2026\u00bb\u203a\u3001\u3002\uff0c\uff0e\uff01\uff1f\uff1b\uff1a]/;
/** A link longer than this is left as text; at most this many links are made in one message. */
const CHAT_LINK_MAX_LENGTH = 2000;
const CHAT_LINK_MAX_COUNT = 50;

/** The host as written in a link (no scheme, user name, port or path), lower case. */
function chatLinkTextHost(raw) {
  const rest = raw.replace(/^https?:\/\//i, '');
  const authority = rest.split(/[/?#]/, 1)[0];
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return (host.startsWith('[') ? host.replace(/\](?::\d*)?$/, ']') : host.replace(/:\d*$/, '')).toLowerCase();
}

/**
 * Pure: split plain text into text runs and web links. Only http(s) links count; the link text stays exactly what was written
 * (the href is the parsed form of it), trailing sentence punctuation and an unmatched closing bracket stay outside the link, and
 * a link whose opened address could differ from the text is left as plain text: an address with a user name or password, a host
 * written with any non-ASCII character or in punycode ("xn--"), and a host the browser would rewrite (a number such as
 * http://2130706433/, or a hex or octal one). A link ends at an invisible or direction-changing character.
 */
function chatLinkSegments(text) {
  const out = [];
  const re = new RegExp(`\\bhttps?:\\/\\/[^${CHAT_LINK_STOP}]+`, 'giu');
  const plain = (to, from) => {
    if (to > from) out.push({ text: text.slice(from, to) });
  };
  let last = 0;
  let links = 0;
  let m;
  while (links < CHAT_LINK_MAX_COUNT && (m = re.exec(text))) {
    let raw = m[0];
    // Too long to be a real address: leave it, without any per-character work.
    if (raw.length > CHAT_LINK_MAX_LENGTH) {
      re.lastIndex = m.index + raw.length;
      continue;
    }
    // Trailing punctuation and unmatched closing brackets come off the end; each bracket is counted once, so this is linear.
    const count = (ch) => raw.split(ch).length - 1;
    const open = { ')': count('('), ']': count('['), '}': count('{') };
    const close = { ')': count(')'), ']': count(']'), '}': count('}') };
    for (;;) {
      const tail = raw[raw.length - 1];
      if (tail in close && close[tail] > open[tail]) {
        close[tail]--;
        raw = raw.slice(0, -1);
      } else if (CHAT_LINK_TRAIL.test(tail)) {
        if (tail in close) close[tail]--;
        raw = raw.slice(0, -1);
      } else break;
    }
    let url = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    const written = chatLinkTextHost(raw);
    const safe =
      url &&
      /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      url.hostname &&
      /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:.]+\])$/.test(written) &&
      !written.includes('xn--') &&
      url.hostname.replace(/\.$/, '') === written.replace(/\.$/, '');
    if (!safe) {
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    plain(m.index, last);
    out.push({ href: url.href, text: raw });
    last = m.index + raw.length;
    re.lastIndex = last;
    links++;
  }
  plain(text.length, last);
  return out;
}

/** Pure: a short spoken description of attachments ("sent an image", "sent 2 files"). */
function chatAttachmentPhrase(attachments) {
  const list = attachments || [];
  if (!list.length) return '';
  const images = list.filter((a) => /^image\//.test(a.type || '')).length;
  const others = list.length - images;
  const part = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
  const bits = [];
  if (images) bits.push(part(images, 'an image', 'images'));
  if (others) bits.push(part(others, 'a file', 'files'));
  return `sent ${bits.join(' and ')}`;
}

function chatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

Object.assign(ReverieApp.prototype, {
  // ─── Composer ────────────────────────────────────────────────────────────────

  /** Called once from _buildChatroomPanel: adds emoji, paperclip, pending tray, autocomplete. */
  _buildChatMedia(panel) {
    const { composer, input, mic } = this._chatEls;
    const row = mic.parentElement;
    const emojiBtn = this._chatEl('button', 'chatroom-tool', '\u{1F642}');
    emojiBtn.type = 'button';
    emojiBtn.title = 'Emoji';
    emojiBtn.setAttribute('aria-label', 'Insert emoji');
    emojiBtn.onclick = (e) => {
      e.stopPropagation();
      this._openEmojiPicker(emojiBtn, (pick) => this._insertAtCursor(input, pick));
    };
    const clip = this._chatEl('button', 'chatroom-tool', '\u{1F4CE}');
    clip.type = 'button';
    clip.title = 'Attach files (or drop them here, or paste)';
    clip.setAttribute('aria-label', 'Attach files');
    const picker = this._chatEl('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    picker.onchange = () => {
      this._attachChatFiles([...picker.files]);
      picker.value = '';
    };
    clip.onclick = () => picker.click();
    row.insertBefore(emojiBtn, mic);
    row.insertBefore(clip, mic);
    composer.append(picker);
    const tray = this._chatEl('div', 'chatroom-tray');
    tray.hidden = true;
    composer.insertBefore(tray, input);
    const suggest = this._chatEl('div', 'chatroom-suggest');
    suggest.hidden = true;
    suggest.setAttribute('role', 'listbox');
    composer.insertBefore(suggest, input);
    Object.assign(this._chatEls, { tray, suggest, emojiBtn, clip });
    this._chatPending = [];

    input.addEventListener('input', () => this._updateEmojiSuggest());
    input.addEventListener('keydown', (e) => this._emojiSuggestKey(e), true);
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        this._attachChatFiles(files);
      }
    });
    panel.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault();
        panel.classList.add('is-dropping');
      }
    });
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('is-dropping');
    });
    panel.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      panel.classList.remove('is-dropping');
      if (!files.length) return;
      e.preventDefault();
      this._attachChatFiles(files);
    });
  },

  _insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    const at = start + text.length;
    input.setSelectionRange(at, at);
    input.focus();
  },

  // ─── Attachments ─────────────────────────────────────────────────────────────

  async _attachChatFiles(files) {
    if (!this._chatRoomId) return;
    for (const file of files.slice(0, 10)) {
      const item = { name: file.name || 'pasted', size: file.size, type: file.type, id: null, state: 'uploading' };
      this._chatPending.push(item);
      this._renderChatTray();
      const q = `name=${encodeURIComponent(item.name)}&type=${encodeURIComponent(file.type || '')}`;
      try {
        const res = await fetch(this._chatUrl(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/files?${q}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.success) throw new Error(body?.error || `HTTP ${res.status}`);
        item.id = body.data.file.id;
        item.state = 'ready';
      } catch (err) {
        item.state = 'failed';
        this.showToast?.(`${item.name}: ${err.message}`, 'error');
      }
      this._renderChatTray();
    }
  },

  _renderChatTray() {
    const { tray } = this._chatEls;
    tray.hidden = this._chatPending.length === 0;
    tray.replaceChildren(
      ...this._chatPending.map((item, i) => {
        const chip = this._chatEl('span', `chatroom-tray-item chatroom-tray-item--${item.state}`);
        chip.append(
          this._chatEl('span', '', /^image\//.test(item.type) ? '\u{1F5BC}️' : '\u{1F4C4}'),
          this._chatEl('span', 'chatroom-tray-name', item.name),
          this._chatEl(
            'span',
            'chatroom-tray-size',
            item.state === 'uploading' ? 'uploading…' : chatFileSize(item.size)
          )
        );
        const x = this._chatEl('button', 'chatroom-link', '×');
        x.type = 'button';
        x.title = 'Remove';
        x.onclick = () => {
          this._chatPending.splice(i, 1);
          this._renderChatTray();
        };
        chip.append(x);
        return chip;
      })
    );
  },

  /** Ids of uploaded attachments for the message being sent (null while any still uploads). */
  _takeChatAttachments() {
    if (this._chatPending?.some((p) => p.state === 'uploading')) return null;
    const ids = (this._chatPending || []).filter((p) => p.state === 'ready').map((p) => p.id);
    return ids;
  },

  _clearChatAttachments() {
    this._chatPending = [];
    this._renderChatTray();
  },

  _chatAttachmentsEl(m) {
    if (!m.attachments?.length) return null;
    const wrap = this._chatEl('div', 'chatroom-attachments');
    for (const a of m.attachments) {
      const url = this._chatUrl(`/api/chatrooms/${encodeURIComponent(m.roomId)}/files/${encodeURIComponent(a.id)}`);
      if (/^image\/(png|jpeg|gif|webp)$/.test(a.type)) {
        const img = this._chatEl('img', 'chatroom-thumb');
        img.src = url;
        img.alt = a.name;
        img.loading = 'lazy';
        img.tabIndex = 0; img.setAttribute('role', 'button');
        img.onclick = () => this.openReadOnlyFilePreview({ kind: 'room-attachment', roomId: m.roomId, attachmentId: a.id, name: a.name }, img);
        img.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); img.click(); } };
        wrap.append(img);
      } else if (/^video\/(mp4|quicktime|webm)$/.test(a.type)) {
        // Movies play in place, Discord-style: the first frame with a play button. The server serves the
        // file inline only when its bytes are that container; anything else fails to load and becomes the download card.
        const video = this._chatEl('video', 'chatroom-video');
        video.src = url;
        video.controls = true;
        video.preload = 'metadata';
        video.playsInline = true;
        video.setAttribute('aria-label', a.name);
        video.addEventListener('error', () => video.replaceWith(this._chatFileCard(m, a, url)), { once: true });
        wrap.append(video);
      } else {
        wrap.append(this._chatFileCard(m, a, url));
      }
    }
    return wrap;
  },

  /** A download card that opens the read-only preview on a plain click. */
  _chatFileCard(m, a, url) {
    const card = this._chatEl('a', 'chatroom-file');
    card.href = url;
    card.setAttribute('aria-label', `Preview ${a.name}`);
    card.onclick = event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void this.openReadOnlyFilePreview({ kind: 'room-attachment', roomId: m.roomId, attachmentId: a.id, name: a.name }, card);
    };
    card.append(
      this._chatEl('span', 'chatroom-file-icon', '\u{1F4C4}'),
      this._chatEl('span', 'chatroom-file-name', a.name),
      this._chatEl('span', 'chatroom-file-size', chatFileSize(a.size))
    );
    return card;
  },

  _openChatLightbox(url, name) {
    document.getElementById('chatLightbox')?.remove();
    const box = this._chatEl('div', 'chatroom-lightbox');
    box.id = 'chatLightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', name);
    const img = this._chatEl('img');
    img.src = url;
    img.alt = name;
    const bar = this._chatEl('div', 'chatroom-lightbox-bar');
    const open = this._chatEl('a', '', 'Open');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    bar.append(this._chatEl('span', '', name), open);
    box.append(img, bar);
    box.onclick = (e) => {
      if (e.target !== open) box.remove();
    };
    document.body.append(box);
  },

  /** Safe when closed (Escape closes everything). */
  closeChatLightbox() {
    document.getElementById('chatLightbox')?.remove();
  },

  // ─── Emoji, emotes and the text renderer ─────────────────────────────────────

  async _loadChatEmotes(roomId = this._chatRoomId) {
    if (!roomId) return;
    const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/emotes`);
    this._chatEmotes = res.ok ? res.data.emotes : [];
    (this._chatEmoteCache ||= new Map()).set(roomId, this._chatEmotes);
  },

  _emoteUrl(name) {
    return this._chatUrl(
      `/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/emotes/${encodeURIComponent(name)}/image`
    );
  },

  _emoteImg(name, cls = 'chatroom-emote') {
    const img = this._chatEl('img', cls);
    img.src = this._emoteUrl(name);
    img.alt = `:${name}:`;
    img.title = `:${name}:`;
    return img;
  },

  /** Message text with this room's :emotes: drawn inline (text stays text). */
  _chatTextEl(text) {
    const el = this._chatEl('div', 'chatroom-msg-text');
    // Preserve original message source for optional display/editor plugins.
    el._reverieSource = String(text ?? '');
    const names = new Set((this._chatEmotes || []).map((e) => e.name));
    for (const block of chatCodeSegments(text)) {
      if (block.code !== undefined) {
        el.append(this._chatCodeBlock(block.code, block.language));
        continue;
      }
      this._chatAppendText(el, block.text, names);
    }
    return el;
  },

  /** A fenced code block with a Copy button (a long press cannot select part of a message on a phone). */
  _chatCodeBlock(code, language) {
    const wrap = this._chatEl('div', 'chatroom-codeblock');
    const copy = this._chatEl('button', 'chatroom-code-copy', 'Copy');
    copy.type = 'button';
    copy.title = 'Copy this code';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Could not copy';
      }
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    const pre = this._chatEl('pre', 'chatroom-code');
    const source = globalThis.ReverieChatCode?.highlight(code, language) || this._chatEl('code', '', code);
    if (typeof language === 'string' && /^[a-z0-9_+-]{1,40}$/.test(language)) source.classList.add(`language-${language}`);
    pre.append(source);
    wrap.append(copy, pre);
    return wrap;
  },

  /** An inline code span; tapping it copies it (a long press opens the message sheet, not a selection). */
  _chatInlineCode(code) {
    const span = this._chatEl('code', 'chatroom-inline-code', code);
    span.title = 'Tap to copy';
    span.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code);
        span.classList.add('is-copied');
      } catch {
        // No clipboard (plain http, refused): select the text so it can be copied by hand.
        span.classList.add('is-copy-failed');
        const range = document.createRange();
        range.selectNodeContents(span);
        const sel = window.getSelection?.();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setTimeout(() => span.classList.remove('is-copied', 'is-copy-failed'), 1200);
    };
    return span;
  },

  _chatAppendText(el, text, names) {
    for (const piece of chatInlineCodeSegments(text)) {
      if (piece.inline !== undefined) {
        el.append(this._chatInlineCode(piece.inline));
        continue;
      }
      for (const run of chatBoldSegments(piece.text)) {
        if (run.bold === undefined) {
          this._chatAppendPlain(el, run.text, names);
          continue;
        }
        const strong = this._chatEl('strong', 'chatroom-bold');
        this._chatAppendPlain(strong, run.bold, names);
        el.append(strong);
      }
    }
  },

  _chatAppendPlain(el, text, names) {
    for (const seg of chatTextSegments(text, names)) {
      if (seg.emote) {
        el.append(this._emoteImg(seg.emote));
        continue;
      }
      // Web links are clickable; the page opens in a new tab and gets neither this page nor its address.
      for (const part of chatLinkSegments(seg.text)) {
        if (!part.href) {
          el.append(document.createTextNode(part.text));
          continue;
        }
        const a = this._chatEl('a', 'chatroom-link', part.text);
        a.href = part.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        el.append(a);
      }
    }
  },

  _openEmojiPicker(anchor, onPick) {
    this._closeEmojiPicker();
    const pop = this._chatEl('div', 'chatroom-emoji-picker');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Emoji');
    const search = this._chatEl('input', 'chatroom-field');
    search.placeholder = 'Search emoji';
    search.setAttribute('aria-label', 'Search emoji');
    const grid = this._chatEl('div', 'chatroom-emoji-grid');
    const fill = () => {
      const items = chatEmojiMatches(search.value.trim(), this._chatEmotes, 300);
      grid.replaceChildren(
        ...items.map((it) => {
          const b = this._chatEl('button', 'chatroom-emoji-btn');
          b.type = 'button';
          b.title = `:${it.code}:`;
          if (it.emote) b.append(this._emoteImg(it.emote));
          else b.textContent = it.ch;
          b.onclick = (e) => {
            e.stopPropagation();
            this._closeEmojiPicker();
            onPick(it.emote ? `:${it.emote}:` : it.ch);
          };
          return b;
        })
      );
    };
    search.oninput = fill;
    pop.append(search, grid);
    fill();
    this._chatroomPanel.append(pop);
    const a = anchor.getBoundingClientRect();
    const p = this._chatroomPanel.getBoundingClientRect();
    pop.style.bottom = `${Math.max(8, p.bottom - a.top + 6)}px`;
    this._emojiPicker = pop;
    this._emojiDismiss = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) this._closeEmojiPicker();
    };
    document.addEventListener('pointerdown', this._emojiDismiss, true);
    search.focus();
  },

  _closeEmojiPicker() {
    if (!this._emojiPicker) return;
    this._emojiPicker.remove();
    this._emojiPicker = null;
    document.removeEventListener('pointerdown', this._emojiDismiss, true);
  },

  /** `:sho` before the caret: offer completions above the input. */
  _updateEmojiSuggest() {
    const { input, suggest } = this._chatEls;
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    const m = /(?:^|\s):([a-z0-9_]{2,32})$/.exec(before);
    if (!m) {
      suggest.hidden = true;
      this._emojiSuggest = null;
      return;
    }
    const items = chatEmojiMatches(m[1], this._chatEmotes);
    if (!items.length) {
      suggest.hidden = true;
      this._emojiSuggest = null;
      return;
    }
    this._emojiSuggest = { items, index: 0, token: m[1] };
    this._renderEmojiSuggest();
  },

  _renderEmojiSuggest() {
    const { suggest } = this._chatEls;
    const s = this._emojiSuggest;
    suggest.hidden = false;
    suggest.replaceChildren(
      ...s.items.map((it, i) => {
        const b = this._chatEl('button', `chatroom-suggest-item${i === s.index ? ' is-active' : ''}`);
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(i === s.index));
        if (it.emote) b.append(this._emoteImg(it.emote));
        else b.append(this._chatEl('span', 'chatroom-suggest-emoji', it.ch));
        b.append(this._chatEl('span', '', `:${it.code}:`));
        b.onmousedown = (e) => {
          e.preventDefault();
          s.index = i;
          this._acceptEmojiSuggest();
        };
        return b;
      })
    );
  },

  _acceptEmojiSuggest() {
    const s = this._emojiSuggest;
    if (!s) return;
    const { input, suggest } = this._chatEls;
    const it = s.items[s.index];
    const caret = input.selectionStart ?? input.value.length;
    const start = caret - s.token.length - 1;
    const insert = it.emote ? `:${it.emote}: ` : `${it.ch} `;
    input.value = `${input.value.slice(0, start)}${insert}${input.value.slice(caret)}`;
    const at = start + insert.length;
    input.setSelectionRange(at, at);
    suggest.hidden = true;
    this._emojiSuggest = null;
  },

  /** Keys while suggestions show; runs before the composer's Enter-to-send. */
  _emojiSuggestKey(e) {
    const s = this._emojiSuggest;
    if (!s || this._chatEls.suggest.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      s.index = (s.index + (e.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length;
      this._renderEmojiSuggest();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this._acceptEmojiSuggest();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._chatEls.suggest.hidden = true;
      this._emojiSuggest = null;
    }
  },

  // ─── Reactions ───────────────────────────────────────────────────────────────

  _chatReactionsEl(m) {
    const row = this._chatEl('div', 'chatroom-reactions');
    for (const [emoji, who] of Object.entries(m.reactions || {})) {
      const mine = who.includes('user');
      const chip = this._chatEl('button', `chatroom-reaction${mine ? ' is-mine' : ''}`);
      chip.type = 'button';
      const emote = /^:([a-z0-9_]{2,32}):$/.exec(emoji);
      if (emote) chip.append(this._emoteImg(emote[1]));
      else chip.append(this._chatEl('span', '', emoji));
      chip.append(this._chatEl('span', 'chatroom-reaction-count', String(who.length)));
      chip.title = who.map((w) => (w === 'user' ? 'you' : this._chatNameOf(w))).join(', ');
      chip.onclick = () => this._toggleChatReaction(m, emoji);
      row.append(chip);
    }
    const add = this._chatEl('button', 'chatroom-reaction chatroom-reaction-add', '+');
    add.type = 'button';
    add.title = 'Add a reaction';
    add.setAttribute('aria-label', 'Add a reaction');
    add.onclick = (e) => {
      e.stopPropagation();
      this._openEmojiPicker(add, (pick) => this._toggleChatReaction(m, pick, true));
    };
    row.append(add);
    return row;
  },

  async _toggleChatReaction(m, emoji, on) {
    const res = await this._chatApi(
      `/api/chatrooms/${encodeURIComponent(m.roomId)}/messages/${encodeURIComponent(m.id)}/reactions`,
      { method: 'POST', body: { emoji, ...(on === undefined ? {} : { on }) } }
    );
    if (!res.ok) this.showToast?.(`Reaction: ${res.error}`, 'error');
  },

  _onChatroomReaction(data) {
    if (!this.isChatroomOpen?.() || data?.roomId !== this._chatRoomId || !this._chatRoom) return;
    const m = this._chatRoom.messages.find((x) => x.id === data.messageId);
    if (!m) return;
    m.reactions = data.reactions;
    const el = this._chatEls.feed.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
    el?.querySelector('.chatroom-reactions')?.replaceWith(this._chatReactionsEl(m));
  },

  // ─── Emote management ────────────────────────────────────────────────────────

  _openEmoteManager() {
    document.getElementById('chatEmoteManager')?.remove();
    const dialog = this._chatEl('dialog', 'subscription-account-dialog chatroom-emote-manager');
    dialog.id = 'chatEmoteManager';
    dialog.append(this._chatEl('h3', '', 'Custom emotes'));
    const list = this._chatEl('div', 'chatroom-emote-list');
    const fill = () => {
      list.replaceChildren(
        ...(this._chatEmotes || []).map((e) => {
          const row = this._chatEl('div', 'chatroom-emote-row');
          const del = this._chatEl('button', 'chatroom-link', 'Remove');
          del.type = 'button';
          del.onclick = async () => {
            const res = await this._chatApi(
              `/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/emotes/${encodeURIComponent(e.name)}?scope=${e.scope === 'global' ? 'global' : 'room'}`,
              { method: 'DELETE' }
            );
            if (!res.ok) this.showToast?.(res.error, 'error');
            await this._loadChatEmotes();
            fill();
          };
          row.append(
            this._emoteImg(e.name),
            this._chatEl('span', '', `:${e.name}:`),
            this._chatEl('span', 'chatroom-mode', e.scope),
            del
          );
          return row;
        })
      );
      if (!this._chatEmotes?.length) list.append(this._chatEl('p', 'chatroom-hint', 'No custom emotes yet.'));
    };
    const form = this._chatEl('form', 'chatroom-emote-add');
    const name = this._chatEl('input', 'chatroom-field');
    name.placeholder = 'name, e.g. party_parrot';
    name.pattern = '[a-z0-9_]{2,32}';
    name.required = true;
    const file = this._chatEl('input');
    file.type = 'file';
    file.accept = 'image/png,image/gif,image/webp,image/jpeg';
    file.required = true;
    const scope = this._chatEl('select', 'chatroom-field');
    scope.append(new Option('This room', 'room'), new Option('All rooms', 'global'));
    const add = this._chatEl('button', 'chatroom-send', 'Add');
    add.type = 'submit';
    const close = this._chatEl('button', 'chatroom-secondary', 'Close');
    close.type = 'button';
    close.onclick = () => dialog.close();
    form.append(name, scope, file, add, close);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = file.files?.[0];
      if (!f) return;
      const q = `name=${encodeURIComponent(name.value)}&type=${encodeURIComponent(f.type)}&scope=${scope.value}`;
      const res = await fetch(this._chatUrl(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/emotes?${q}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        this.showToast?.(body?.error || `HTTP ${res.status}`, 'error');
        return;
      }
      name.value = '';
      file.value = '';
      await this._loadChatEmotes();
      fill();
    };
    dialog.append(list, form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    fill();
    dialog.showModal();
  },
});
