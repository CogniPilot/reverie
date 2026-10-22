/**
 * @fileoverview Conversation-first app shell. Chat is the default view: a workspace rail, a
 * channel / direct-message sidebar with hierarchical unread, the conversation (header, grouped
 * messages, anchored composer) and a member list with presence. The terminal UI is still
 * mounted underneath but hidden; it is reached only by the explicit "Debug terminal" action and
 * left with "Back to chat".
 *
 * It reuses the chatroom plumbing in chatroom-ui.js / chat-media.js (rooms API, reactions,
 * attachments, voice, emotes) and only replaces how it is laid out. Loaded by a loader at the end
 * of chatroom-ui.js (index.html is read once at server start, so this file and chat-app.css are
 * plain static assets). Everything user- or agent-supplied is rendered with textContent.
 *
 * The data shaping is pure (the `ca*` / `chat*` functions at the top) so it is tested without
 * a DOM; ReverieChatApp only paints and wires.
 *
 * @dependency chatroom-ui.js, chat-media.js, app.js (ReverieApp)
 * @loadorder after chatroom-ui.js (injected by it)
 */

/* ───────────────────────── pure helpers ───────────────────────── */

// Consume the fragment before this shell starts any asynchronous work. The
// invitation is held in memory only and never used as a navigation destination.
let caEmbassyIncomingInvite = typeof window !== 'undefined' ? caEmbassyTakeFragment(window) : null;

/** Badge text for a count; large counts stop growing. */
function chatBadgeCount(n) {
  return n > 99 ? '99+' : String(n);
}

/** At or below this window width a profile card is a bottom sheet; the card is this wide (matches `.ca-profile` in the CSS). */
const CA_SHEET_MAX_WIDTH = 767;
const CA_CARD_WIDTH = 280;

/** How long a woken member may take to start (be seen busy) before the "is typing" line is dropped, and the longest it ever shows. */
const CA_TURN_START_MS = 45000;
const CA_TURN_MAX_MS = 240000;

/** The words of the typing line for the names typing in a room. */
function caTypingText(names) {
  if (names.length === 1) return `${names[0]} is typing\u2026`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing\u2026`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing\u2026`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing\u2026`;
}

/**
 * How a node (a room, a category, a workspace, the whole chat) shows its unread state, the
 * Discord way: ANY unread message is a quiet dot (and a bold name on a row); a NUMBER appears
 * only for mentions, the messages addressed to the user. Agent-to-agent traffic is therefore a
 * dot, never a count. A mention beats a plain unread.
 */
function chatBadgeFor(unread, mentions) {
  const dot = unread > 0 || mentions > 0;
  if (mentions > 0) return { kind: 'mention', dot, text: chatBadgeCount(mentions) };
  if (unread > 0) return { kind: 'unread', dot, text: '' };
  return { kind: '', dot: false, text: '' };
}

/** Is this room a direct message? */
/**
 * sessionId -> icon from a GET /api/company payload: a permanent employee's record wins over a temporary agent's.
 * This is the icon an agent chose for itself; a room's own member icon is only the fallback.
 */
function caProfileIcons(company) {
  const out = new Map();
  const add = (list) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (r && typeof r.sessionId === 'string' && r.sessionId && typeof r.icon === 'string' && r.icon.trim() && !out.has(r.sessionId)) {
        out.set(r.sessionId, r.icon.trim());
      }
    }
  };
  add(company?.employees);
  add(company?.temporaryAgents);
  return out;
}

/** sessionId -> avatar URL (the picture an agent set for itself) from a GET /api/company payload; employees first, then temporary agents. */
function caProfileAvatars(company) {
  const out = new Map();
  const add = (list) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (r && typeof r.sessionId === 'string' && r.sessionId && caIconImage(r.avatar) && !out.has(r.sessionId)) out.set(r.sessionId, String(r.avatar).trim());
    }
  };
  add(company?.employees);
  add(company?.temporaryAgents);
  return out;
}

function caIsDm(room) {
  return !!room && room.kind === 'dm';
}

/** sessionId -> employee id from a GET /api/company payload: the sessions that are (today) bound to an employee. */
function caEmployeeBySession(company) {
  const out = new Map();
  for (const e of Array.isArray(company?.employees) ? company.employees : []) {
    if (e && typeof e.sessionId === 'string' && e.sessionId && typeof e.id === 'string' && e.id) out.set(e.sessionId, e.id);
  }
  return out;
}

function caEmployeeForSender(company, from) {
  if (from?.kind !== 'agent') return undefined;
  const employees = Array.isArray(company?.employees) ? company.employees : [];
  const matches = employees.filter((employee) => employee && (from.employeeId ? employee.id === from.employeeId : employee.sessionId === from.sessionId));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Pronouns are one line of 1-24 characters (src/pronouns.ts); the owner sets them on the employee record. */
const CA_PRONOUNS_MAX = 24;
const CA_PRONOUNS_PROPOSAL = ' proposes pronouns: ';
const CA_PRONOUNS_PROPOSAL_END = ' can set them on my member card)';

/** Why `text` (trimmed) is not valid pronouns, or '' when it is. */
function caPronounsProblem(text) {
  if (!text) return 'Pronouns are 1 to 24 characters';
  if (text.length > CA_PRONOUNS_MAX) return `Pronouns are at most ${CA_PRONOUNS_MAX} characters`;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text)) return 'Pronouns are one line of text';
  return '';
}

/** sessionId -> pronouns from a GET /api/company payload: the owner-set field on the employee bound to that session. */
function caProfilePronouns(company) {
  const out = new Map();
  for (const e of Array.isArray(company?.employees) ? company.employees : []) {
    if (e && typeof e.sessionId === 'string' && e.sessionId && typeof e.pronouns === 'string' && e.pronouns.trim()) out.set(e.sessionId, e.pronouns.trim());
  }
  return out;
}

/**
 * The pronouns a member last proposed in `messages` (`reverie agent profile --pronouns`, which writes nothing), or ''.
 * Only the member's own agent message counts: `<name> proposes pronouns: <text> (<who> can set them on my member card)`.
 */
function caPronounsProposal(messages, sessionId) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (!msg || msg.deleted || msg.from?.kind !== 'agent' || msg.from.sessionId !== sessionId || typeof msg.text !== 'string') continue;
    const at = msg.text.indexOf(CA_PRONOUNS_PROPOSAL);
    if (at < 1 || !msg.text.endsWith(CA_PRONOUNS_PROPOSAL_END)) continue;
    const rest = msg.text.slice(at + CA_PRONOUNS_PROPOSAL.length);
    const text = rest.slice(0, rest.lastIndexOf(' (')).trim();
    if (rest.lastIndexOf(' (') > 0 && !caPronounsProblem(text)) return text;
  }
  return '';
}

/** The non-user participant of a two-person direct message (a member record), if any. */
function caDmPeer(room) {
  if (!caIsDm(room)) return undefined;
  return (room.members || []).find((m) => m.sessionId !== 'user');
}

/** What a room is called in lists and headers: its name, or the other person in a direct message. */
/**
 * The mark before a channel's name, as Discord draws it: `#` for a text channel, a `#` with a small lock for a private
 * one, a speaker for a voice channel (with the lock when it is private too). `kind` picks the drawing (`text` is a plain
 * `#`); `label` is 'private' when the lock is shown.
 */
function caRoomGlyph(room) {
  const voice = caIsVoice(room);
  const priv = !!room && room.visibility === 'private';
  if (voice) return { kind: priv ? 'voice-private' : 'voice', text: '', label: priv ? 'private' : '' };
  if (priv) return { kind: 'private', text: '', label: 'private' };
  return { kind: 'text', text: '#', label: '' };
}

/*
 * The drawn marks, in a 20x20 box, filled or stroked with currentColor so every skin colours them. The lock is the same
 * small badge in the lower right of both. Fixed constants of this file, never user input.
 */
const CA_LOCK_BADGE = '<rect x="11.6" y="11.4" width="7" height="6" rx="1.2" fill="currentColor" stroke="none"/><path d="M13.2 11.4V9.9a1.9 1.9 0 0 1 3.8 0v1.5" fill="none"/>';
const CA_GLYPHS = {
  private: '<path d="M7.4 3 5.6 15.5M12.4 3 11.6 7.6M2.8 6.6h9.6M2.2 11.4h8"/>' + CA_LOCK_BADGE,
  voice: '<path d="M3 7.6h3.2l4.3-3.6v12l-4.3-3.6H3z" fill="currentColor" stroke-linejoin="round"/><path d="M13.6 7.2a4 4 0 0 1 0 5.6M15.8 5a7 7 0 0 1 0 10" fill="none"/>',
  'voice-private': '<path d="M2.4 6.6h3l4-3.4v11.6l-4-3.4h-3z" fill="currentColor" stroke-linejoin="round"/><path d="M12 5.2a5.2 5.2 0 0 1 .4 3" fill="none"/>' + CA_LOCK_BADGE,
};

function caRoomLabel(room) {
  if (!room) return '';
  if (!caIsDm(room)) return room.name || 'Untitled';
  if (room.name) return room.name;
  const names = (room.members || []).map((m) => m.name).filter(Boolean);
  return names.join(', ') || 'Direct message';
}

/** Unread numbers of a room as the page may rely on them (absent on an older server = none). */
function caCounts(room) {
  const unread = Math.max(0, Number(room?.unread) || 0);
  return { unread, mentions: Math.min(unread, Math.max(0, Number(room?.mentions) || 0)) };
}

/**
 * Sidebar rows for one workspace: categories (collapsible) holding rooms. A folded category still
 * lists its open room and anything unread, so a message is never hidden by folding its group; its
 * header carries the rolled-up dot and mention number.
 * `collapsed` maps a category key to true. Archived rooms go in a trailing folded group with no
 * notifications. Direct messages are not part of a workspace.
 */
/** Channels in the owner's order: the ones they placed (by `position`) first, the rest after in the order given. Stable. */
function caByPosition(list) {
  const placed = (r) => Number.isFinite(r.position) && r.position > 0;
  return [...list.filter(placed).sort((a, b) => a.position - b.position), ...list.filter((r) => !placed(r))];
}

/** `ids` after moving `id` one step up (-1) or down (1) among the ids that share its category (`categoryOf`). Unchanged at an edge. */
function caMoveWithin(ids, id, step, categoryOf) {
  const kin = ids.filter((x) => categoryOf(x) === categoryOf(id));
  const at = kin.indexOf(id);
  const other = kin[at + step];
  if (at < 0 || other === undefined) return ids;
  const out = [...ids];
  const i = out.indexOf(id);
  const j = out.indexOf(other);
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** `ids` with `id` moved to sit before (or after) `target`. Unchanged when either is missing or they are the same. */
function caMoveBeside(ids, id, target, after) {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids;
  const out = ids.filter((x) => x !== id);
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, id);
  return out;
}

function caChannelItems(rooms, workspace, collapsed, activeId) {
  const fold = collapsed || {};
  const wsKey = workspace || '';
  const out = [];
  const mine = (Array.isArray(rooms) ? rooms : []).filter(
    (r) => r && !caIsDm(r) && (r.workspace || '') === wsKey
  );
  const live = caByPosition(mine.filter((r) => !r.archivedAt));
  const row = (r, depth) => ({
    type: 'room',
    key: `room:${r.id}`,
    id: r.id,
    label: caRoomLabel(r),
    depth,
    muted: !!r.muted,
    ...caCounts(r),
    active: r.id === activeId,
  });
  const categories = [];
  for (const r of live) {
    const name = r.category || '';
    let cat = categories.find((c) => c.name === name);
    if (!cat) categories.push((cat = { name, rooms: [] }));
    cat.rooms.push(r);
  }
  // Uncategorised rooms read first, as in a server's top-level channels.
  categories.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : 0));
  for (const cat of categories) {
    const key = `cat:${wsKey}/${cat.name}`;
    const folded = !!cat.name && !!fold[key];
    const rows = cat.rooms
      .map((r) => row(r, cat.name ? 1 : 0))
      .filter((r) => !folded || r.unread > 0 || r.active);
    if (cat.name) {
      const totals = cat.rooms.reduce(
        (t, r) => {
          const c = caCounts(r);
          return { unread: t.unread + c.unread, mentions: t.mentions + c.mentions };
        },
        { unread: 0, mentions: 0 }
      );
      out.push({ type: 'category', key, name: cat.name, label: cat.name, folded, ...totals });
    }
    out.push(...rows);
  }
  const archived = mine.filter((r) => r.archivedAt);
  if (archived.length) {
    const key = `cat:${wsKey}/\u0000archived`;
    const folded = fold[key] !== false;
    out.push({ type: 'category', key, name: '', label: 'Archived', folded, unread: 0, mentions: 0, archived: true });
    for (const r of archived) {
      if (!folded || r.id === activeId) out.push({ ...row(r, 1), unread: 0, mentions: 0 });
    }
  }
  return out;
}

/** Direct-message rows: newest conversation first, then by name. */
/** Closed direct messages: { [roomId]: closedAt }, cleaned. */
function caClosedDms(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  const out = {};
  if (o && typeof o === 'object') {
    for (const [id, at] of Object.entries(o)) if (id !== '__proto__' && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return out;
}

/**
 * The direct messages for the sidebar. A closed one is hidden until it is opened again or something newer arrives.
 * Each person appears once: a two-person chat whose agent is gone (its session ended; the list keys chats by session) folds into
 * the chat with the live agent of the same person. The folded chats stay readable as `earlier` and their unread counts add up.
 * Same person = the same employee id when both sessions have one (an expert hire that reuses a name is a different person);
 * with an id missing on either side, the same name (case-insensitive).
 * `employeeOf` maps a session id to its employee id (caEmployeeBySession).
 */
function caDmItems(rooms, activeId, closed = {}, employeeOf = new Map()) {
  const items = (Array.isArray(rooms) ? rooms : [])
    .filter((r) => r && caIsDm(r))
    .filter((r) => !Object.hasOwn(closed, r.id) || r.id === activeId || (r.lastMessageAt || 0) > closed[r.id])
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0) || caRoomLabel(a).localeCompare(caRoomLabel(b)))
    .map((r) => ({
      type: 'dm',
      key: `room:${r.id}`,
      id: r.id,
      label: caRoomLabel(r),
      peer: caDmPeer(r),
      employeeId: employeeOf.get(caDmPeer(r)?.sessionId) || '',
      pair: Array.isArray(r.dm) && r.dm.length === 2,
      muted: !!r.muted,
      ...caCounts(r),
      active: r.id === activeId,
    }));
  const name = (i) => (i.pair && i.peer?.name ? String(i.peer.name).trim().toLowerCase() : '');
  const same = (a, b) => (a.employeeId && b.employeeId ? a.employeeId === b.employeeId : !!name(a) && name(a) === name(b));
  // The main chat of a person: the first live one in list order, else the first.
  const mains = [];
  for (const i of items) {
    if (!i.pair || !i.peer) continue;
    const m = mains.find((x) => same(x, i));
    if (!m) mains.push(i);
    else if (i.peer.alive === true && m.peer.alive !== true) mains[mains.indexOf(m)] = i;
  }
  const out = [];
  for (const i of items) {
    const main = i.pair && i.peer ? mains.find((x) => same(x, i)) : undefined;
    if (!main || main === i || i.peer.alive !== false) {
      out.push(i);
      continue;
    }
    main.earlier = [...(main.earlier || []), i];
    main.unread += i.unread;
    main.mentions += i.mentions;
  }
  return out;
}

/** The ids of chats folded under the open direct message that still carry unread or mentions: opening the person reads them too. */
function caFoldedUnreadIds(rooms, openId, closed, employeeOf) {
  return caDmItems(rooms, openId, closed, employeeOf)
    .filter((i) => i.id === openId)
    .flatMap((i) => i.earlier || [])
    .filter((e) => e.unread > 0 || e.mentions > 0)
    .map((e) => e.id);
}

/**
 * The workspace rail: Home (direct messages) then one entry per workspace, each rolling up its
 * rooms' unread. The default workspace (rooms nobody placed) is named by `defaultName`.
 */
function caWorkspaceItems(rooms, defaultName) {
  const list = Array.isArray(rooms) ? rooms : [];
  const home = list.filter((r) => r && caIsDm(r)).reduce(
    (t, r) => {
      const c = caCounts(r);
      return { unread: t.unread + c.unread, mentions: t.mentions + c.mentions };
    },
    { unread: 0, mentions: 0 }
  );
  const spaces = [];
  for (const r of list) {
    if (!r || caIsDm(r)) continue;
    const key = r.workspace || '';
    let ws = spaces.find((w) => w.key === key);
    if (!ws) spaces.push((ws = { key, label: key || defaultName || 'Reverie', unread: 0, mentions: 0 }));
    if (r.archivedAt) continue;
    const c = caCounts(r);
    ws.unread += c.unread;
    ws.mentions += c.mentions;
  }
  if (!spaces.length) spaces.push({ key: '', label: defaultName || 'Reverie', unread: 0, mentions: 0 });
  // The default workspace leads, the rest keep first-seen order.
  spaces.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : 0));
  return [{ key: 'home', label: 'Direct messages', home: true, ...home }, ...spaces];
}

/** Which rail entry owns a room. */
function caWorkspaceOf(room) {
  if (!room) return 'home';
  return caIsDm(room) ? 'home' : room.workspace || '';
}

/** Total unread across every room the user is notified about (not archived). */
function caTotals(rooms) {
  let unread = 0;
  let mentions = 0;
  for (const r of Array.isArray(rooms) ? rooms : []) {
    if (!r || r.archivedAt) continue;
    const c = caCounts(r);
    unread += c.unread;
    mentions += c.mentions;
  }
  return { unread, mentions };
}

/** Does the text `@name` the owner (`@user`, `@owner`, their own name) or the whole room (`@everyone`)? Same rule as the server's. */
function caMentionsOwner(text, ownerNames) {
  if (typeof text !== 'string' || !text) return false;
  const names = ['user', 'owner', 'everyone', ...(Array.isArray(ownerNames) ? ownerNames : [])].filter((n) => typeof n === 'string' && n.trim());
  return names.some((n) => new RegExp(`(^|[^\\w@])@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text));
}

/**
 * The room's counts after `message` arrived while the user is not looking at it. Only agents'
 * messages count (the user's own and system lines never do), and a message is a mention when it
 * is addressed to the user (every message, in a direct message with them).
 */
function chatCountsAfterMessage(room, message, ownerNames) {
  const unread = Number(room?.unread) || 0;
  const mentions = Number(room?.mentions) || 0;
  if (!room || room.archivedAt || message?.from?.kind !== 'agent') return { unread, mentions };
  if (room.kind === 'dm') {
    return room.dm?.includes('user') ? { unread: unread + 1, mentions: mentions + 1 } : { unread, mentions };
  }
  // A mention of the owner: a message addressed to them (older rooms), or one that @names them or the whole room.
  const addressed = (Array.isArray(message.to) && message.to.includes('user')) || (message.to === 'all' && caMentionsOwner(message.text, ownerNames));
  return { unread: unread + 1, mentions: mentions + (addressed ? 1 : 0) };
}

/**
 * Rooms whose server snapshot is older than a message this page already saw arrive over SSE. A
 * count refetched in between (after a read, say) would silently drop that message, so the caller
 * fetches again until the snapshot has caught up.
 */
function chatStaleRoomIds(rooms, seenAt) {
  const seen = seenAt || {};
  return (Array.isArray(rooms) ? rooms : [])
    .filter((r) => r && (seen[r.id] || 0) > (r.lastMessageAt || 0))
    .map((r) => r.id);
}

const CA_GROUP_GAP_MS = 7 * 60 * 1000;

/** `YYYY-MM-DD` in local time: the key a day divider is drawn for. */
function caDayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "October 11, 2026" for a day divider. */
function caDayLabel(ms) {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Same sender and addressing, close in time, no day change between: a continuation line. */
function caContinues(prev, m) {
  if (!prev || !m) return false;
  if (prev.from.kind === 'system' || m.from.kind === 'system') return false;
  if (prev.from.kind !== m.from.kind) return false;
  if ((prev.from.employeeId || prev.from.sessionId || prev.from.name) !== (m.from.employeeId || m.from.sessionId || m.from.name)) return false;
  if (m.replyTo) return false;
  if (JSON.stringify(prev.to) !== JSON.stringify(m.to)) return false;
  if (caDayKey(prev.at) !== caDayKey(m.at)) return false;
  return m.at - prev.at <= CA_GROUP_GAP_MS;
}

/**
 * The feed as a flat render list: day dividers, an optional "new messages" divider before the
 * first agent message after `readAt`, and each message marked as a group head or a continuation.
 */
function caFeedItems(messages, readAt) {
  const out = [];
  let prev;
  let newShown = false;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!prev || caDayKey(prev.at) !== caDayKey(m.at)) out.push({ type: 'day', key: caDayKey(m.at), label: caDayLabel(m.at) });
    let startsGroup = false;
    if (!newShown && readAt && m.at > readAt && m.from.kind === 'agent') {
      out.push({ type: 'new' });
      newShown = true;
      startsGroup = true;
    }
    out.push({ type: 'message', m, head: startsGroup || !caContinues(prev, m) });
    prev = m;
  }
  return out;
}

/** Presence for a member row: offline when its session is gone, working while it runs a turn. */
/**
 * A member's state, with the same meaning and the same names as the terminal UI's session dots (the mobile overview and the tab
 * rail): needs (a permission or a question is blocking it), error, waiting (idle_prompt: it is done and waits for input), working,
 * idle. A member whose session is gone is gone. `hooks` is the set of pending hook types for the session.
 */
function caMemberState(member, session, hooks) {
  if (!member || !member.alive) return 'gone';
  if (hooks && (hooks.has('permission_prompt') || hooks.has('elicitation_dialog'))) return 'needs';
  if (session && session.status === 'error') return 'error';
  if (hooks && hooks.has('idle_prompt')) return 'waiting';
  if (session && session.status === 'stopped') return 'gone';
  if ((session && session.status === 'busy') || member.working) return 'working';
  return 'idle';
}

const CA_STATE_LABEL = {
  needs: 'needs your approval',
  error: 'error',
  waiting: 'waiting for input',
  working: 'working',
  idle: 'idle',
  gone: 'offline',
};

function caPresence(member) {
  if (!member || !member.alive) return 'offline';
  return member.working ? 'working' : 'online';
}

/** Member list sections: the admin (a room's coordinator), then everyone online, then offline. */
function caMemberSections(members) {
  const list = Array.isArray(members) ? members : [];
  const coordinator = list.filter((m) => m.role === 'coordinator');
  const rest = list.filter((m) => m.role !== 'coordinator');
  const online = rest.filter((m) => caPresence(m) !== 'offline');
  const offline = rest.filter((m) => caPresence(m) === 'offline');
  const sections = [];
  if (coordinator.length) sections.push({ key: 'coordinator', label: 'Admin', members: coordinator });
  if (online.length) sections.push({ key: 'online', label: 'Online', members: online });
  if (offline.length) sections.push({ key: 'offline', label: 'Offline', members: offline });
  return sections;
}

/** Quick-switcher results: rooms, direct messages and agents matching the query (case-insensitive). */
function caSwitcherResults(rooms, agents, query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  const match = (label) => !q || label.toLowerCase().includes(q);
  const out = [];
  const list = Array.isArray(rooms) ? rooms : [];
  for (const r of list) {
    if (!r) continue;
    const label = caRoomLabel(r);
    if (match(label)) out.push({ type: caIsDm(r) ? 'dm' : 'room', id: r.id, label, archived: !!r.archivedAt });
  }
  const haveDm = new Set(
    list.filter((r) => caIsDm(r)).flatMap((r) => (r.members || []).map((m) => m.sessionId))
  );
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || haveDm.has(a.id)) continue;
    if (match(a.name || '')) out.push({ type: 'agent', id: a.id, label: a.name || a.id.slice(0, 8) });
  }
  const rank = { room: 0, dm: 1, agent: 2 };
  out.sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || rank[a.type] - rank[b.type]);
  return out.slice(0, limit);
}

const CA_MUTE_CHOICES = [
  ['For 15 minutes', 15 * 60e3],
  ['For 1 hour', 60 * 60e3],
  ['For 3 hours', 3 * 60 * 60e3],
  ['For 8 hours', 8 * 60 * 60e3],
  ['For 24 hours', 24 * 60 * 60e3],
  ['Until I turn it back on', -1],
];
const CA_NOTIFY_LEVELS = [
  ['default', 'Use default', 'All messages'],
  ['all', 'All messages', ''],
  ['mentions', 'Only @mentions', ''],
  ['none', 'Nothing', ''],
];

/** Stored notification choices, cleaned: { [roomId]: { level, until } } (until: ms, or -1 for "until I turn it back on"). */
function caNotifyPrefs(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [id, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object' || id === '__proto__') continue;
    const level = ['all', 'mentions', 'none'].includes(v.level) ? v.level : 'default';
    const until = v.until === -1 ? -1 : Number.isFinite(v.until) && v.until > 0 ? v.until : 0;
    if (level !== 'default' || until) out[id] = { level, until };
  }
  return out;
}

function caIsMuted(pref, now = Date.now()) {
  return !!pref && (pref.until === -1 || pref.until > now);
}

/**
 * The rooms as the sidebar should count them. A muted channel shows nothing (and is dimmed); "Only @mentions" keeps
 * the mention number and drops the plain unread; "Nothing" shows neither. The server's counts are never touched.
 */
function caViewRooms(rooms, prefs, now = Date.now()) {
  const p = prefs || {};
  return (Array.isArray(rooms) ? rooms : []).map((r) => {
    const own = r && Object.hasOwn(p, r.id) ? p[r.id] : null;
    // A channel with no choice of its own follows its workspace's (Discord's "server default").
    const key = r && !caIsDm(r) ? `ws:${r.workspace || ''}` : '';
    const space = key && Object.hasOwn(p, key) ? p[key] : null;
    const pref = own && (own.level !== 'default' || caIsMuted(own, now)) ? own : space || own;
    if (!pref) return r;
    if (caIsMuted(pref, now)) return { ...r, unread: 0, mentions: 0, muted: true };
    if (pref.level === 'mentions') {
      const c = caCounts(r);
      return { ...r, unread: c.mentions, mentions: c.mentions };
    }
    if (pref.level === 'none') return { ...r, unread: 0, mentions: 0 };
    return r;
  });
}

/** A voice channel: a room with a member marked as its voice (it answers spoken turns). Voice features live only here. */
function caIsVoice(room) {
  return !!room && !caIsDm(room) && Array.isArray(room.members) && room.members.some((m) => m && m.voice === true);
}

/** A room car mode and read-aloud can speak in: a voice channel, or a DM with one agent (voice-chat.js chatVoiceMember). */
/** Read aloud choices for a room: [mode, menu label, toast]. */
const CA_READ_ALOUD_MODES = [
  ['off', 'Off', 'Nothing here will be read aloud'],
  ['mine', 'Replies to me', 'Replies to you here will be read aloud'],
  ['all', 'Everyone', 'Every new message here will be read aloud'],
];

function caSpeaks(room) {
  return caIsVoice(room) || (typeof chatVoiceMember === 'function' && !!chatVoiceMember(room));
}

/** The `@query` the caret sits in (at the start or after whitespace), or null. */
function caMentionQuery(value, caret) {
  const text = String(value ?? '');
  const before = text.slice(0, caret ?? text.length);
  const m = /(?:^|\s)@([^\s@]{0,32})$/.exec(before);
  return m ? { start: before.length - m[1].length - 1, query: m[1] } : null;
}

/** Members whose name starts with (then contains) the query, then `@everyone`. */
function caMentionCandidates(members, query, limit = 8) {
  const q = String(query ?? '').toLowerCase();
  const rank = (name) => {
    const n = String(name).toLowerCase();
    return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2;
  };
  const items = (Array.isArray(members) ? members : [])
    .filter((m) => m && m.name && rank(m.name) < 2)
    .map((member, i) => ({ kind: 'member', member, insert: member.name, rank: rank(member.name), i }));
  const everyone = { kind: 'everyone', insert: 'everyone', rank: q ? ('everyone'.startsWith(q) ? 0 : 2) : 3, i: -1 };
  if (everyone.rank < 2 || !q) items.push(everyone);
  items.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return items.slice(0, limit);
}

/**
 * A poll as the card draws it: whether it is open, each option's count, share, voters and whether you chose it, and the
 * total number of people who voted. `me` is the voter id of this page ('user').
 */
function caPollView(poll, now = Date.now(), me = 'user') {
  const votes = poll && typeof poll.votes === 'object' && poll.votes ? poll.votes : {};
  const voters = Object.keys(votes).filter((v) => Array.isArray(votes[v]) && votes[v].length);
  const open = !!poll && !poll.closed && !(Number.isFinite(poll.closesAt) && now >= poll.closesAt);
  const rows = (Array.isArray(poll?.options) ? poll.options : []).map((o) => {
    const who = voters.filter((v) => votes[v].includes(o.id));
    return {
      id: String(o.id),
      label: String(o.label),
      count: who.length,
      pct: voters.length ? Math.round((who.length / voters.length) * 100) : 0,
      voters: who,
      mine: Array.isArray(votes[me]) && votes[me].includes(o.id),
      rec: poll.recommended === o.id,
      leading: false,
    };
  });
  const top = Math.max(0, ...rows.map((r) => r.count));
  for (const r of rows) r.leading = top > 0 && r.count === top;
  return { open, total: voters.length, rows, multi: !!poll?.multi, closesAt: Number.isFinite(poll?.closesAt) ? poll.closesAt : 0 };
}

const CA_QUICK_REACTIONS = ['\u{1F44D}', '\u{1F602}'];
const CA_SHEET_REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F389}', '\u{1F440}'];

/** One short line of a message, for quotes. */
function caSnippet(text, max = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat || '(attachment)';
}

const CA_BACKENDS = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', antigravity: 'Antigravity',
  pi: 'Pi', grok: 'Grok', deepseek: 'DeepSeek', omp: 'OMP', shell: 'Shell',
};

function caCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
}

/**
 * What a session says about how an agent runs, only the facts it actually has: the backend,
 * model, effort, account and directory, and its token and cost totals.
 */
function caAgentFacts(session) {
  if (!session || typeof session !== 'object') return { headline: [], runtime: [], usage: [] };
  const mode = session.mode || 'claude';
  const cfg = session.codexConfig || session.openCodeConfig || session.geminiConfig || session.antigravityConfig
    || session.piConfig || session.grokConfig || session.deepSeekConfig || {};
  const text = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) : '');
  // The model it is running: what the CLI itself reported (its status line or screen) first; otherwise what it was launched with.
  const shown = session.displayModel && typeof session.displayModel === 'object' ? session.displayModel : null;
  const reported = shown && (shown.source === 'statusline' || shown.source === 'screen' || shown.source === 'custom-endpoint');
  const launched = text(session.cliModel) || text(cfg.model) || text(session.model);
  const shownName = text(shown?.model);
  // A launch setting is what was asked for, not a report from the running CLI, so it says so.
  const note = shownName && !reported ? (shown.source === 'config' ? ' (from its config)' : ' (set at launch)') : '';
  const name = shownName || launched;
  const model = name ? `${name}${note}` : '';
  // Effort: what the session was started with (Codex's reasoning effort, or Claude's --effort); in-session /effort changes are not
  // reported to the console, so a Claude session without a launch effort says "default".
  const effortSet = text(cfg.reasoningEffort) || text(session.effort) || text(session.effortLevel);
  const effort = effortSet || (mode === 'claude' ? 'default' : '');
  const headline = [['Model', model], ['Effort', effort]].filter(([, v]) => v);
  const runtime = [
    ['Backend', (Object.hasOwn(CA_BACKENDS, mode) ? CA_BACKENDS[mode] : String(mode))],
    ['CLI version', session.cliVersion || ''],
    ['Account', session.subscriptionProfile?.label || session.cliAccountType || ''],
    ['Directory', session.workingDir || ''],
  ].filter(([, v]) => v);
  const cost = Number(session.totalCost);
  const usage = [
    ['Input tokens', caCount(session.inputTokens)],
    ['Output tokens', caCount(session.outputTokens)],
    ['Cost', Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(2)}` : ''],
  ].filter(([, v]) => v);
  return { headline, runtime, usage };
}

/**
 * The reporting tree from a GET /api/company payload. Optional fields: owner{name,title} (else the
 * settings' owner name/title), employees[].reportsTo (employee id | 'owner'), temporaryAgents[].parentSessionId,
 * settings.coordinatorEmployeeId. No reportsTo -> under the briefing coordinator (or the owner when there is none, or when it is the coordinator
 * itself); a temporary with no known parent -> under the CTO, else the owner. Cycles fall back to the owner.
 */
function caConnectedSessionIds(sessions) {
  return new Set([...(sessions?.values?.() ?? [])]
    .filter((session) => Number.isInteger(session.pid) && session.pid > 1 && !session.retired)
    .map((session) => session.id));
}

function caOrgTree(company, liveIds) {
  const data = company || {};
  const employees = Array.isArray(data.employees) ? data.employees : [];
  const temps = Array.isArray(data.temporaryAgents) ? data.temporaryAgents : [];
  const coordinatorEmployeeId = data.settings?.coordinatorEmployeeId;
  const root = {
    key: 'owner',
    name: data.owner?.name || data.settings?.ownerName || 'Owner',
    title: data.owner?.title || data.settings?.ownerTitle || '',
    icon: '',
    kind: 'owner',
    children: [],
  };
  const nodes = new Map();
  for (const e of employees) {
    nodes.set(e.id, {
      key: `employee:${e.id}`,
      name: e.name,
      title: e.position || '',
      icon: e.icon || '',
      kind: 'employee',
      sessionId: e.sessionId,
      available: e.available !== false,
      children: [],
    });
  }
  const coordinator = coordinatorEmployeeId ? nodes.get(coordinatorEmployeeId) : undefined;
  const parents = new Map();
  const attach = (child, parentRef) => {
    let parent = parentRef === 'owner' ? root : nodes.get(parentRef);
    if (!parent || parent === child) parent = coordinator && coordinator !== child ? coordinator : root;
    for (let up = parent, hops = 0; up && up !== root; hops++) {
      if (up === child || hops > nodes.size) {
        parent = root;
        break;
      }
      up = parents.get(up);
    }
    parents.set(child, parent);
    parent.children.push(child);
  };
  for (const e of employees) attach(nodes.get(e.id), e.reportsTo ?? (e.id === coordinatorEmployeeId ? 'owner' : undefined));
  const bySession = new Map([...nodes.values()].filter((n) => n.sessionId).map((n) => [n.sessionId, n]));
  // Only connected temporary workers belong in the chart. This never changes stored profiles or sessions.
  // A session that is also an employee's is drawn once, as the employee (its temporary record is just the profile it had before).
  const employeeSessions = new Set(employees.map((e) => e.sessionId).filter(Boolean));
  for (const t of temps) {
    if (employeeSessions.has(t.sessionId)) continue;
    if (liveIds && typeof liveIds.has === 'function' && !liveIds.has(t.sessionId)) continue;
    const node = {
      key: `temp:${t.sessionId}`,
      name: t.name,
      title: 'Temporary worker',
      icon: t.icon || '',
      kind: 'temporary',
      sessionId: t.sessionId,
      available: true,
      children: [],
    };
    const parent = (t.parentSessionId && bySession.get(t.parentSessionId)) || coordinator || root;
    parent.children.push(node);
  }
  return root;
}

/**
 * The sections of an agent's profile from GET /api/agents/:id/profile (the reverie runtime's read-only view). Every
 * part is optional; a part the payload does not have is left out. Returns { persona, sections, switchInfo, error }.
 */
function caAgentProfile(data) {
  const d = data && typeof data === 'object' ? data : {};
  const when = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
  };
  const num = (v) => caCount(v);
  const out = { persona: null, personaError: '', sections: [], switchInfo: null };
  const p = d.persona;
  if (p && typeof p === 'object') {
    if (p.error) out.personaError = String(p.error);
    else out.persona = { name: p.agent_name || '', role: p.role || '', kind: p.kind || '', text: String(p.persona || ''), source: p.source || '' };
  }
  const add = (title, rows) => {
    const kept = rows.filter(([, v]) => v !== '' && v !== undefined && v !== null);
    if (kept.length) out.sections.push({ title, rows: kept });
  };
  const e = d.employee;
  if (e && typeof e === 'object') {
    add('Role', [
      ['Position', e.position || ''],
      ['Expertise', Array.isArray(e.expertise) ? e.expertise.join(', ') : ''],
    ]);
  }
  const b = d.backend || {};
  const effort = d.effort || {};
  add('Runtime', [
    ['Backend', b.mode ? (Object.hasOwn(CA_BACKENDS, b.mode) ? CA_BACKENDS[b.mode] : String(b.mode)) : ''],
    // The card's headline (Model, Effort) is what the page knows: the model the CLI reports and the effort it was started with. These are
    // what the reverie runtime measured, labelled as such so the two can never read as a contradiction.
    ['Runtime model', b.display_model || b.model || ''],
    ['Last turn effort', effort.observed?.level ? `${effort.observed.level}${effort.observed.at ? ` (${when(effort.observed.at)})` : ''}` : ''],
    ['Configured effort', effort.configured || ''],
    ['Phase', d.runtime?.phase || ''],
  ]);
  const u = d.usage || {};
  const cost = Number(u.cost);
  add('Usage', [
    ['Input tokens', num(u.input_tokens)],
    ['Output tokens', num(u.output_tokens)],
    ['Total tokens', num(u.total_tokens)],
    ['Messages', num(u.messages)],
    ['Cost', Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(2)}` : ''],
    ['Counted', u.scope || ''],
  ]);
  const s = d.session || {};
  add('Session', [
    ['Status', s.status ? `${s.status}${s.alive === false ? ' (not running)' : ''}` : ''],
    ['Started', when(s.created_at)],
    ['Last active', when(s.last_activity_at)],
    ['Directory', s.working_dir || ''],
  ]);
  if (Array.isArray(d.rooms) && d.rooms.length) {
    add('Channels', d.rooms.map((r) => [r.name || r.id, r.role || '']));
  }
  const sw = d.runtime?.switch;
  const backends = Array.isArray(d.runtime?.backends) ? d.runtime.backends : [];
  if (sw || backends.length) {
    out.switchInfo = {
      available: !!sw?.available,
      reason: String(sw?.reason || 'Switching an agent\'s backend is not available yet.'),
      current: d.runtime?.backend || b.mode || '',
      backends: backends.map((x) => ({ name: String(x.name || ''), mode: String(x.mode || ''), model: String(x.model || ''), enabled: x.enabled !== false })),
    };
  }
  return out;
}

const CA_IMAGE_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The src to draw for an icon that is an image, else ''. Only two forms count: a raster data URL (png, jpeg, webp, gif; at most
 * ~120 KB), or `img:` plus a path under /api/ on this server. Anything else (http, svg, javascript:, a long data URL) is not an image.
 */
function caIconImage(icon, urlFn) {
  const s = typeof icon === 'string' ? icon.trim() : '';
  if (!s) return '';
  if (s.length <= 160000 && CA_IMAGE_DATA.test(s)) return s;
  // An avatar the server stores for an agent: /api/avatars/<id> with an optional version, so a new picture is fetched afresh.
  if (/^\/api\/(?:v1\/)?avatars\/[A-Za-z0-9._~-]+(?:\?v=[0-9]{1,16})?$/.test(s) && !s.includes('..')) return urlFn ? urlFn(s) : s;
  // A workspace's picture, kept on the server: /api/workspace-icons/<32 hex>?v=<ms>.
  if (/^\/api\/(?:v1\/)?workspace-icons\/[0-9a-f]{32}(?:\?v=[0-9]{1,16})?$/.test(s)) return urlFn ? urlFn(s) : s;
  // The owner's picture, kept on the server: /api/owner-avatar/<32 hex>?v=<ms>.
  if (/^\/api\/(?:v1\/)?owner-avatar\/[0-9a-f]{32}(?:\?v=[0-9]{1,16})?$/.test(s)) return urlFn ? urlFn(s) : s;
  if (s.startsWith('img:')) {
    const path = s.slice(4);
    if (/^\/api\/[A-Za-z0-9._~/-]+$/.test(path) && !path.includes('..') && !path.includes('//')) return urlFn ? urlFn(path) : path;
  }
  return '';
}

function caDiskBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let size = Number(value), unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/**
 * The numbers for the CPU / memory / GPU / disk readout from GET /api/system/stats and GET /api/system/gpu: a list of
 * { key, label, value (a percentage), title, level } where level is ok, warn (>= 70) or high (>= 90). The GPU is
 * left out when the host publishes no fresh reading.
 */
function caStatsView(stats) {
  const out = [];
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
  const pct = (v) => (Number.isFinite(num(v)) ? Math.max(0, Math.min(100, Math.round(num(v)))) : null);
  const level = (n) => (n >= 90 ? 'high' : n >= 70 ? 'warn' : 'ok');
  const gb = (mb) => `${(Number(mb) / 1024).toFixed(1)} GB`;
  const s = stats || {};
  const cpu = pct(s.cpu);
  if (cpu !== null) out.push({ key: 'cpu', label: 'CPU', value: cpu, title: `CPU load ${cpu}%`, level: level(cpu) });
  const mem = pct(s.memory?.percent);
  if (mem !== null) {
    const detail = Number(s.memory?.totalMB) > 0 ? ` (${gb(s.memory.usedMB)} of ${gb(s.memory.totalMB)})` : '';
    out.push({ key: 'mem', label: 'MEM', value: mem, title: `Memory ${mem}%${detail}`, level: level(mem) });
  }
  const gpu = s.gpu && s.gpu.available ? pct(s.gpu.utilization) : null;
  if (gpu !== null) {
    const vram = Number(s.gpu.memoryTotalMb) > 0 ? `, memory ${gb(s.gpu.memoryUsedMb)} of ${gb(s.gpu.memoryTotalMb)}` : '';
    out.push({ key: 'gpu', label: 'GPU', value: gpu, title: `GPU ${gpu}%${vram}`, level: level(gpu) });
  }
  const filesystems = s.disks?.available === true && Array.isArray(s.disks.filesystems) ? s.disks.filesystems.slice(0, 8).filter(fs =>
    fs && Number.isFinite(fs.totalBytes) && fs.totalBytes > 0 && Number.isFinite(fs.availableBytes) && fs.availableBytes >= 0 && fs.availableBytes <= fs.totalBytes && Array.isArray(fs.labels) && fs.labels.some(label => typeof label === 'string' && label.trim())
  ).map(fs => ({ ...fs, labels: fs.labels.filter(label => typeof label === 'string' && label.trim()).map(label => label.slice(0, 60)), usedBytes: fs.totalBytes - fs.availableBytes, percentUsed: Math.round(100 * (fs.totalBytes - fs.availableBytes) / fs.totalBytes) })) : [];
  if (filesystems.length) {
    const value = Math.max(...filesystems.map(fs => fs.percentUsed));
    const details = filesystems.map(fs => `${fs.labels.join(' · ')}: ${caDiskBytes(fs.usedBytes)} used, ${caDiskBytes(fs.availableBytes)} available, ${caDiskBytes(fs.totalBytes)} capacity`).join('\n');
    out.push({ key: 'disk', label: 'DISK', value, title: `Disk ${value}% · highest filesystem usage\n${details}`, level: level(value), filesystems });
  }
  return out;
}

const CA_PROFILE_HUES = [200, 160, 120, 45, 15, 335, 285, 245];

/** A stored profile, cleaned: every field optional, trimmed and capped. */
function caProfile(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== 'object') o = {};
  const text = (v, max) => (typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max).join('') : '');
  const hue = Number.isFinite(o.hue) && CA_PROFILE_HUES.includes(o.hue) ? o.hue : null;
  const image = typeof o.image === 'string' && caIconImage(o.image) === o.image.trim() && o.image.startsWith('data:') ? o.image.trim() : '';
  return { name: text(o.name, 32), pronouns: text(o.pronouns, 24), status: text(o.status, 60), icon: text(o.icon, 2), image, hue };
}

/** Which view to open with: a popped-out terminal window or a session link is a terminal on purpose. */
function caInitialView({ stored, solo, hasSessionLink, legacy }) {
  if (legacy || solo || hasSessionLink) return 'debug';
  return stored === 'debug' ? 'debug' : 'chat';
}

/* ───────────────────────── storage helpers ───────────────────────── */

function caStore(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}
function caRead(kind, key, fallback) {
  try {
    const raw = caStore(kind)?.getItem(key);
    return raw === null || raw === undefined ? fallback : raw;
  } catch {
    return fallback;
  }
}
function caWrite(kind, key, value) {
  try {
    if (value === null) caStore(kind)?.removeItem(key);
    else caStore(kind)?.setItem(key, value);
  } catch {
    /* per-device convenience only */
  }
}

const CA_ICONS = {
  reorder: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  members: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  org: '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-5h14v5"/>',
  invite: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  gearsmall: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  embassy: '<path d="M3 10h18L12 4 3 10ZM5 10v10m5-10v10m4-10v10m5-10v10M2 20h20"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
};

/** The Board is pinned above the channel list, shown in the main pane. */
const CA_PAGES = {
  board: { label: 'Board', icon: 'calendar', path: '/board' },
  company: { label: 'Company', icon: 'org', path: null, nav: false },
  'company-plans': { label: 'Company plans', icon: 'gauge', path: null, nav: false },
  'company-people': { label: 'Company people', icon: 'members', path: null, nav: false },
  embassies: { label: 'Embassies', icon: 'embassy', path: null, nav: false },
};

/** Which supported page a URL fragment asks for, or null. */
function caPageFromHash(hash) {
  const key = String(hash || '').replace(/^#/, '');
  return Object.hasOwn(CA_PAGES, key) ? key : null;
}

/* ───────────────────────── the app ───────────────────────── */

class ReverieChatApp {
  /** @param {object} app the ReverieApp singleton @param {Document} doc */
  constructor(app, doc = document) {
    this.profileRefreshMs = 4000;
    this.app = app;
    this.doc = doc;
    this.view = 'chat';
    /** The Board page shown in place of the conversation, or null. */
    this.embed = null;
    this._embedRoom = null;
    // The rail follows the open room until the user picks a workspace by hand.
    this.workspace = 'home';
    this._wsPinned = false;
    this.collapsed = {};
    try {
      this.collapsed = JSON.parse(caRead('local', 'reverie:chat:collapsed', '{}')) || {};
    } catch {
      this.collapsed = {};
    }
    this.membersOpen = caRead('local', 'reverie:chat:members', '1') !== '0';
    this.drawer = null;
    this.seenAt = {};
    this.features = {};
    this.els = {};
    this.built = false;
    this._readMarkAt = 0;
    this._pendingPlacement = null;
  }

  /* ── element helpers ── */

  el(tag, className, text) {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  literalText(tag, className, text) {
    const node = this.el(tag, className, text);
    node.setAttribute('data-i18n-skip', '');
    return node;
  }

  button(className, label, onClick, { text, icon } = {}) {
    const b = this.el('button', className);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    if (icon) b.append(this.icon(icon));
    if (text !== undefined) b.append(this.el('span', '', text));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  icon(name) {
    const svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    // The path data is a fixed constant of this file, never user input.
    svg.innerHTML = CA_ICONS[name] || '';
    return svg;
  }

  /** The channel mark for a glyph from caRoomGlyph: the text `#`, or the drawn lock/speaker marks (monochrome, themed by colour). */
  glyphNode(glyph, extraClass = '') {
    const node = this.el('span', `ca-hash${extraClass ? ` ${extraClass}` : ''}${glyph.label ? ' is-private' : ''}`, glyph.text);
    node.dataset.glyph = glyph.kind;
    if (glyph.kind !== 'text') {
      node.classList.add('is-drawn');
      const svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 20 20');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.7');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = CA_GLYPHS[glyph.kind] || '';
      node.append(svg);
    }
    return node;
  }

  toast(text, kind = 'info') {
    this.app.showToast?.(text, kind);
  }

  get rooms() {
    return this.app._chatRooms || [];
  }

  get room() {
    return this.app._chatRoom || null;
  }

  get roomId() {
    return this.app._chatRoomId || null;
  }

  /** The server sends unread counts and direct messages (the new part); an older one does not. */
  get serverFeatures() {
    const f = this.app._chatFeatures || {};
    return { pollingModes: Array.isArray(f.pollingModes) ? f.pollingModes.filter(mode => typeof mode === 'string') : [], unread: !!f.unread, dms: !!f.dms, placement: !!f.placement, replies: !!f.replies, deletes: !!f.deletes, reports: !!f.reports, topics: !!f.topics, edits: !!f.edits, pins: !!f.pins, order: !!f.order, notify: !!f.notify, replace: !!f.replace };
  }

  get active() {
    return this.built && this.view === 'chat';
  }

  /* ── lifecycle ── */

  /** Build the shell and load the real rooms. Safe to call once. */
  async start() {
    if (this.built) return;
    this.app._chatApp = this;
    this.build();
    this.built = true;
    this.installKeys();
    this.installViewport();
    // The loader chose a view before the page's own code ran, when a `#session=` link was still in the
    // URL (the app takes it out of the address bar on construction); a link the app is already holding
    // counts the same. Either way the terminal was asked for, so the shell must not switch it away.
    // Exception: the loader's own watchdog may have fired on a slow but healthy load. That fallback was
    // not a request for the terminal, so it is ignored (and cleared) once the shell really is up.
    const html = this.doc.documentElement;
    const fellBack = html.hasAttribute('data-reverie-fallback');
    html.removeAttribute('data-reverie-fallback');
    const chosen = fellBack ? null : html.getAttribute('data-reverie-view');
    this.setView(
      caInitialView({
        stored: caRead('session', 'reverie:view', ''),
        solo: !!this.app.isSoloWindow || chosen === 'debug',
        hasSessionLink: !!this.app._urlSessionId,
        legacy: html.hasAttribute('data-reverie-legacy'),
      }),
      { initial: true }
    );
    const linkedRoom = new URL(this.doc.defaultView.location.href).searchParams.get('room');
    if (linkedRoom && /^[a-zA-Z0-9-]{1,100}$/.test(linkedRoom)) {
      this.setView('chat', { initial: true });
      await this.loadRooms(linkedRoom);
    } else if (this.view === 'chat') await this.loadRooms();
    this.loadOwner();
    this.scheduleNotifyTick();
    this.touchHint();
    this.startStats();
    this.embassy = new ReverieEmbassyView(this);
  }

  /** Once, on a touch screen: the message actions are a long press away (there is no hover toolbar). */
  touchHint() {
    // About chat messages, so never while the terminal view is showing; it comes up the first time the chat is.
    if (this.view !== 'chat') return;
    const w = this.doc.defaultView;
    if (!w?.matchMedia?.('(hover: none)')?.matches || caRead('local', 'reverie:chat:hint', '')) return;
    caWrite('local', 'reverie:chat:hint', '1');
    this.toast('Press and hold a message for reactions, reply and more', 'info');
  }

  /* ── CPU / memory / GPU / disk readout ── */

  /** Start polling the machine's load and the host's GPU reading (every 5 s while the page is visible). */
  startStats() {
    this.stats = this.stats || {};
    const w = this.doc.defaultView;
    const tick = async () => {
      if (this.doc.visibilityState === 'hidden') return;
      const res = await this.app._chatApi('/api/system/stats');
      if (res.ok) this.stats = { ...this.stats, cpu: res.data?.cpu, memory: res.data?.memory, disks: res.data?.disks };
      // A small file read on the server; an older server without the route simply shows no GPU.
      const gpu = await this.app._chatApi('/api/system/gpu');
      this.stats = { ...this.stats, gpu: gpu.ok ? gpu.data : undefined };
      this.renderStats();
    };
    this.stopStats();
    tick();
    this._statsTimer = w?.setInterval(tick, 5000);
  }

  stopStats() {
    if (this._statsTimer) this.doc.defaultView?.clearInterval(this._statsTimer);
    this._statsTimer = 0;
  }

  /** Draw the readout at the bottom of the sidebar (the one place; on a phone it is in the channel drawer). */
  renderStats() {
    const view = caStatsView(this.stats);
    for (const box of [this.els.stats]) {
      if (!box) continue;
      box.replaceChildren();
      box.hidden = !view.length;
      for (const item of view) {
        const chip = this.el(item.key === 'disk' ? 'button' : 'span', `ca-stat is-${item.level}`);
        chip.title = item.title;
        if (item.key === 'disk') {
          chip.type = 'button'; chip.dataset.stat = 'disk';
          chip.addEventListener('click', () => this.openDiskDetails(item.filesystems));
        } else chip.setAttribute('role', 'img');
        chip.setAttribute('aria-label', item.title);
        const bar = this.el('span', 'ca-stat-bar');
        bar.style.setProperty('--v', `${item.value}%`);
        chip.append(this.el('span', 'ca-stat-label', item.label), this.el('span', 'ca-stat-value', `${item.value}%`), bar);
        box.append(chip);
      }
    }
  }

  openDiskDetails(filesystems) {
    this.doc.querySelector('.ca-disk-dialog')?.close();
    const dialog = this.el('dialog', 'ca-dialog ca-disk-dialog'); dialog.setAttribute('aria-label', 'Disk usage');
    dialog.append(this.el('h2', '', 'Disk usage'), this.el('p', 'ca-dialog-note', 'Whole filesystem capacity for the locations Reverie uses. Locations sharing a filesystem appear together. Used includes reserved space.'));
    const list = this.el('dl', 'ca-disk-filesystems');
    for (const fs of filesystems) {
      const row = this.el('div');
      row.append(this.literalText('dt', '', fs.labels.join(' · ')));
      const detail = this.el('dd');
      const meter = this.el('progress'); meter.max = 100; meter.value = fs.percentUsed; meter.setAttribute('aria-label', `${fs.labels.join(', ')} ${fs.percentUsed}% used`);
      detail.append(this.el('strong', '', `${fs.percentUsed}% used`), meter, this.el('span', '', `${caDiskBytes(fs.usedBytes)} used · ${caDiskBytes(fs.availableBytes)} available · ${caDiskBytes(fs.totalBytes)} capacity`));
      row.append(detail); list.append(row);
    }
    const close = this.button('ca-btn', 'Close disk usage', () => dialog.close(), { text: 'Close' });
    dialog.append(list, close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); this.els.stats?.querySelector('[data-stat="disk"]')?.focus(); });
    this.doc.body.append(dialog); dialog.showModal(); close.focus();
  }

  /** The instance's configured owner name (company settings), the default for how you are called. */
  async loadOwner() {
    const res = await this.app._chatApi('/api/company');
    if (!res.ok) return;
    this.company = res.data;
    await this.loadPhoneStatus();
    this.ownerName = String(res.data?.settings?.ownerName || '').trim();
    // An agent's own profile icon (the company record: an employee, else a temporary agent) is the one icon it wears everywhere.
    const before = this.profileSig;
    this.profileIcons = caProfileIcons(res.data);
    this.profileAvatars = caProfileAvatars(res.data);
    this.profilePronouns = caProfilePronouns(res.data);
    await this.loadWsIcons();
    const ownerAvatar = typeof res.data?.settings?.ownerAvatar === 'string' ? res.data.settings.ownerAvatar : '';
    this.ownerAvatar = caIconImage(ownerAvatar) ? ownerAvatar : '';
    this.profileSig = JSON.stringify([[...this.profileIcons], [...this.profileAvatars], [...this.profilePronouns], (res.data?.employees || []).map((employee) => [employee.id, employee.name, employee.icon, employee.avatar]), this.wsIcons, this.ownerAvatar]);
    this.renderUser();
    if (this.view === 'chat') {
      // Avatars are drawn into the sidebar, the member list and the feed: redraw all of them when an icon changed.
      if (before !== this.profileSig) this.renderAll();
      // Every room event (a vote, a status) reloads the profiles: the feed is redrawn for a changed name or picture, but never moved.
      this.renderFeed({ keepScroll: true });
    }
    this.maybePromptOwnerName();
  }

  /** Offer a display name once per tab session, only after verified owner sign-in. */
  maybePromptOwnerName() {
    if (this.ownerName || this.company?.canManage !== true || this.phoneStatus?.self !== 'owner' || this.phoneStatus?.canSetOwn !== true) return;
    const key = `reverie:owner-name-prompted:${this.company.settings?.owner || 'owner'}`;
    this._ownerNamePrompts ||= new Set();
    if (this._ownerNamePrompts.has(key) || caRead('session', key, '') || this.doc.querySelector('dialog[open]')) return;
    this._ownerNamePrompts.add(key);
    caWrite('session', key, '1');
    this.openProfileEditor({ firstRun: true });
  }

  /** The workspaces' pictures kept on the server (name -> URL); a server without them leaves the browser's own. */
  async loadWsIcons() {
    const res = await this.app._chatApi('/api/workspace-icons');
    const icons = res.ok && res.data?.icons && typeof res.data.icons === 'object' ? res.data.icons : {};
    const clean = {};
    for (const [name, url] of Object.entries(icons)) if (typeof url === 'string' && caIconImage(url)) clean[name] = url;
    this.wsIcons = clean;
  }

  /** Reload the company's profiles after a change elsewhere (an agent set its icon): at most one every few seconds, the last call always honoured. */
  refreshProfiles() {
    const now = Date.now();
    const wait = this._profilesAt ? this.profileRefreshMs - (now - this._profilesAt) : 0;
    if (wait > 0) {
      // A call inside the window is not lost: one trailing reload runs when the window ends, so another device's change (a new
      // picture) is picked up even when a different event came first.
      if (!this._profilesTimer) {
        this._profilesTimer = setTimeout(() => {
          this._profilesTimer = 0;
          this._profilesAt = Date.now();
          this.loadOwner();
        }, wait);
      }
      return;
    }
    this._profilesAt = now;
    this.loadOwner();
  }

  /** The picture an agent set for itself (the company record's avatar, else the one on its room membership), or ''. */
  profileAvatar(sessionId, member) {
    return (sessionId && this.profileAvatars?.get(sessionId)) || (member && caIconImage(member.avatar) ? member.avatar : '') || '';
  }

  /** The profile icon of an agent session, if it has one. */
  profileIcon(sessionId) {
    return sessionId && this.profileIcons?.get(sessionId) || '';
  }

  async loadRooms(preferId) {
    const stored = preferId || caRead('local', 'reverie:chatroom', '') || undefined;
    await this.app._loadChatRooms(stored);
    this.renderAll();
  }

  setView(view, { initial = false } = {}) {
    this.view = view === 'debug' ? 'debug' : 'chat';
    const html = this.doc.documentElement;
    html.setAttribute('data-reverie-view', this.view);
    // Only a choice made here is remembered: the view the page opened with (a link, a fallback) is not.
    if (!initial) caWrite('session', 'reverie:view', this.view === 'debug' ? 'debug' : null);
    this.els.root.hidden = this.view === 'debug';
    if (this.view === 'chat' && this.built) this.touchHint();
    if (this.view === 'debug') {
      this.ensureBackButton();
      // The terminal UI was hidden while it was mounted: let it measure itself again.
      this.doc.defaultView?.dispatchEvent(new Event('resize'));
    } else if (!initial) {
      this.renderAll();
      this.markReadSoon();
    }
  }

  /** Open the chosen agent's terminal without the legacy navigation. */
  showDebug(sessionId) {
    if (sessionId && !this.app.sessions?.has?.(sessionId)) {
      this.toast('That agent has no open terminal session', 'error');
      return;
    }
    const target = sessionId || this.app.activeSessionId;
    if (this.app._tileGrid?.open) {
      this.app.closeTileGrid({ keepStored: true, reselect: false, animate: false });
      this.app.activeSessionId = null;
    }
    this.app.closeSplitPane?.({ skipPrimaryResize: true });
    this.setView('debug');
    if (target) this.app.selectSession(target);
  }

  showChat() {
    this.app._chatUnread = 0;
    this.setView('chat');
    this.els.composerInput()?.focus?.();
  }

  ensureBackButton() {
    if (this.els.back?.isConnected) return;
    const brand = this.doc.documentElement.hasAttribute('data-reverie-legacy')
      ? this.doc.querySelector('.header-brand') || this.doc.body
      : this.doc.body;
    const back = this.button('ca-back', 'Back to chat', () => this.showChat(), { icon: 'back', text: 'Back to chat' });
    back.classList.add('ca-back');
    brand.prepend(back);
    this.els.back = back;
  }

  /* ── build ── */

  build() {
    const root = this.el('div', 'ca-root');
    root.id = 'chatApp';
    this.els.root = root;

    const rail = this.el('nav', 'ca-rail');
    rail.setAttribute('aria-label', 'Workspaces');
    const side = this.el('aside', 'ca-side');
    side.setAttribute('aria-label', 'Channels and direct messages');
    const sideHead = this.el('div', 'ca-side-head');
    const find = this.button('ca-find', 'Find or start a conversation (Ctrl+K)', () => this.openSwitcher(), {
      text: 'Find or start a conversation',
    });
    sideHead.append(find);
    const sideTitle = this.el('div', 'ca-side-title');
    const sideScroll = this.el('div', 'ca-side-scroll');
    const user = this.el('div', 'ca-user');
    user.setAttribute('role', 'group');
    user.setAttribute('aria-label', 'Your profile');
    const stats = this.el('div', 'ca-stats');
    stats.hidden = true;
    stats.setAttribute('aria-label', 'Machine load');
    side.append(sideHead, sideTitle, sideScroll, stats);

    const main = this.el('main', 'ca-main');
    const head = this.el('header', 'ca-head');
    const navBtn = this.button('ca-icon-btn ca-only-narrow', 'Open channels', () => this.toggleDrawer('channels'), { icon: 'menu' });
    const headTitle = this.el('h1', 'ca-head-title');
    const headTopic = this.el('p', 'ca-head-topic');
    const spacer = this.el('span', 'ca-spacer');
    const membersBtn = this.button('ca-icon-btn ca-head-members', 'Show member list', () => this.toggleMembers(), { icon: 'members' });
    membersBtn.setAttribute('aria-controls', 'ca-members-list');
    const membersDot = this.el('span', 'ca-members-chip-dot');
    const membersCount = this.el('span', 'ca-members-chip-count');
    membersDot.setAttribute('aria-hidden', 'true');
    membersCount.setAttribute('aria-hidden', 'true');
    membersBtn.append(membersDot, membersCount);
    const inviteBtn = this.button('ca-icon-btn ca-head-invite', 'Add people to this channel', () => this.room && this.openInviteDialog(this.room.id), { icon: 'invite' });
    inviteBtn.title = 'Add people to this channel';
    inviteBtn.hidden = true;
    const pinsBtn = this.button('ca-icon-btn ca-head-pins', 'Pinned messages', () => this.room && this.openPinsDialog(this.room.id), { icon: 'pin' });
    pinsBtn.hidden = true;
    const phoneBtn = this.button('ca-icon-btn ca-head-phone', 'Install app and notifications', () => window.ReverieMobile?.open(), { icon: 'phone' });
    const bellBtn = this.button('ca-icon-btn ca-head-bell', 'Notification settings', () => this.openNotifyMenu(bellBtn), { icon: 'bell' });
    bellBtn.setAttribute('aria-haspopup', 'menu');
    // On or off; who is read ("Replies to me" or "Everyone") is chosen in the channel menu.
    const speakBtn = this.button('ca-icon-btn ca-head-speak', 'Enable spoken replies in this room', () => {
      this.app._setSpeakReplies?.(this.roomId, this.app._speakRepliesIn?.(this.roomId) ? 'off' : 'mine');
      this.renderHeader();
    }, { text: '🔊' });
    const carBtn = this.button('ca-icon-btn ca-head-car', 'Car mode', () => this.app.openCarMode?.(), { text: '🚗' });
    const moreBtn = this.button('ca-icon-btn ca-head-more', 'More actions', () => this.openHeaderMenu(moreBtn), { text: '⋯' });
    moreBtn.title = 'More actions';
    moreBtn.setAttribute('aria-haspopup', 'menu');
    speakBtn.hidden = carBtn.hidden = true;
    head.append(navBtn, headTitle, inviteBtn, headTopic, spacer, speakBtn, carBtn, pinsBtn, phoneBtn, bellBtn, membersBtn, moreBtn);

    const body = this.el('div', 'ca-body');
    const chat = this.el('section', 'ca-chat');
    chat.setAttribute('aria-label', 'Conversation');
    const members = this.el('aside', 'ca-members');
    members.id = 'ca-members-list';
    members.setAttribute('aria-label', 'Members');
    body.append(chat, members);
    main.append(head, body);

    const scrim = this.el('div', 'ca-scrim');
    scrim.addEventListener('click', () => this.toggleDrawer(null));
    root.append(rail, side, user, main, scrim);
    this.doc.body.append(root);

    Object.assign(this.els, {
      rail, side, sideHead, sideTitle, sideScroll, user, main, head, headTitle, headTopic,
      membersBtn, membersDot, membersCount, bellBtn, navBtn, inviteBtn, pinsBtn, phoneBtn, speakBtn, carBtn, moreBtn, chat, members, scrim, stats, body,
    });

    // Reuse the chat panel's feed, composer, mic, attachments and create form: it becomes the
    // conversation column, the rest of its chrome (head, member cards, footer) is hidden by CSS.
    this.app._buildChatroomPanel();
    const panel = this.app._chatroomPanel;
    panel.hidden = false;
    panel.classList.add('ca-panel');
    chat.append(panel);
    this.els.panel = panel;
    this.els.composerInput = () => this.app._chatEls?.input;
    this.installDrop(chat);
    // One line until the text needs more, then growing up to 40% of the screen.
    const input = this.app._chatEls.input;
    input.rows = 1;
    input.addEventListener('input', () => this.fitInput());
    this.installMentions();
    this.installReply();
    this.installTyping();
    this.installComposerChrome();
    // Scrolling to the newest message is what reads it.
    this.app._chatEls.feed.addEventListener('scroll', () => this.markReadSoon(), { passive: true });
    this.renderAll();
    this.renderUser();
    // Back and forward move between the conversation and Board; a #board link opens it.
    this.doc.defaultView?.addEventListener('popstate', () => {
      const kind = caPageFromHash(this.doc.defaultView.location.hash);
      if (kind) this.openPage(kind, { push: false });
      else this.closePage({ history: false });
    });
    const first = caPageFromHash(this.doc.defaultView?.location.hash);
    if (first) this.openPage(first, { push: false });
  }

  /** Keep Tab and Shift+Tab inside a full-screen settings page. */
  trapTab(root) {
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll('button:not(:disabled), input, textarea, select')].filter((x) => !x.hidden && !x.closest('[hidden]'));
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      const active = this.doc.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  /* ── workspace settings (Discord's "Server Settings") ── */

  /**
   * Name, icon and colour of a workspace. The name is how its channels are filed (each channel's workspace), so renaming
   * moves them; icon and colour are kept in this browser. The default workspace takes its name from the instance.
   */
  openWorkspaceSettings(key) {
    this.doc.querySelector('.ca-settings')?.remove();
    const opener = this.doc.activeElement;
    const isDefault = !key;
    const label = key || this.defaultWorkspaceName();
    const rooms = this.rooms.filter((r) => !caIsDm(r) && (r.workspace || '') === key);
    const root = this.el('section', 'ca-settings ca-ws-settings');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `Workspace settings: ${label}`);
    const nav = this.el('nav', 'ca-settings-nav');
    nav.append(this.el('div', 'ca-settings-title', label), this.el('button', 'ca-settings-tab', 'Workspace profile'));
    nav.lastChild.type = 'button';
    nav.lastChild.setAttribute('aria-current', 'page');
    const main = this.el('div', 'ca-settings-main');
    const body = this.el('div', 'ca-settings-body');
    body.append(this.el('h2', 'ca-settings-h', 'Workspace profile'));
    body.append(this.el('p', 'ca-hint', 'A workspace groups channels, like a server or an organisation. Its picture is kept on the server, so it shows on every device you sign in on; its emoji and colour show in the left bar on this device.'));
    const meta = Object.hasOwn(this.wsMeta, key) ? this.wsMeta[key] : {};
    const draft = { name: label, icon: meta.icon || '', image: this.iconImage(meta.image) ? meta.image : '', hue: Number.isFinite(meta.hue) ? meta.hue : null };
    const state = { ...draft };
    const dirty = () => draft.name.trim() !== state.name || draft.icon !== state.icon || draft.image !== state.image || draft.hue !== state.hue;
    const bar = this.el('div', 'ca-savebar');
    bar.hidden = true;
    const sync = () => {
      bar.hidden = !dirty();
    };
    const nameWrap = this.el('label', 'ca-label');
    nameWrap.append(this.el('span', 'ca-label-text', 'Name'));
    const name = this.el('input', 'ca-field');
    name.maxLength = 40;
    name.value = draft.name;
    name.disabled = isDefault;
    name.addEventListener('input', () => {
      draft.name = name.value;
      sync();
    });
    nameWrap.append(name);
    if (isDefault) nameWrap.append(this.el('span', 'ca-hint', 'The default workspace is named by the instance (Settings, display name).'));
    const iconWrap = this.el('label', 'ca-label');
    iconWrap.append(this.el('span', 'ca-label-text', 'Icon (an emoji or up to two characters)'));
    const icon = this.el('input', 'ca-field');
    icon.maxLength = 4;
    icon.value = draft.icon;
    icon.placeholder = 'leave empty for the first letter';
    icon.addEventListener('input', () => {
      draft.icon = Array.from(icon.value.trim()).slice(0, 2).join('');
      sync();
    });
    iconWrap.append(icon);
    const colour = this.el('div', 'ca-label');
    colour.append(this.el('span', 'ca-label-text', 'Colour'));
    const swatches = this.el('div', 'ca-swatches');
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', 'Workspace colour');
    const paint = () => {
      for (const b of swatches.children) b.setAttribute('aria-checked', String((b.dataset.hue === '' ? null : Number(b.dataset.hue)) === draft.hue));
    };
    for (const h of [null, ...CA_PROFILE_HUES]) {
      const b = this.el('button', 'ca-swatch');
      b.type = 'button';
      b.dataset.hue = h === null ? '' : String(h);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', h === null ? 'No colour' : `Colour ${h}`);
      if (h !== null) b.style.setProperty('--chat-hue', String(h));
      else b.classList.add('is-none');
      b.addEventListener('click', () => {
        draft.hue = h;
        paint();
        sync();
      });
      swatches.append(b);
    }
    paint();
    colour.append(swatches);
    const pic = this.workspaceLogoField(draft.image, (v) => {
      draft.image = v;
      sync();
    });
    body.append(nameWrap, iconWrap, pic.wrap, colour);
    const members = new Set(rooms.flatMap((r) => (r.members || []).map((m) => m.sessionId)));
    body.append(this.el('p', 'ca-hint', `${rooms.length} channel${rooms.length === 1 ? '' : 's'} \u00B7 ${members.size} agent${members.size === 1 ? '' : 's'}`));
    main.append(body);
    const close = this.button('ca-settings-close', 'Close settings (Esc)', () => finish(), { text: '\u2715' });
    const row = this.el('div', 'ca-savebar-row');
    const reset = this.el('button', 'ca-btn', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      Object.assign(draft, state);
      name.value = state.name;
      icon.value = state.icon;
      pic.set(state.image);
      paint();
      sync();
    });
    const save = this.el('button', 'ca-btn is-primary', 'Save changes');
    save.type = 'button';
    save.addEventListener('click', async () => {
      if (pic.pending()) return;
      const next = draft.name.trim();
      if (!isDefault && next !== state.name) {
        const clash = next.toLowerCase() === 'home' || next.toLowerCase() === this.defaultWorkspaceName().toLowerCase() || this.rooms.some((r) => !caIsDm(r) && r.workspace && r.workspace !== key && r.workspace.toLowerCase() === next.toLowerCase());
        if (!next || clash) return this.toast('Pick a name that is not Home, the default workspace or another workspace.', 'error');
        save.disabled = true;
        for (const r of rooms) {
          const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(r.id)}/placement`, { method: 'PUT', body: { workspace: next, category: r.category || '' } });
          if (!res.ok) {
            save.disabled = false;
            return this.toast(`Chat: ${res.error} (some channels may already be in "${next}")`, 'error');
          }
        }
        // Its picture on the server follows the name.
        if (Object.keys(this.wsIcons || {}).some((n) => n.toLowerCase() === key.toLowerCase())) {
          const moved = await this.app._chatApi('/api/workspace-icons/rename', { method: 'POST', body: { from: key, to: next } });
          if (!moved.ok) this.toast(`Renamed, but its picture could not be moved on the server (${moved.error}). Choose it again under the new name.`, 'error');
          await this.loadWsIcons();
        }
        // The look follows the name.
        const all = this.wsMetaLocal;
        if (Object.hasOwn(all, key)) {
          all[next] = all[key];
          delete all[key];
          caWrite('local', 'reverie:chat:wsmeta', JSON.stringify(all));
        }
        if (this.workspace === key) this.workspace = next;
        // Its notification choice follows the name.
        const notify = this.notifyPrefs;
        if (Object.hasOwn(notify, `ws:${key}`)) {
          notify[`ws:${next}`] = notify[`ws:${key}`];
          delete notify[`ws:${key}`];
          caWrite('local', 'reverie:chat:notify', JSON.stringify(notify));
        }
        await this.app._loadChatRooms(this.roomId);
      }
      const finalKey = !isDefault && next !== state.name ? next : key;
      // The picture lives on the server (owner only). A new one that cannot be saved there stays in this browser, with a note; a
      // removal the server refused is reported as that, and the server's picture keeps showing. A server link is never stored locally.
      let image = draft.image;
      const onServer = Object.keys(this.wsIcons || {}).some((n) => n.toLowerCase() === finalKey.toLowerCase());
      if (draft.image !== state.image && (draft.image || onServer)) {
        const stored = await this.saveWsPicture(finalKey, draft.image);
        if (stored) image = '';
        else if (draft.image) this.toast('The picture could not be saved on the server; it is kept on this device only.', 'info');
        else this.toast('The picture could not be removed on the server, so it is still shown.', 'error');
      }
      if (image.startsWith('/api/')) image = '';
      save.disabled = false;
      this.setWsMeta(finalKey, { icon: draft.icon, image, hue: draft.hue });
      Object.assign(state, { name: next || state.name, icon: draft.icon, image: draft.image, hue: draft.hue });
      sync();
      this.toast('Workspace saved', 'info');
    });
    row.append(this.el('span', '', 'Careful: you have unsaved changes.'), this.el('span', 'ca-spacer'), reset, save);
    bar.append(row);
    root.append(nav, main, close, bar);
    this.doc.body.append(root);
    this.els.settings = root;
    this.els.root.inert = true;
    this.trapTab(root);
    const finish = () => {
      if (dirty() && !this.doc.defaultView?.confirm('Discard your unsaved changes?')) return;
      root.remove();
      this.els.settings = null;
      this.els.root.inert = false;
      this.doc.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && !this.doc.querySelector('dialog[open]')) {
        e.stopPropagation();
        finish();
      }
    };
    this.doc.addEventListener('keydown', onKey, true);
    (isDefault ? icon : name).focus();
  }

  /**
   * Put a workspace's picture on the server (a data URL from the picker) or clear it (''). Returns true when the server has it
   * (or has none, for a clear), false when the server refused or is too old, so the caller keeps the picture in this browser.
   */
  async saveWsPicture(key, image) {
    const path = `/api/workspace-icons${image ? `/image?name=${encodeURIComponent(key)}` : `?name=${encodeURIComponent(key)}`}`;
    try {
      let init = { method: 'DELETE' };
      if (image) {
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
        if (!m) return false;
        const bin = this.doc.defaultView.atob(m[2]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        init = { method: 'PUT', headers: { 'Content-Type': m[1] }, body: bytes };
      }
      const res = await this.doc.defaultView.fetch(path, init);
      if (!res.ok) return false;
      await this.loadWsIcons();
      return true;
    } catch {
      return false;
    }
  }

  /* ── channel settings ── */

  /**
   * The channel's settings screen (Discord's "Edit Channel"): Overview (name, topic, workspace, category),
   * Members, and the channel's archive and delete. Saving shows only when something changed.
   */
  async openChannelSettings(roomId) {
    if (this.roomId !== roomId) await this.selectRoom(roomId);
    const room = this.room;
    if (!room || room.id !== roomId || caIsDm(room)) return;
    this.doc.querySelector('.ca-settings')?.remove();
    const opener = this.doc.activeElement;
    const root = this.el('section', 'ca-settings');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `Edit channel ${room.name}`);
    const nav = this.el('nav', 'ca-settings-nav');
    nav.setAttribute('aria-label', 'Channel settings');
    nav.append(this.el('div', 'ca-settings-title', `# ${room.name}`));
    const main = this.el('div', 'ca-settings-main');
    const body = this.el('div', 'ca-settings-body');
    const close = this.button('ca-settings-close', 'Close settings (Esc)', () => finish(), { text: '\u2715' });
    const bar = this.el('div', 'ca-savebar');
    bar.hidden = true;
    main.append(body);
    root.append(nav, main, close, bar);
    this.doc.body.append(root);
    this.els.settings = root;

    const state = { name: room.name, topic: room.topic || '', workspace: room.workspace || '', category: room.category || '' };
    const draft = { ...state };
    const dirty = () => Object.keys(state).some((k) => state[k] !== draft[k]);
    const showBar = () => {
      bar.hidden = !dirty();
    };
    const finish = () => {
      if (dirty() && !this.doc.defaultView?.confirm('Discard your unsaved changes?')) return;
      root.remove();
      this.els.settings = null;
      this.doc.removeEventListener('keydown', onKey, true);
      this._settingsClosed?.();
      opener?.focus?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && !this.doc.querySelector('dialog[open]')) {
        e.stopPropagation();
        finish();
      }
    };
    this.doc.addEventListener('keydown', onKey, true);
    // The page behind is inert while the settings are open, and Tab stays inside them.
    this.els.root.inert = true;
    const trap = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll('button:not(:disabled), input, textarea, select')].filter((x) => !x.hidden && x.offsetParent !== null || x === this.doc.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      const active = this.doc.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', trap);
    this._settingsClosed = () => {
      this.els.root.inert = false;
      this._settingsClosed = null;
      this.refreshSettings = null;
    };

    const tabs = {};
    const show = (key) => {
      for (const [k, b] of Object.entries(tabs)) b.setAttribute('aria-current', k === key ? 'page' : 'false');
      body.replaceChildren(...this.settingsPage(key, this.room?.id === room.id ? this.room : room, draft, showBar));
    };
    // The Members page repaints when the room changes under it (a member removed, a coordinator made).
    this.refreshSettings = () => {
      if (this._settingsKey === 'members' && this.els.settings) show('members');
    };
    for (const [key, label] of [['overview', 'Overview'], ['members', 'Members']]) {
      const b = this.el('button', 'ca-settings-tab', label);
      b.type = 'button';
      b.addEventListener('click', () => show(key));
      tabs[key] = b;
      nav.append(b);
    }
    nav.append(this.el('hr', 'ca-menu-sep'));
    const archive = this.el('button', 'ca-settings-tab', room.archivedAt ? 'Restore channel' : 'Archive channel');
    archive.type = 'button';
    archive.addEventListener('click', async () => {
      await this.archive(!room.archivedAt);
      finish();
    });
    const del = this.el('button', 'ca-settings-tab is-danger', 'Delete channel');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!this.doc.defaultView?.confirm(`Delete "${room.name}" and its history?`)) return;
      const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
      if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
      draft.name = state.name;
      root.remove();
      this.els.settings = null;
      this.doc.removeEventListener('keydown', onKey, true);
      this._settingsClosed?.();
    });
    nav.append(archive, del);

    const saveRow = this.el('div', 'ca-savebar-row');
    const note = this.el('span', '', 'Careful: you have unsaved changes.');
    const reset = this.el('button', 'ca-btn', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      Object.assign(draft, state);
      show(this._settingsKey || 'overview');
      showBar();
    });
    const save = this.el('button', 'ca-btn is-primary', 'Save changes');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      const change = {};
      if (draft.name.trim() !== state.name) change.name = draft.name.trim();
      if (this.serverFeatures.topics && draft.topic !== state.topic) change.topic = draft.topic;
      if (Object.keys(change).length) {
        const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(room.id)}`, { method: 'PUT', body: change });
        if (!res.ok) {
          save.disabled = false;
          return this.toast(`Chat: ${res.error}`, 'error');
        }
      }
      if (draft.workspace.trim() !== state.workspace || draft.category.trim() !== state.category) {
        const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(room.id)}/placement`, {
          method: 'PUT',
          body: { workspace: draft.workspace.trim(), category: draft.category.trim() },
        });
        if (!res.ok) {
          save.disabled = false;
          return this.toast(`Chat: ${res.error}`, 'error');
        }
      }
      save.disabled = false;
      Object.assign(state, { name: draft.name.trim(), topic: draft.topic, workspace: draft.workspace.trim(), category: draft.category.trim() });
      draft.name = state.name;
      nav.querySelector('.ca-settings-title').textContent = `# ${state.name}`;
      showBar();
      this.toast('Channel saved', 'info');
    });
    saveRow.append(note, this.el('span', 'ca-spacer'), reset, save);
    bar.append(saveRow);
    show('overview');
    tabs.overview.focus();
  }

  /** One page of the settings screen, as nodes. */
  settingsPage(key, room, draft, changed) {
    this._settingsKey = key;
    const field = (label, prop, max, { textarea = false, list, hint } = {}) => {
      const wrap = this.el('label', 'ca-label');
      wrap.append(this.el('span', 'ca-label-text', label));
      const input = this.el(textarea ? 'textarea' : 'input', 'ca-field');
      if (textarea) input.rows = 5;
      input.maxLength = max;
      input.value = draft[prop];
      if (list) input.setAttribute('list', list.id);
      input.addEventListener('input', () => {
        draft[prop] = input.value;
        if (counter) counter.textContent = String(max - input.value.length);
        changed();
      });
      wrap.append(input);
      let counter;
      if (textarea) {
        counter = this.el('span', 'ca-counter', String(max - input.value.length));
        wrap.append(counter);
      }
      if (hint) wrap.append(this.el('span', 'ca-hint', hint));
      if (list) wrap.append(list);
      return wrap;
    };
    const datalist = (id, values) => {
      const dl = this.el('datalist');
      dl.id = id;
      for (const v of values) dl.append(new Option(v, v));
      return dl;
    };
    if (key === 'members') {
      const out = [this.el('h2', 'ca-settings-h', 'Members')];
      const invite = this.button('ca-btn is-primary', 'Invite agents', () => this.openInviteDialog(room.id), { text: 'Invite agents' });
      out.push(invite);
      if (room.members.some((m) => m.role === 'coordinator')) {
        out.push(this.button('ca-btn', 'Clear the admin', () => this.app._appointChatCoordinator(null), { text: 'Clear admin' }));
      }
      const list = this.el('ul', 'ca-invite-list');
      for (const m of room.members) {
        const li = this.el('li', 'ca-invite-row');
        li.append(this.app._chatAvatar(m.sessionId, m.name, { size: 'md' }));
        const text = this.el('div', 'ca-invite-text');
        text.append(this.el('strong', '', m.name), this.el('span', 'ca-invite-sub', m.role === 'coordinator' ? 'Admin' : caPresence(m)));
        li.append(text);
        if (m.role !== 'coordinator') {
          li.append(this.button('ca-btn', `Make ${m.name} admin`, () => this.app._appointChatCoordinator(m.sessionId), { text: 'Make admin' }));
        }
        li.append(this.button('ca-btn', `Remove ${m.name} from this channel`, () => this.app._removeChatMember(m), { text: 'Remove' }));
        list.append(li);
      }
      out.push(list);
      return out;
    }
    const spaces = [...new Set(this.rooms.filter((r) => !caIsDm(r)).map((r) => r.workspace).filter(Boolean))];
    const cats = [...new Set(this.rooms.filter((r) => !caIsDm(r)).map((r) => r.category).filter(Boolean))];
    const out = [this.el('h2', 'ca-settings-h', 'Overview'), field('Channel name', 'name', 80)];
    if (this.serverFeatures.topics) {
      out.push(field('Channel topic', 'topic', 500, { textarea: true, hint: 'Shown under the channel name.' }));
    }
    if (this.serverFeatures.placement) {
      out.push(
        field('Workspace (empty for the default one)', 'workspace', 40, { list: datalist('ca-set-ws', spaces) }),
        field('Category (empty for none)', 'category', 40, { list: datalist('ca-set-cat', cats) })
      );
    }
    out.push(this.visibilityControl(room));
    if (this.serverFeatures.notify) out.push(this.wakeControl(room));
    return out;
  }

  /**
   * An agent that moved to a new session (a plan switch) is offline here under its old one: pick the new session and the old one's place in
   * EVERY room (role, goal, settings) moves to it. Same-name sessions are listed first.
   */
  openReplaceDialog(m) {
    this.doc.querySelector('.ca-dialog.ca-replace')?.remove();
    const room = this.room;
    const dlg = this.el('dialog', 'ca-dialog ca-replace');
    dlg.setAttribute('aria-label', `Move ${m.name} to a new session`);
    const head = this.el('div', 'ca-invite-head');
    const titles = this.el('div');
    titles.append(this.el('h2', '', `Move ${m.name} to a new session`), this.el('p', 'ca-dialog-note', 'Its place in every room (role, goal, settings) moves to the session you pick. Earlier messages keep the old name.'));
    head.append(titles, this.button('ca-icon-btn', 'Close', () => dlg.close(), { text: '\u2715' }));
    const inRoom = new Set((room?.members || []).map((x) => x.sessionId));
    const same = (s) => s.name.trim().toLowerCase() === String(m.name || '').trim().toLowerCase();
    const candidates = (this.app._chatCandidateSessions?.(inRoom) || []).filter((s) => s.mode !== 'shell').sort((a, b) => Number(same(b)) - Number(same(a)));
    const list = this.el('ul', 'ca-invite-list');
    if (!candidates.length) list.append(this.el('li', 'ca-invite-empty', 'No other agent session is open.'));
    for (const s of candidates) {
      const li = this.el('li', 'ca-invite-row');
      li.append(this.app._chatAvatar(s.id, s.name, { size: 'md' }));
      const text = this.el('div', 'ca-invite-text');
      text.append(this.el('strong', '', s.name), this.el('span', 'ca-invite-sub', same(s) ? 'Same name' : String(s.mode || '')));
      li.append(text);
      const b = this.button('ca-btn', `Move ${m.name} to ${s.name}`, async () => {
        b.disabled = true;
        const res = await this.app._chatApi('/api/chatrooms/members/replace', { method: 'POST', body: { from: m.sessionId, to: s.id } });
        if (!res.ok) {
          b.disabled = false;
          return this.toast(`Chat: ${res.error}`, 'error');
        }
        const n = res.data?.rooms?.length || 0;
        this.toast(`${m.name} moved to the new session in ${n} room${n === 1 ? '' : 's'}`, 'info');
        dlg.close();
        await this.app._loadChatRooms?.(this.roomId);
      }, { text: 'Move' });
      li.append(b);
      list.append(li);
    }
    dlg.append(head, list);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
  }

  /**
   * The sessions left behind by plan switches: out of every room and hidden, kept only as a rollback. Restore puts its places back (its
   * successor retires in its stead); Delete closes the old session itself and drops it for good.
   */
  async openRetiredDialog() {
    this.doc.querySelector('.ca-dialog.ca-retired')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-retired');
    dlg.setAttribute('aria-label', 'Retired sessions');
    const head = this.el('div', 'ca-invite-head');
    const titles = this.el('div');
    titles.append(this.el('h2', '', 'Retired sessions'), this.el('p', 'ca-dialog-note', 'Old sessions replaced after a plan switch. They are in no room and hidden everywhere; Restore moves their places back.'));
    head.append(titles, this.button('ca-icon-btn', 'Close', () => dlg.close(), { text: '\u2715' }));
    const list = this.el('ul', 'ca-invite-list');
    const paint = async () => {
      const res = await this.app._chatApi('/api/chatrooms/retired');
      list.replaceChildren();
      if (!res.ok) return list.append(this.el('li', 'ca-invite-empty', `Could not load: ${res.error}`));
      const rows = res.data?.retired || [];
      if (!rows.length) list.append(this.el('li', 'ca-invite-empty', 'No retired sessions.'));
      for (const r of rows) {
        const li = this.el('li', 'ca-invite-row');
        const text = this.el('div', 'ca-invite-text');
        const successor = this.app.sessions?.get?.(r.successorId)?.name || r.successorId.slice(0, 8);
        text.append(this.el('strong', '', r.name), this.el('span', 'ca-invite-sub', `Replaced by ${successor}, ${new Date(r.at).toLocaleString()}`), this.el('span', 'ca-hint', r.rooms.length ? `Was in ${r.rooms.map((x) => x.name).join(', ')}` : 'Was in no room'));
        li.append(text);
        const restore = this.button('ca-btn', `Restore ${r.name}`, async () => {
          if (!this.doc.defaultView?.confirm(`Move ${r.name}'s places back? ${successor} will be retired in its stead.`)) return;
          const out = await this.app._chatApi(`/api/chatrooms/retired/${encodeURIComponent(r.sessionId)}/restore`, { method: 'POST', body: {} });
          if (!out.ok) return this.toast(`Chat: ${out.error}`, 'error');
          this.toast(`${r.name} is back in ${out.data?.rooms?.length || 0} room(s)`, 'info');
          await this.app._loadChatRooms?.(this.roomId);
          await paint();
        }, { text: 'Restore' });
        restore.disabled = !r.restorable;
        if (!r.restorable) restore.title = 'That session is gone, so there is nothing to restore';
        const forget = this.button('ca-btn', `Delete ${r.name}`, async () => {
          if (!this.doc.defaultView?.confirm(`Delete ${r.name}? Its terminal is closed and the session removed (its transcript stays on disk). It stops being a rollback.`)) return;
          const out = await this.app._chatApi(`/api/chatrooms/retired/${encodeURIComponent(r.sessionId)}`, { method: 'DELETE' });
          if (!out.ok) return this.toast(`Chat: ${out.error}`, 'error');
          await this.app._loadChatRooms?.(this.roomId);
          await paint();
        }, { text: 'Delete' });
        li.append(restore, forget);
        list.append(li);
      }
    };
    dlg.append(head, list);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    await paint();
  }

  /** Override one agent's notification choice (it can set it itself with `reverie agent chat notify`). */
  async setMemberNotify(m, mode) {
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/members/${encodeURIComponent(m.sessionId)}/notify`, { method: 'PUT', body: { mode } });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    await this.app._loadChatRoom(this.roomId, { quiet: true });
    this.toast(mode === 'mentions' ? `${m.name} is now woken only by @mentions, replies and you` : `${m.name} is woken as the room says`, 'info');
  }

  /** What a message to the whole channel wakes: everyone, only those it names (plus replies and the coordinator), or the console's default. */
  wakeControl(room) {
    const wrap = this.el('fieldset', 'ca-visibility ca-wake');
    wrap.append(this.el('legend', 'ca-label-text', 'Who a message wakes'));
    const note = this.el('span', 'ca-hint', '');
    const notes = {
      default: 'The console\'s default (set by whoever runs it).',
      all: 'Every agent in the channel is woken by every message: each costs every agent a turn.',
      mentions: 'Only the agents a message @names, the author it replies to and the coordinator are woken. The others still read it with their next prompt, and you always wake someone.',
    };
    const current = room.wake === 'all' || room.wake === 'mentions' ? room.wake : 'default';
    const sync = (v) => {
      note.textContent = notes[v];
    };
    for (const [value, label] of [['default', 'Console default'], ['all', 'Everyone (every message wakes every agent)'], ['mentions', 'Only those named (@mention), replies and the coordinator']]) {
      const row = this.el('label', 'ca-radio');
      const input = this.el('input');
      input.type = 'radio';
      input.name = 'ca-wake';
      input.value = value;
      input.checked = value === current;
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(room.id)}/wake`, { method: 'PUT', body: { mode: value } });
        if (!res.ok) {
          this.toast(`Chat: ${res.error}`, 'error');
          for (const r of wrap.querySelectorAll('input')) r.checked = r.value === current;
          return;
        }
        sync(value);
      });
      row.append(input, this.el('span', '', label));
      wrap.append(row);
    }
    sync(current);
    wrap.append(note);
    return wrap;
  }

  /** The owner's choice for a channel: members only (private, the default) or open to every agent, who can then list and join it. */
  visibilityControl(room) {
    const wrap = this.el('fieldset', 'ca-visibility');
    wrap.append(this.el('legend', 'ca-label-text', 'Who can find and join this channel'));
    const note = this.el('span', 'ca-hint', '');
    const sync = (v) => {
      note.textContent = v === 'public' ? 'Public: every agent can list this channel and join it.' : 'Private: only members. It is not listed for anyone else, and an agent has to be added.';
    };
    const current = room.visibility === 'public' ? 'public' : 'private';
    for (const [value, label] of [['private', 'Private (members only)'], ['public', 'Public (any agent can join)']]) {
      const row = this.el('label', 'ca-radio');
      const input = this.el('input');
      input.type = 'radio';
      input.name = 'ca-visibility';
      input.value = value;
      input.checked = value === current;
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(room.id)}/visibility`, { method: 'PUT', body: { visibility: value } });
        if (!res.ok) {
          this.toast(`Chat: ${res.error}`, 'error');
          for (const r of wrap.querySelectorAll('input')) r.checked = r.value === current;
          return;
        }
        sync(value);
      });
      row.append(input, this.el('span', '', label));
      wrap.append(row);
    }
    sync(current);
    wrap.append(note);
    return wrap;
  }

  /* ── invite agents to a channel ── */

  /** Pick agents to add to a channel (Discord's "Invite friends"). Added agents are briefed by the server. */
  openInviteDialog(roomId) {
    const room = this.rooms.find((r) => r.id === roomId) || (this.room?.id === roomId ? this.room : null);
    if (!room || caIsDm(room)) return;
    this.doc.querySelector('.ca-dialog.ca-invite')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-invite');
    dlg.setAttribute('aria-label', `Invite agents to ${room.name}`);
    const head = this.el('div', 'ca-invite-head');
    const titles = this.el('div');
    titles.append(this.el('h2', '', `Invite agents to #${room.name}`), this.el('p', 'ca-dialog-note', 'They join this channel and are briefed on it.'));
    head.append(titles, this.button('ca-icon-btn', 'Close', () => dlg.close(), { text: '\u2715' }));
    const search = this.el('input', 'ca-field');
    search.type = 'search';
    search.placeholder = 'Search for agents';
    search.setAttribute('aria-label', 'Search for agents');
    const list = this.el('ul', 'ca-invite-list');
    const invited = new Set();
    const inRoom = new Set((room.members || []).map((m) => m.sessionId));
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const candidates = (this.app._chatCandidateSessions?.(inRoom) || []).filter((s) => s.mode !== 'shell' && (!q || s.name.toLowerCase().includes(q)));
      list.replaceChildren();
      if (!candidates.length) list.append(this.el('li', 'ca-invite-empty', q ? 'No agent matches.' : 'Every open agent is already here.'));
      for (const s of candidates) {
        const li = this.el('li', 'ca-invite-row');
        li.append(this.app._chatAvatar(s.id, s.name, { size: 'md' }));
        const text = this.el('div', 'ca-invite-text');
        text.append(this.el('strong', '', s.name), this.el('span', 'ca-invite-sub', (Object.hasOwn(CA_BACKENDS, s.mode) ? CA_BACKENDS[s.mode] : String(s.mode || ''))));
        li.append(text);
        const done = invited.has(s.id);
        const b = this.button('ca-btn', done ? `${s.name} invited` : `Invite ${s.name}`, async () => {
          b.disabled = true;
          const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/members`, { method: 'POST', body: { sessionId: s.id } });
          if (!res.ok) {
            b.disabled = false;
            return this.toast(`Chat: ${res.error}`, 'error');
          }
          invited.add(s.id);
          inRoom.add(s.id);
          paint();
        }, { text: done ? 'Invited' : 'Invite' });
        b.disabled = done;
        li.append(b);
        list.append(li);
      }
    };
    search.addEventListener('input', paint);
    paint();
    dlg.append(head, search, list);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    search.focus();
  }

  /** Company is a first-class chat surface; management requires a verified owner. */
  async openCompany(section = 'plans', { push = true } = {}) {
    this.toggleDrawer(null);
    if (this.companyPage?.isConnected) {
      this._companySection?.(section, push);
      return;
    }
    this.embassy?.close();
    if (this.orgOpen) this.closeOrg();
    let panel = this.els.page;
    if (!panel) {
      panel = this.el('section', 'ca-page');
      this.els.body.append(panel);
      this.els.page = panel;
    }
    const dlg = this.el('section', 'ca-company');
    this.companyPage = dlg;
    dlg.setAttribute('aria-label', 'Company');
    panel.replaceChildren(dlg);
    panel.dataset.kind = 'company';
    panel.hidden = false;
    this._embedRoom = this.roomId;
    this.els.root.classList.add('is-page');
    this.els.chat.inert = true;
    this.els.members.inert = true;
    const head = this.el('header', 'ca-company-head');
    head.append(this.el('span', 'ca-spacer'), this.button('ca-btn', 'Back to chat', () => { this.closePage(); this.els.sideScroll.querySelector('.ca-company-nav')?.focus(); }, { text: 'Back to chat' }));
    const content = this.el('div', 'ca-company-content');
    content.id = 'ca-company-people';
    content.setAttribute('aria-label', 'Company people');
    const plans = this.el('section', 'ca-company-plans');
    plans.id = 'ca-company-plans';
    plans.setAttribute('aria-label', 'Company plans');
    const selectSection = (_key, updateHistory = true) => {
      this.embed = 'company';
      if (updateHistory) {
        const win = this.doc.defaultView;
        if (caPageFromHash(win.location.hash) !== this.embed) {
          try { win.history.pushState({ reveriePage: this.embed }, '', `#${this.embed}`); } catch {}
        }
      }
      let frame = plans.querySelector('iframe');
      if (!frame) {
        frame = this.el('iframe', 'ca-company-plans-frame');
        frame.title = 'Company plans and burn rate';
        frame.src = '/company/plans';
        plans.append(frame);
      } else frame.contentWindow?.postMessage({ type: 'company-plans-visible' }, this.doc.defaultView.location.origin);
      this.renderSidebar();
      this.renderHeader();
      void this._companyRefresh?.();
    };
    this._companySection = selectSection;
    const status = this.el('p', 'ca-hint', 'Loading company…');
    status.setAttribute('role', 'status');
    let refreshHireOptions = async () => {};
    this._companyResize = event => {
      const frame = plans.querySelector('iframe');
      if (this.companyPage !== dlg || !dlg.isConnected || event.origin !== this.doc.defaultView.location.origin || !frame || event.source !== frame.contentWindow) return;
      if (event.data?.type === 'company-plans-changed') void refreshHireOptions();
      else if (event.data?.type === 'company-plans-height' && Number.isFinite(event.data.height))
        plans.style.height = `${Math.max(120, Math.min(10000, event.data.height))}px`;
    };
    this.doc.defaultView.addEventListener('message', this._companyResize);
    dlg.append(head, plans, content, status);
    selectSection(section, push);
    const paint = async () => {
      const [res, auth] = await Promise.all([this.app._chatApi('/api/company'), this.app._chatApi('/api/chatrooms/phone-status')]);
      if (this.companyPage !== dlg || !dlg.isConnected) return;
      content.replaceChildren();
      head.querySelector('[aria-controls="ca-company-hire"]')?.remove();
      head.querySelector('.ca-company-settings-button')?.remove();
      if (!res.ok) { status.textContent = `Could not load company: ${res.error}`; return; }
      const data = res.data || {};
      const employees = data.employees || [];
      const manage = data.canManage === true && auth.ok && auth.data?.self === 'owner' && auth.data?.canSetOwn === true;
      status.textContent = '';
      const cards = new Map();
      for (const employee of employees) {
        const card = this.el('article', 'ca-company-person');
        card.dataset.employeeId = employee.id;
        const title = this.el('div', 'ca-company-person-title');
        const avatar = this.el('span', 'chatroom-avatar chatroom-avatar--md ca-company-icon');
        avatar.append(this.el('span', 'chatroom-avatar-glyph', employee.icon || '👤'));
        if (employee.avatar) this.fillAvatar(avatar, employee.avatar);
        title.append(avatar, this.literalText('strong', '', employee.name));
        const parent = employee.reportsTo && employee.reportsTo !== 'owner' ? employees.find(e => e.id === employee.reportsTo)?.name : data.settings?.ownerName || 'Owner';
        card.append(title, this.literalText('span', 'ca-company-role', employee.position || ''), parent ? this.literalText('span', 'ca-company-parent', parent) : this.el('span', 'ca-company-parent', 'Unassigned'), this.el('span', `ca-company-state${employee.available && !employee.onVacation ? ' is-connected' : ''}`, employee.onVacation ? 'On vacation' : employee.available ? 'Connected' : 'Disconnected'));
        if (manage) {
          const label = this.el('label', 'ca-hint', ' May recover disconnected employee sessions');
          const recovery = this.el('input', '');
          recovery.type = 'checkbox';
          recovery.checked = employee.permissions?.recoverEmployees === true;
          recovery.disabled = employee.onVacation === true;
          recovery.setAttribute('aria-label', `Recovery permission for ${employee.name}`);
          label.prepend(recovery);
          const save = this.button('ca-btn', 'Save permissions', async () => {
            const result = await this.app._chatApi(`/api/company/employees/${encodeURIComponent(employee.id)}`, {
              method: 'PUT', body: { permissions: { recoverEmployees: recovery.checked } },
            });
            status.textContent = result.ok ? 'Employee permissions saved.' : `Could not save permissions: ${result.error || 'request failed'}`;
          });
          save.setAttribute('aria-label', `Save permissions for ${employee.name}`);
          save.disabled = employee.onVacation === true;
          save.textContent = 'Save permissions';
          const controls = this.el('div', 'ca-company-person-controls');
          controls.append(label, save, this.button('ca-btn', `Edit profile for ${employee.name}`, () => this.openEmployeeProfile(employee, paint), { text: 'Edit profile' }));
          const restart = this.button('ca-btn', `Restart session for ${employee.name}`, () => this.openEmployeeRestart(employee, paint), { text: 'Restart session' });
          restart.disabled = employee.onVacation === true;
          if (restart.disabled) restart.title = 'Return this expert from vacation before restarting.';
          controls.append(restart);
          card.append(controls);
          const lifecycle = this.el('div', 'ca-company-actions');
          const lifecycleError = this.el('p', 'ca-company-error');
          lifecycleError.setAttribute('role', 'alert');
          let changingLifecycle = false;
          const changeLifecycle = async (action) => {
            if (changingLifecycle) return;
            changingLifecycle = true;
            for (const button of lifecycle.querySelectorAll('button')) button.disabled = true;
            const returning = employee.onVacation === true;
            const confirmLabel = action === 'retire' ? 'Retire' : returning ? 'Return from vacation' : 'Send on vacation';
            const question = action === 'retire'
              ? `Retire ${employee.name}? This removes this expert from the company and its rooms, while keeping their identity in chat history.`
              : returning
                ? `Return ${employee.name} from vacation? This restores active status and makes this expert eligible for recovery again.`
                : `Send ${employee.name} on vacation? This pauses their session and excludes this expert from automatic recovery until you return them.`;
            lifecycleError.textContent = '';
            let applied = false;
            const success = action === 'retire' ? `Retired ${employee.name}.` : returning ? `${employee.name} returned from vacation.` : `${employee.name} is on vacation.`;
            try {
              if (!await this.confirmCompanyAction(employee.name, question, confirmLabel) || this.companyPage !== dlg || !card.isConnected) return;
              const result = await this.app._chatApi(`/api/company/employees/${encodeURIComponent(employee.id)}/${action}`, {
                method: 'POST', body: action === 'vacation' ? { enabled: !returning } : {},
              });
              if (!result.ok) { lifecycleError.textContent = result.error || `Could not update ${employee.name}.`; return; }
              applied = true;
              await this.loadOwner();
              await paint();
              status.textContent = `${success}${result.data?.failed?.length ? ' Some room removals failed; this expert may still appear in those rooms.' : ''}`;
            } catch {
              lifecycleError.textContent = applied ? `${success} The view could not refresh. Reopen Company to see the updated roster.` : `Could not update ${employee.name}. Try again.`;
              if (applied) status.textContent = lifecycleError.textContent;
            } finally {
              if (!applied) {
                changingLifecycle = false;
                for (const button of lifecycle.querySelectorAll('button')) button.disabled = false;
              }
            }
          };
          lifecycle.append(
            this.button('ca-btn', `${employee.onVacation ? 'Return from vacation' : 'Send on vacation'}: ${employee.name}`, () => changeLifecycle('vacation'), { text: employee.onVacation ? 'Return from vacation' : 'Send on vacation' }),
            this.button('ca-btn', `Retire ${employee.name}`, () => changeLifecycle('retire'), { text: 'Retire' })
          );
          card.append(lifecycle, lifecycleError);
        }
        const work = this.el('div', 'ca-company-work');
        work.dataset.employeeId = employee.id;
        work.append(this.el('p', 'ca-hint', 'Loading work status…'));
        card.append(work);
        cards.set(employee.id, card);
      }
      const chart = this.el('section', 'ca-company-chart');
      chart.append(this.el('h3', '', 'Reporting structure'));
      const tree = this.el('ul', 'ca-company-tree ca-company-roster');
      const visited = new Set();
      const branch = (parentId, ancestors = new Set()) => {
        const list = this.el('ul', '');
        for (const e of employees.filter(e => (e.reportsTo || 'owner') === parentId)) {
          if (ancestors.has(e.id) || visited.has(e.id)) continue;
          visited.add(e.id);
          const item = this.el('li', '');
          const card = cards.get(e.id);
          if (card) item.append(card);
          const next = new Set(ancestors); next.add(e.id);
          const children = branch(e.id, next); if (children.childElementCount) item.append(children);
          list.append(item);
        }
        return list;
      };
      const ownerNode = this.el('li', ''); ownerNode.append(data.settings?.ownerName ? this.literalText('strong', '', data.settings.ownerName) : this.el('strong', '', 'Owner'), branch('owner')); tree.append(ownerNode);
      for (const employee of employees.filter(employee => !visited.has(employee.id))) {
        if (visited.has(employee.id)) continue;
        visited.add(employee.id);
        const item = this.el('li', '');
        const card = cards.get(employee.id);
        if (card) item.append(card);
        item.append(branch(employee.id, new Set([employee.id])));
        tree.append(item);
      }
      chart.append(tree);
      if (!employees.length) chart.append(this.el('p', 'ca-hint', 'No permanent team members yet.'));
      const people = this.el('section', 'ca-company-people');
      people.append(this.el('h3', '', `People · ${employees.length}`), chart);
      if (manage) {
        const recovery = this.el('form', 'ca-company-form ca-company-recovery');
        recovery.append(this.el('h3', '', 'Crash recovery'));
        const enabledLabel = this.el('label', 'ca-label');
        const enabled = this.el('input', ''); enabled.type = 'checkbox';
        enabled.checked = data.settings?.autoWakeEnabled !== false;
        enabled.setAttribute('aria-label', 'Automatic recovery');
        enabledLabel.append(enabled, this.el('span', '', 'Automatic recovery'));
        const expertLabel = this.el('label', 'ca-label');
        expertLabel.append(this.el('span', 'ca-label-text', 'Wake after a crash'));
        const expert = this.el('select', 'ca-field');
        expert.setAttribute('aria-label', 'Wake after a crash');
        const coordinator = data.settings?.coordinatorEmployeeId;
        const recoveryEmployees = employees.filter(employee => !employee.onVacation);
        const roots = recoveryEmployees.filter(employee => {
          const parent = employee.reportsTo ?? (employee.id === coordinator ? 'owner' : coordinator);
          return !parent || parent === 'owner';
        });
        const automatic = this.literalText('option', '', roots.length === 1 ? `Automatic: ${roots[0].name}` : 'Choose an expert');
        automatic.value = ''; expert.append(automatic);
        for (const employee of recoveryEmployees) {
          const option = this.literalText('option', '', employee.name);
          option.value = employee.id; expert.append(option);
        }
        const selected = employees.some(employee => employee.id === data.settings?.crashWakeEmployeeId && employee.onVacation) ? '' : data.settings?.crashWakeEmployeeId || '';
        if (selected && !employees.some(employee => employee.id === selected)) {
          const missing = this.el('option', '', 'Unavailable expert'); missing.value = selected;
          expert.append(missing);
        }
        expert.value = selected;
        expert.disabled = !enabled.checked;
        enabled.addEventListener('change', () => { expert.disabled = !enabled.checked; });
        expertLabel.append(expert);
        const save = this.el('button', 'ca-btn', 'Save recovery'); save.type = 'submit';
        recovery.append(enabledLabel, expertLabel, this.el('p', 'ca-hint', 'Only this expert wakes automatically. They can wake reports with permission.'), save);
        recovery.addEventListener('submit', async event => {
          event.preventDefault(); save.disabled = true;
          const changes = { ...data.settings, autoWakeEnabled: enabled.checked };
          if (expert.value) changes.crashWakeEmployeeId = expert.value;
          else delete changes.crashWakeEmployeeId;
          try {
            const result = await this.app._chatApi('/api/company/settings', { method: 'PUT', body: changes });
            status.textContent = result.ok ? 'Recovery settings saved.' : `Could not save recovery settings: ${result.error || 'request failed'}`;
            if (result.ok) data.settings = result.data?.settings || changes;
          } catch {
            status.textContent = 'Could not save recovery settings. Try again.';
          } finally { save.disabled = false; }
        });
        people.insertBefore(recovery, chart);
      }
      content.replaceChildren(people);
      let workLoading = false;
      this._companyRefresh = async () => {
        if (workLoading || this.companyPage !== dlg || this.doc.hidden) return;
        workLoading = true;
        try {
          const board = await this.app._chatApi('/api/board');
          if (this.companyPage !== dlg || !dlg.isConnected) return;
          for (const employee of employees) {
            const work = [...content.querySelectorAll('.ca-company-work')].find(node => node.dataset.employeeId === employee.id);
            if (work) work.replaceChildren(this.companyWorkEl(employee, board.ok ? board.data : null));
          }
        } catch {
          if (this.companyPage === dlg) for (const work of content.querySelectorAll('.ca-company-work')) work.replaceChildren(this.el('p', 'ca-hint', 'Work status unavailable. Retrying in a minute.'));
        } finally { workLoading = false; }
      };
      void this._companyRefresh();
      if (!manage) {
        const note = this.el('p', 'ca-hint', 'Sign in as the owner to hire and manage your team.');
        const signIn = this.el('a', 'ca-company-signin', 'Owner sign-in'); signIn.href = '/owner/account';
        content.append(note, signIn); return;
      }
      const section = this.el('section', 'ca-company-hire');
      section.hidden = true; section.id = 'ca-company-hire';
      const hire = this.button('ca-btn is-primary', 'Hire', () => { section.hidden = !section.hidden; hire.setAttribute('aria-expanded', String(!section.hidden)); if (!section.hidden) { section.scrollIntoView({ block: 'nearest' }); plan.focus(); } }, { text: '+ Hire' });
      hire.setAttribute('aria-expanded', 'false'); hire.setAttribute('aria-controls', section.id); head.insertBefore(hire, head.lastElementChild);
      section.append(this.el('h3', '', 'Hire an agent'), this.el('p', 'ca-hint', 'Create a permanent expert with its own memory. Choose a plan and harness. Model and effort use the defaults and can be changed later in Runtime settings.'));
      const form = this.el('form', 'ca-company-form');
      const field = (name, label, tag = 'input') => {
        const wrap = this.el('label', 'ca-label'); wrap.append(this.el('span', 'ca-label-text', label));
        const input = this.el(tag, 'ca-field'); input.name = name; input.setAttribute('aria-label', label); wrap.append(input); form.append(wrap); return input;
      };
      const options = await this.app._chatApi('/api/company/hire-options');
      if (this.companyPage !== dlg || !dlg.isConnected) return;
      let sources = options.ok && Array.isArray(options.data?.sources) ? options.data.sources : [];
      let harnesses = options.ok && Array.isArray(options.data?.harnesses) ? options.data.harnesses : [];
      const plan = field('plan', 'Plan or local model', 'select');
      const placeholder = this.el('option', '', 'Choose a plan or local model'); placeholder.value = ''; plan.append(placeholder); plan.required = true;
      for (const source of sources) {
        const option = this.el('option', '', `${source.label}${source.kind === 'local' ? ' · Local model' : ''}`);
        option.value = `${source.kind}:${source.id}`; option.disabled = !source.modes?.length;
        plan.append(option);
      }
      plan.disabled = !sources.some(source => source.modes?.length);
      const harness = field('mode', 'Harness', 'select'); harness.required = true;
      const selectedSource = () => sources.find((source) => `${source.kind}:${source.id}` === plan.value);
      const updatePlan = (preserve = false) => {
        const source = selectedSource();
        const previous = preserve ? harness.value : source?.defaultMode || source?.modes?.[0];
        if (preserve && !source) {
          harness.disabled = true;
          return;
        }
        harness.replaceChildren();
        for (const id of source?.modes || []) {
          const entry = harnesses.find((h) => h.id === id);
          if (!entry) continue;
          const option = this.el('option', '', entry.label); option.value = id; harness.append(option);
        }
        if ([...harness.options].some((option) => option.value === previous)) harness.value = previous;
        harness.disabled = !harness.options.length;
      };
      plan.addEventListener('change', () => updatePlan(false)); updatePlan();
      const name = field('name', 'Name'); name.required = true; name.maxLength = 100;
      const pronouns = field('pronouns', 'Pronouns (optional)'); pronouns.maxLength = 24; pronouns.placeholder = 'e.g. they/them';
      const voice = this.expertVoiceFields(form, pronouns, name);
      const appearance = this.expertAppearanceFields(form, '', { name, random: true });
      const position = field('position', 'Role'); position.required = true; position.maxLength = 100;
      const expertise = field('expertise', 'Expertise'); expertise.required = true; expertise.placeholder = 'Code review, Security, Flight systems';
      const parent = field('reportsTo', 'Reports to', 'select');
      const owner = this.el('option', '', data.settings?.ownerName || 'Owner'); owner.value = 'owner'; parent.append(owner);
      for (const e of employees) { const option = this.el('option', '', e.name); option.value = e.id; parent.append(option); }
      const error = this.el('p', 'ca-company-error'); error.setAttribute('role', 'alert');
      const submit = this.el('button', 'ca-btn is-primary', 'Hire agent'); submit.type = 'submit';
      submit.disabled = plan.disabled;
      const actions = this.el('div', 'ca-company-actions'); actions.append(submit);
      const sourceHint = this.el('p', 'ca-hint', options.error || 'Add a subscription plan or local model profile in Settings first.');
      sourceHint.hidden = sources.some(source => source.modes?.length); actions.append(sourceHint);
      form.append(error, actions);
      let saving = false;
      let optionsGeneration = 0;
      refreshHireOptions = async () => {
        const generation = ++optionsGeneration;
        try {
          const refreshed = await this.app._chatApi('/api/company/hire-options');
          if (!refreshed.ok || generation !== optionsGeneration || this.companyPage !== dlg || !form.isConnected) return;
          const previous = plan.value;
          sources = Array.isArray(refreshed.data?.sources) ? refreshed.data.sources : [];
          harnesses = Array.isArray(refreshed.data?.harnesses) ? refreshed.data.harnesses : [];
          plan.replaceChildren(placeholder);
          for (const source of sources) {
            const option = this.el('option', '', `${source.label}${source.kind === 'local' ? ' · Local model' : ''}`);
            option.value = `${source.kind}:${source.id}`; option.disabled = !source.modes?.length;
            plan.append(option);
          }
          plan.value = sources.some(source => `${source.kind}:${source.id}` === previous) ? previous : '';
          plan.disabled = !sources.some(source => source.modes?.length);
          submit.disabled = saving || plan.disabled;
          sourceHint.hidden = !plan.disabled;
          updatePlan(true);
        } catch { /* Keep the current draft if the catalog refresh is unavailable. */ }
      };
      plan.addEventListener('focus', () => { void refreshHireOptions(); });
      form.addEventListener('submit', async ev => {
        ev.preventDefault(); if (saving || !form.reportValidity()) return;
        if (appearance.pending()) { error.textContent = 'Wait for the photo to finish loading.'; return; }
        const skills = expertise.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!skills.length) { error.textContent = 'Add at least one area of expertise.'; return; }
        saving = true; submit.disabled = true; error.textContent = '';
        const source = selectedSource();
        if (!source || !harness.value) { saving = false; submit.disabled = false; error.textContent = 'Choose a plan and a compatible harness.'; return; }
        const payload = { source: source.kind === 'local' ? { kind: 'local', endpointId: source.id } : { kind: 'subscription', profileId: source.id }, mode: harness.value, name: name.value.trim(), icon: this.expertInitial(name.value), ...(pronouns.value.trim() ? { pronouns: pronouns.value.trim() } : {}), ...(voice.value() ? { voice: voice.value() } : {}), position: position.value.trim(), expertise: skills, reportsTo: parent.value };
        try {
          const result = await this.app._chatApi('/api/company/hire', { method: 'POST', body: payload });
          if (!result.ok) { error.textContent = result.error || 'Could not hire this agent.'; return; }
          const sessionId = result.data?.sessionId || result.data?.employee?.sessionId;
          const photo = appearance.picture.value();
          const photoSaved = !photo || (typeof sessionId === 'string' && await this.saveEmployeePicture(sessionId, photo));
          await this.loadOwner();
          await paint();
          status.textContent = `Hired ${payload.name}.${photoSaved ? '' : ' The photo could not be saved. Use Edit profile to try again; the expert is already hired.'}`;
        } catch { error.textContent = 'Could not save. Check the company roster before trying again.'; }
        finally { saving = false; submit.disabled = false; }
      });
      section.append(form); content.append(section);
      head.querySelector('.ca-company-settings-button')?.remove();
      head.insertBefore(this.button('ca-btn ca-company-settings-button', 'Company settings', () => this.openCompanySettings(paint), { text: 'Company settings' }), head.lastElementChild);
    };
    try {
      await paint();
      if (this.companyPage !== dlg) return;
      this._companyTimer = this.doc.defaultView.setInterval(() => { void this._companyRefresh?.(); }, 60000);
    } catch { if (this.companyPage === dlg) status.textContent = 'Could not load company. Please reopen it to try again.'; }
  }

  async openCompanySettings(onSaved) {
    const existing = this.doc.querySelector('.ca-company-settings');
    if (existing) { existing.querySelector('button')?.focus(); return; }
    const dialog = this.el('dialog', 'ca-dialog ca-company-settings');
    dialog.setAttribute('aria-label', 'Company settings');
    const head = this.el('header', 'ca-company-settings-head');
    const close = this.button('ca-btn', 'Close company settings', () => dialog.close(), { text: 'Close' });
    head.append(this.el('h2', '', 'Company settings'), close);
    const status = this.el('p', 'ca-hint', 'Loading company settings…'); status.setAttribute('role', 'status');
    const error = this.el('p', 'ca-company-error'); error.setAttribute('role', 'alert');
    const content = this.el('div', 'ca-company-settings-content');
    dialog.append(head, status, error, content);
    dialog.addEventListener('close', () => dialog.remove());
    this.doc.body.append(dialog); dialog.showModal(); close.focus();
    try {
      const [response, auth] = await Promise.all([this.app._chatApi('/api/company'), this.app._chatApi('/api/chatrooms/phone-status')]);
      if (!dialog.isConnected) return;
      if (!response.ok) throw new Error(response.error || 'Company settings are unavailable.');
      const data = response.data || {};
      const manage = data.canManage === true && auth.ok && auth.data?.self === 'owner' && auth.data?.canSetOwn === true;
      status.textContent = '';
      if (manage) {
        const form = this.el('form', 'ca-company-settings-form');
        form.append(this.el('h3', '', 'Owner details'));
        const field = (label, value) => {
          const wrap = this.el('label', 'ca-label');
          const input = this.el('input', 'ca-field'); input.value = value || ''; input.maxLength = 100; input.setAttribute('aria-label', label);
          wrap.append(this.el('span', 'ca-label-text', label), input); form.append(wrap); return input;
        };
        const name = field('Owner display name', data.settings?.ownerName);
        const title = field('Owner title', data.settings?.ownerTitle);
        const save = this.el('button', 'ca-btn is-primary', 'Save owner details'); save.type = 'submit';
        const actions = this.el('div', 'ca-dialog-actions'); actions.append(save); form.append(actions);
        let saving = false;
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (saving) return;
          saving = true; save.disabled = true; error.textContent = ''; status.textContent = '';
          try {
            const fresh = await this.app._chatApi('/api/company');
            if (!fresh.ok || fresh.data?.canManage !== true || !fresh.data?.settings) throw new Error(fresh.error || 'Owner sign-in is required to save company settings.');
            const { owner: _owner, ownerAvatar: _avatar, ...settings } = fresh.data.settings;
            const saved = await this.app._chatApi('/api/company/settings', { method: 'PUT', body: { ...settings, ownerName: name.value.trim(), ownerTitle: title.value.trim() } });
            if (!saved.ok) throw new Error(saved.error || 'Company settings could not be saved.');
            status.textContent = 'Owner details saved.';
            await this.loadOwner(); await onSaved?.();
          } catch (failure) { error.textContent = failure.message || 'Company settings could not be saved. Try again.'; }
          finally { saving = false; save.disabled = false; }
        });
        content.append(form);
      } else content.append(this.el('p', 'ca-hint', 'Sign in as the owner to change company settings.'));
      const receipts = this.el('details', 'ca-company-settings-receipts');
      receipts.append(this.el('summary', '', 'Research receipts'));
      receipts.append(this.el('p', 'ca-hint', 'Existing agent reports and their evidence. Hypotheses are unverified.'));
      const reports = this.el('div', 'ca-company-settings-reports');
      const renderReports = company => {
        reports.replaceChildren();
        const cycles = Array.isArray(company.cycles) ? company.cycles : [];
        if (!cycles.length) reports.append(this.el('p', 'ca-hint', 'No research receipts yet.'));
        for (const cycle of [...cycles].reverse().slice(0, 50)) {
          const report = this.el('details');
          const employee = company.employees?.find(person => person.id === cycle.employeeId);
          report.append(this.literalText('summary', '', `${cycle.date || ''} · ${employee?.name || 'Expert'} · ${cycle.kind || 'Report'} · ${cycle.state || ''}`));
          if (cycle.error) report.append(this.literalText('p', '', cycle.error));
          if (cycle.result) {
            report.append(this.literalText('p', '', cycle.result.summary));
            for (const finding of cycle.result.findings || []) {
              report.append(this.literalText('p', '', `${finding.status === 'observed' ? 'Observed (agent reported)' : 'Hypothesis'}: ${finding.text}`));
              for (const evidence of finding.evidence || []) report.append(this.literalText('pre', '', evidence));
            }
          }
          reports.append(report);
        }
      };
      renderReports(data);
      const refresh = this.button('ca-btn', 'Refresh research receipts', async () => {
        if (refresh.disabled) return;
        refresh.disabled = true; error.textContent = '';
        try {
          const result = await this.app._chatApi('/api/company');
          if (!result.ok) throw new Error(result.error || 'Research receipts could not be refreshed.');
          renderReports(result.data || {}); status.textContent = 'Research receipts refreshed.';
        } catch (failure) { error.textContent = failure.message || 'Research receipts could not be refreshed.'; }
        finally { refresh.disabled = false; }
      }, { text: 'Refresh receipts' });
      receipts.append(reports, refresh); content.append(receipts);
    } catch (failure) { if (dialog.isConnected) { status.textContent = ''; error.textContent = failure.message || 'Company settings are unavailable.'; } }
  }

  confirmCompanyAction(name, message, confirmLabel) {
    if (this._companyConfirm) return Promise.resolve(false);
    return new Promise(resolve => {
      const dialog = this.el('dialog', 'ca-dialog ca-company-confirm');
      dialog.setAttribute('aria-label', `${confirmLabel}: ${name}`);
      dialog.append(this.literalText('h2', '', `${confirmLabel}?`), this.literalText('p', 'ca-dialog-note', message));
      const actions = this.el('div', 'ca-dialog-actions');
      const previousFocus = this.doc.activeElement;
      let settled = false;
      const finish = accepted => {
        if (settled) return;
        settled = true;
        if (this._companyConfirm === finish) this._companyConfirm = null;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus?.();
        resolve(accepted);
      };
      const cancel = this.button('ca-btn', 'Cancel', () => finish(false), { text: 'Cancel' });
      cancel.autofocus = true;
      const confirm = this.button('ca-btn is-primary', confirmLabel, () => finish(true), { text: confirmLabel });
      actions.append(cancel, confirm);
      dialog.append(actions);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      this._companyConfirm = finish;
      this.doc.body.append(dialog);
      try { dialog.showModal(); cancel.focus(); } catch { finish(false); }
    });
  }

  companyWorkEl(employee, board) {
    const work = this.el('section', 'ca-company-work-detail');
    work.setAttribute('aria-label', 'Current work and pace');
    if (!board || !Array.isArray(board.roster)) {
      work.append(this.el('p', 'ca-hint', 'Work status unavailable. Retrying in a minute.'));
      return work;
    }
    const person = board.roster.find(person => person.id === employee.id);
    const state = person?.state === 'running' ? 'Working' : person?.state === 'idle' ? 'Idle' : person?.state === 'gone' ? 'Down' : 'Unknown';
    const note = board.agents?.[employee.id];
    const pace = board.pace?.owners?.[employee.id];
    let timeZone = board.timeZone || 'UTC';
    let dateFormat;
    try { dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { timeZone = 'UTC'; dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    const now = Date.now();
    const clock = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
    const dayStart = now - ((Number(clock.hour) * 60 + Number(clock.minute)) * 60 + Number(clock.second)) * 1000;
    const issues = (board.issues || []).filter(issue => issue.owner === employee.id && issue.status !== 'wontdo' && Number.isFinite(issue.end));
    const today = issues.filter(issue => dateFormat.format(issue.end) === dateFormat.format(now));
    const completed = today.filter(issue => issue.status === 'done').length;
    const upcoming = issues.filter(issue => issue.end >= dayStart - 86400000 && issue.end < dayStart + 14 * 86400000);
    if (!issues.length && !note?.focus && !note?.receipts?.length) {
      work.append(this.el('span', 'ca-company-live-state', state), this.el('span', 'ca-hint', 'No active work.'));
      return work;
    }
    const ring = this.el('div', 'ca-company-ring', today.length ? `${completed}/${today.length}` : '–');
    ring.setAttribute('role', 'img');
    ring.setAttribute('aria-label', `Today: ${completed} of ${today.length} planned issues done`);
    ring.style.setProperty('--company-done', String(today.length ? completed / today.length * 100 : 0));
    const detail = this.el('div', 'ca-company-work-summary');
    detail.append(this.el('span', 'ca-company-live-state', state));
    if (pace) detail.append(this.el('span', 'ca-company-pace', ({ ahead: 'Ahead', 'on-track': 'On track', behind: 'Behind' })[pace.verdict] || 'Pace unavailable'));
    detail.append(this.literalText('p', 'ca-company-focus', note?.focus || 'No current focus recorded.'));
    detail.append(this.el('p', 'ca-company-counts', `${pace ? pace.overdue : '–'} overdue${pace?.overdue ? ` (${Math.round(pace.overdueHours)}h)` : ''} · ${pace ? pace.early : '–'} early · ${upcoming.filter(issue => issue.status === 'done').length}/${upcoming.length} 2-wk items`));
    if (Array.isArray(note?.receipts) && note.receipts.length) {
      const receipts = this.el('ul', 'ca-company-receipts');
      for (const receipt of note.receipts) receipts.append(this.literalText('li', '', receipt));
      detail.append(receipts);
    }
    work.append(ring, detail);
    return work;
  }

  disposeCompanyPage() {
    this._companyConfirm?.(false);
    if (this._companyTimer) this.doc.defaultView.clearInterval(this._companyTimer);
    if (this._companyResize) this.doc.defaultView.removeEventListener('message', this._companyResize);
    this._companyResize = null;
    this._companyTimer = null;
    this._companySection = null;
    this._companyRefresh = null;
    this.companyPage?.remove();
    this.companyPage = null;
  }

  /* ── org chart ── */

  /** The reporting chart from /api/company, in a panel over the conversation. */
  async openOrg() {
    if (this.orgOpen) return this.closeOrg();
    this.toggleDrawer(null);
    this.orgOpen = true;
    let panel = this.els.org;
    if (!panel) {
      panel = this.el('section', 'ca-org');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Org chart');
      const head = this.el('header', 'ca-org-head');
      head.append(this.el('h2', '', 'Org chart'), this.el('span', 'ca-spacer'), this.button('ca-icon-btn ca-org-close', 'Close org chart', () => this.closeOrg(), { text: '\u2715' }));
      panel.append(head, this.el('div', 'ca-org-body'));
      panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.closeOrg();
        }
      });
      this.els.main.append(panel);
      this.els.org = panel;
    }
    panel.hidden = false;
    const body = panel.querySelector('.ca-org-body');
    body.replaceChildren(this.el('p', 'ca-org-note', 'Loading\u2026'));
    this.els.orgBtn?.setAttribute('aria-pressed', 'true');
    panel.querySelector('.ca-org-close')?.focus();
    const res = await this.app._chatApi('/api/company');
    if (!this.orgOpen) return;
    if (!res.ok) {
      body.replaceChildren(this.el('p', 'ca-org-note', `Could not load the org chart: ${res.error}`));
      return;
    }
    body.replaceChildren(this.orgTreeEl(caOrgTree(res.data, caConnectedSessionIds(this.app.sessions))));
  }

  /** Remove the profiles of agents that are gone (asks first), then draw the chart again. */
  async pruneFormerWorkers(count) {
    if (!this.doc.defaultView?.confirm(`Remove up to ${count} old profile${count === 1 ? '' : 's'} of agents that are gone? Running agents and pinned (paused) agents are not touched.`)) return;
    const res = await this.app._chatApi('/api/company/temporary/prune', { method: 'POST', body: {} });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    this.toast(`Removed ${res.data?.removed ?? 0} old profile${res.data?.removed === 1 ? '' : 's'}`, 'info');
    const fresh = await this.app._chatApi('/api/company');
    const body = this.els.org?.querySelector('.ca-org-body');
    if (fresh.ok && body && this.orgOpen) body.replaceChildren(this.orgTreeEl(caOrgTree(fresh.data, caConnectedSessionIds(this.app.sessions))));
  }

  closeOrg() {
    if (!this.orgOpen) return;
    this.orgOpen = false;
    if (this.els.org) this.els.org.hidden = true;
    this.els.orgBtn?.setAttribute('aria-pressed', 'false');
    this.doc.querySelector('.ca-company-nav')?.focus();
  }

  /* ── Board and Plans pages ── */

  /** The Board and Plans entries pinned above the list: pages, not rooms, so they take no part in the sort or the reordering. */
  pagesEl() {
    const box = this.el('div', 'ca-pages');
    const company = this.el('button', 'ca-item ca-item--page ca-company-nav');
    if (this.embed?.startsWith('company')) { company.classList.add('is-active'); company.setAttribute('aria-current', 'page'); }
    company.type = 'button'; company.setAttribute('aria-label', 'Company');
    const mark = this.el('span', 'ca-hash is-drawn'); mark.setAttribute('aria-hidden', 'true'); mark.append(this.icon('org'));
    company.append(mark, this.el('span', 'ca-name', 'Company'));
    company.addEventListener('click', () => this.openCompany()); box.append(company);
    for (const [kind, page] of Object.entries(CA_PAGES)) {
      if (page.nav === false) continue; // Embassies has one home: its sidebar section.
      const on = this.embed === kind;
      const b = this.el('button', `ca-item ca-item--page${on ? ' is-active' : ''}`);
      b.type = 'button';
      b.dataset.key = `page:${kind}`;
      b.setAttribute('aria-label', page.label);
      if (on) b.setAttribute('aria-current', 'page');
      const mark = this.el('span', 'ca-hash is-drawn');
      mark.setAttribute('aria-hidden', 'true');
      mark.append(this.icon(page.icon));
      b.append(mark, this.el('span', 'ca-name', page.label));
      b.addEventListener('click', () => this.openPage(kind));
      box.append(b);
    }
    return box;
  }

  /** Show the console's own Board page in place of the conversation (the same page, in a frame). */
  openPage(kind, { push = true } = {}) {
    const page = CA_PAGES[kind];
    if (!page) return;
    if (kind === 'company' || kind === 'company-plans' || kind === 'company-people') {
      void this.openCompany(kind === 'company-people' ? 'people' : 'plans', { push });
      return;
    }
    this.disposeCompanyPage();
    this.embassy?.close();
    if (this.orgOpen) this.closeOrg();
    this.toggleDrawer(null);
    const again = this.embed === kind;
    this.embed = kind;
    this._embedRoom = this.roomId;
    let panel = this.els.page;
    if (!panel) {
      panel = this.el('section', 'ca-page');
      panel.append(this.el('iframe', 'ca-page-frame'));
      this.els.body.append(panel);
      this.els.page = panel;
    }
    let frame = panel.querySelector('iframe');
    if (kind === 'embassies') {
      panel.replaceChildren(this.embassy.directoryEl());
      panel.dataset.kind = kind;
    } else {
    if (!frame) { frame = this.el('iframe', 'ca-page-frame'); panel.replaceChildren(frame); }
    frame.title = page.label;
    if (panel.dataset.kind !== kind) {
      panel.dataset.kind = kind;
      frame.src = page.path;
    } else if (again) {
      try {
        frame.contentWindow.location.reload();
      } catch {
        /* a frame that is not loaded yet has nothing to reload */
      }
    }
    }
    panel.hidden = false;
    this.els.root.classList.add('is-page');
    // The conversation stays where it was but is out of reach of the keyboard and screen readers while the page covers it.
    this.els.chat.inert = true;
    this.els.members.inert = true;
    const win = this.doc.defaultView;
    if (push && win && caPageFromHash(win.location.hash) !== kind) {
      try {
        win.history.pushState({ reveriePage: kind }, '', `#${kind}`);
      } catch {
        /* the address bar is a convenience */
      }
    }
    this.renderSidebar();
    this.renderHeader();
  }

  /** Back to the conversation. `history: 'replace'` also takes #board out of the address bar. */
  closePage({ history = 'replace' } = {}) {
    if (!this.embed) return;
    this.disposeCompanyPage();
    this.embed = null;
    this._embedRoom = null;
    const panel = this.els.page;
    if (panel) {
      panel.hidden = true;
      delete panel.dataset.kind;
      const frame = panel.querySelector('iframe'); if (frame) frame.src = 'about:blank';
    }
    this.els.root.classList.remove('is-page');
    this.els.chat.inert = false;
    this.els.members.inert = false;
    const win = this.doc.defaultView;
    if (history === 'replace' && win && caPageFromHash(win.location.hash)) {
      try {
        win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search);
      } catch {
        /* the address bar is a convenience */
      }
    }
    this.renderSidebar();
    this.renderHeader();
  }

  orgTreeEl(tree) {
    const canMessage = (n) => this.serverFeatures.dms && n.sessionId && this.app.sessions?.has?.(n.sessionId);
    const walk = (node) => {
      if (node.kind === 'former') return former(node);
      const item = this.el('li', `ca-org-item ca-org-item--${node.kind}`);
      const message = canMessage(node);
      const label = this.el(message ? 'button' : 'div', 'ca-org-node');
      if (message) {
        label.type = 'button';
        label.title = `Message ${node.name}`;
        label.addEventListener('click', () => {
          this.closeOrg();
          this.startDm(node.sessionId);
        });
      }
      if (node.icon) label.append(this.el('span', 'ca-org-icon', node.icon));
      label.append(this.literalText('strong', '', node.name));
      if (node.title) label.append(this.literalText('span', 'ca-org-title', node.title));
      if (node.kind !== 'owner' && node.available === false) label.append(this.el('span', 'ca-org-title', 'disconnected'));
      item.append(label);
      if (node.children.length) {
        const sub = this.el('ul', 'ca-org-list');
        for (const child of node.children) sub.append(walk(child));
        item.append(sub);
      }
      return item;
    };
    // The profiles of gone agents: folded away, with one button to clean them up.
    const former = (node) => {
      const item = this.el('li', 'ca-org-item ca-org-item--former');
      const details = this.el('details', 'ca-org-former');
      details.append(this.el('summary', 'ca-org-node', `Former workers (${node.children.length})`));
      const clean = this.el('button', 'ca-btn ca-org-clean', `Remove ${node.children.length} old profile${node.children.length === 1 ? '' : 's'}`);
      clean.type = 'button';
      clean.addEventListener('click', () => this.pruneFormerWorkers(node.children.length));
      const sub = this.el('ul', 'ca-org-list');
      for (const child of node.children) sub.append(walk(child));
      details.append(clean, sub);
      item.append(details);
      return item;
    };
    const list = this.el('ul', 'ca-org-list ca-org-list--root');
    list.setAttribute('aria-label', 'Organization');
    list.append(walk(tree));
    return list;
  }

  /* ── composer ── */

  composerPlaceholder() {
    if (this.embassy?.selected) return `Message #${this.embassy.connection()?.roomName || 'shared room'}`;
    const room = this.room;
    return !room || this.app._chatCreating ? 'Message' : caIsDm(room) ? `Message @${caRoomLabel(room)}` : `Message #${room.name}`;
  }

  /**
   * Discord's message box: "+" (upload) on the left, then the box and the emoji
   * button. There is no "To" menu: the channel decides who reads a message. The mic exists in voice channels only.
   */
  installComposerChrome() {
    const els = this.app._chatEls;
    const { input, clip, send, to } = els;
    if (clip) {
      clip.textContent = '+';
      clip.classList.add('ca-plus');
      clip.title = 'Add to the message';
      clip.setAttribute('aria-label', 'Add to the message');
      clip.setAttribute('aria-haspopup', 'menu');
      // Discord's "+" menu: Upload a File, Create Poll, and the two things that do not exist yet.
      clip.onclick = (e) => {
        e.stopPropagation();
        this.openPlusMenu(clip);
      };
    }
    to.hidden = true;
    to.value = '';
    // The send button shows once there is something to send (always on a touch screen, which has no Enter key).
    const sync = () => send.classList.toggle('has-text', input.value.trim() !== '' || (this.app._chatPending?.length ?? 0) > 0);
    input.addEventListener('input', sync);
    send.setAttribute('aria-label', 'Send message');
    this.syncComposer = () => {
      sync();
      input.placeholder = this.composerPlaceholder();
    };
    this.syncComposer();
  }

  /* ── replies ── */

  /** The compact hover toolbar: quick reactions, add a reaction, reply, more. */
  actionsEl(m) {
    const actions = this.el('div', 'ca-msg-actions');
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', 'Message actions');
    const tool = (label, glyph, onClick, extra = '') => {
      const b = this.button(`ca-act${extra}`, label, onClick, { text: glyph });
      b.title = label;
      return b;
    };
    const react = this.app._toggleChatReaction ? (emoji) => this.app._toggleChatReaction(m, emoji, true) : null;
    if (react) {
      for (const emoji of CA_QUICK_REACTIONS) actions.append(tool(`React with ${emoji}`, emoji, () => react(emoji)));
      actions.append(this.el('span', 'ca-act-sep'));
      const add = tool('Add reaction', '\u263A', () => this.app._openEmojiPicker?.(add, (pick) => react(pick)));
      actions.append(add);
    }
    actions.append(tool('Reply', '\u21A9', () => this.startReply(m), ' ca-act-reply'));
    const more = tool('More', '\u22EF', () => this.openMessageMenu(m, more));
    actions.append(more);
    return actions;
  }

  /** What can be done to a message. The phone's sheet adds quick reactions on top. */
  messageEntries(m, { sheet = false } = {}) {
    const out = [];
    const room = this.room;
    const react = this.app._toggleChatReaction ? (emoji) => this.app._toggleChatReaction(m, emoji, true) : null;
    if (sheet && react) {
      out.push({ row: CA_SHEET_REACTIONS.map((emoji) => ({ label: `React with ${emoji}`, glyph: emoji, run: () => react(emoji) })) });
      out.push({ label: 'Add reaction', run: () => this.app._openEmojiPicker?.(this.els.composerInput?.() || this.doc.body, (pick) => react(pick)) });
    }
    out.push({ label: 'Reply', run: () => this.startReply(m) });
    if (m.text) {
      out.push({
        label: 'Copy text',
        run: async () => {
          try {
            await this.doc.defaultView?.navigator?.clipboard?.writeText(m.text);
            this.toast('Copied', 'info');
          } catch {
            this.toast('Could not copy', 'error');
          }
        },
      });
    }
    if (m.text && sheet) {
      // A touch screen turns selection off on messages (a long press opens this sheet): this turns it on for one.
      out.push({ label: 'Select text', run: () => this.startSelectMode(m.id) });
    }
    if (this.serverFeatures.edits && m.from.kind === 'user' && m.text && !m.poll && !m.deleted) {
      out.push({ label: 'Edit message', run: () => this.startEdit(m) });
    }
    if (this.serverFeatures.pins && room && !caIsDm(room) && m.from.kind !== 'system' && !m.deleted) {
      out.push({ label: m.pinned ? 'Unpin message' : 'Pin message', run: () => this.setPinned(m, !m.pinned) });
    }
    const lead = room?.members.find((x) => x.sessionId === room?.coordinatorId);
    const reportable = lead && m.from.kind === 'agent' && m.from.sessionId !== lead.sessionId && !caIsDm(room);
    if (this.serverFeatures.deletes || reportable) out.push({ sep: true });
    if (this.serverFeatures.deletes) out.push({ label: 'Delete message', danger: true, run: () => this.deleteMessage(m) });
    if (reportable) out.push({ label: 'Report message', danger: true, run: () => this.openReportDialog(m, lead) });
    return out;
  }

  // Leaves the sheet closed so the native selection handles stay usable; a tap outside the message ends select mode.
  startSelectMode(id) {
    const el = this.msgEl(id);
    if (!el) return;
    el.classList.add('is-selectable');
    const end = (ev) => {
      if (ev.target?.closest?.('.ca-msg') === el) return;
      el.classList.remove('is-selectable');
      this.doc.removeEventListener('pointerdown', end, true);
    };
    this.doc.defaultView?.setTimeout(() => this.doc.addEventListener('pointerdown', end, true), 0);
  }

  wireMessageMenu(el, m) {
    el.addEventListener('contextmenu', (ev) => {
      if (ev.target?.closest?.('a, button, input, textarea')) return;
      if (el.classList.contains('is-selectable')) return;
      ev.preventDefault();
      this.openMessageMenu(m, el, { at: { x: ev.clientX || el.getBoundingClientRect().left + 24, y: ev.clientY || el.getBoundingClientRect().top + 24 }, sheet: true });
    });
    let timer = 0;
    let start = null;
    const stop = () => {
      this.doc.defaultView?.clearTimeout(timer);
      timer = 0;
    };
    el.addEventListener('touchstart', (ev) => {
      if (ev.target?.closest?.('a, button, input, textarea')) return;
      // In select mode the long press belongs to the native selection handles, not the sheet.
      if (el.classList.contains('is-selectable')) return;
      const t = ev.touches?.[0];
      start = t ? { x: t.clientX, y: t.clientY } : null;
      timer = this.doc.defaultView?.setTimeout(() => {
        timer = 0;
        this.openMessageMenu(m, el, { at: { x: start?.x || 24, y: start?.y || 24 }, sheet: true });
      }, 450);
    }, { passive: true });
    el.addEventListener('touchmove', (ev) => {
      const t = ev.touches?.[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) stop();
    }, { passive: true });
    for (const name of ['touchend', 'touchcancel']) el.addEventListener(name, stop, { passive: true });
  }

  /** The "More" button's menu (or, with `at`, the right-click / long-press sheet) for one message. */
  openMessageMenu(m, trigger, { at, sheet = false } = {}) {
    this.openMenu(this.messageEntries(m, { sheet }), {
      at: at || trigger,
      focus: trigger,
      right: !at,
      className: 'ca-msg-menu',
      label: 'Message actions',
    });
  }

  /** The message box's "+" menu. Create Thread and Use Apps are listed but off until they exist. */
  openPlusMenu(trigger) {
    const room = this.room;
    const picker = this.app._chatEls?.composer?.querySelector('input[type="file"]');
    const canPoll = !!room && !room.archivedAt && this.serverFeatures.polls !== false;
    this.openMenu(
      [
        { label: 'Upload a File', glyph: '\u2B06', run: () => picker?.click() },
        { label: 'Create Thread', glyph: '\u2630', disabled: true, hint: 'Soon' },
        { label: 'Create Poll', glyph: '\u2261', disabled: !canPoll, run: () => this.openPollDialog() },
        { label: 'Use Apps', glyph: '\u2726', disabled: true, hint: 'Soon' },
      ],
      { at: trigger, focus: trigger, above: true, className: 'ca-plus-menu', label: 'Add to the message' }
    );
  }

  /**
   * Create Poll: a question, 2 to 10 options, one or several answers, and how long it stays open. The owner asks it here;
   * agents ask with `reverie agent chat poll`.
   */
  openPollDialog() {
    if (!this.room) return;
    this.doc.querySelector('.ca-dialog.ca-poll-dialog')?.remove();
    const roomId = this.roomId;
    const dlg = this.el('dialog', 'ca-dialog ca-poll-dialog');
    dlg.setAttribute('aria-label', 'Create a poll');
    dlg.append(this.el('h2', '', 'Create a poll'));
    const form = this.el('form', 'ca-form');
    const qWrap = this.el('label', 'ca-label');
    qWrap.append(this.el('span', '', 'Question'));
    const question = this.el('input', 'ca-field');
    question.maxLength = 300;
    question.required = true;
    question.placeholder = 'What do you want to ask?';
    qWrap.append(question);
    const oWrap = this.el('div', 'ca-label ca-poll-form-options');
    oWrap.append(this.el('span', '', 'Options (2 to 10)'));
    const list = this.el('div', 'ca-poll-form-list');
    oWrap.append(list);
    const add = this.el('button', 'ca-btn ca-poll-add', '+ Add option');
    add.type = 'button';
    oWrap.append(add);
    const inputs = [];
    // The optional recommendation: one of the options typed above ("rec" tag on the card).
    const recWrap = this.el('label', 'ca-label ca-poll-rec-pick');
    recWrap.append(this.el('span', '', 'Your recommendation (optional)'));
    const recSelect = this.el('select', 'ca-field');
    const syncRec = () => {
      const keep = recSelect.value;
      recSelect.replaceChildren();
      const none = this.el('option', '', 'No recommendation');
      none.value = '';
      recSelect.append(none);
      const labels = inputs.map((x) => x.input.value.trim().replace(/\s+/g, ' ')).filter(Boolean);
      for (const label of labels) {
        const o = this.el('option', '', label);
        o.value = label;
        recSelect.append(o);
      }
      recSelect.value = labels.includes(keep) ? keep : '';
    };
    recWrap.append(recSelect);
    const sync = () => {
      syncRec();
      inputs.forEach((row, i) => {
        row.input.setAttribute('aria-label', `Option ${i + 1}`);
        row.input.placeholder = `Option ${i + 1}`;
        row.remove.hidden = inputs.length <= 2;
        row.remove.setAttribute('aria-label', `Remove option ${i + 1}`);
      });
      add.hidden = inputs.length >= 10;
    };
    const addOption = (focus) => {
      const row = this.el('div', 'ca-poll-form-row');
      const input = this.el('input', 'ca-field');
      input.maxLength = 100;
      const remove = this.el('button', 'ca-btn ca-poll-remove', '\u00D7');
      remove.type = 'button';
      const entry = { row, input, remove };
      remove.addEventListener('click', () => {
        const at = inputs.indexOf(entry);
        inputs.splice(at, 1);
        row.remove();
        sync();
        (inputs[Math.min(at, inputs.length - 1)]?.input || add).focus();
      });
      input.addEventListener('keydown', (e) => {
        // Enter adds the next option (on the last one); it never submits half a poll.
        if (e.key === 'Enter') {
          e.preventDefault();
          const at = inputs.indexOf(entry);
          if (at === inputs.length - 1 && inputs.length < 10) addOption(true);
          else inputs[at + 1]?.input.focus();
        }
      });
      input.addEventListener('input', syncRec);
      row.append(input, remove);
      list.append(row);
      inputs.push(entry);
      sync();
      if (focus) input.focus();
    };
    add.addEventListener('click', () => addOption(true));
    addOption(false);
    addOption(false);
    const multiWrap = this.el('label', 'ca-label ca-poll-multi');
    const multi = this.el('input');
    multi.type = 'checkbox';
    multiWrap.append(multi, this.el('span', '', 'Allow multiple answers'));
    const durWrap = this.el('label', 'ca-label');
    durWrap.append(this.el('span', '', 'Duration'));
    const duration = this.el('select', 'ca-field ca-poll-duration');
    for (const [label, hours] of [['1 hour', 1], ['4 hours', 4], ['8 hours', 8], ['24 hours', 24], ['3 days', 72], ['1 week', 168], ['No limit', 0]]) {
      const o = this.el('option', '', label);
      o.value = String(hours);
      duration.append(o);
    }
    duration.value = '24';
    durWrap.append(duration);
    const error = this.el('p', 'ca-form-error');
    error.setAttribute('role', 'alert');
    const row = this.el('div', 'ca-dialog-actions');
    const cancel = this.el('button', 'ca-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const go = this.el('button', 'ca-btn is-primary', 'Post');
    go.type = 'submit';
    row.append(cancel, go);
    form.append(qWrap, oWrap, recWrap, multiWrap, durWrap, error, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = question.value.trim().replace(/\s+/g, ' ');
      const labels = inputs.map((x) => x.input.value.trim().replace(/\s+/g, ' ')).filter(Boolean);
      if (!q) return void (error.textContent = 'Write a question.');
      if (labels.length < 2) return void (error.textContent = 'Give at least two options.');
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) return void (error.textContent = 'Two options are the same.');
      const hours = Number(duration.value);
      go.disabled = true;
      const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/polls`, {
        method: 'POST',
        body: { question: q, options: labels, ...(recSelect.value ? { recommended: recSelect.value } : {}), ...(multi.checked ? { multi: true } : {}), ...(hours ? { closesAt: Date.now() + hours * 3600_000 } : {}) },
      });
      go.disabled = false;
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      dlg.close();
      this.els.composerInput()?.focus?.();
    });
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    question.focus();
  }

  /** The reply bar over the message box ("Replying to X", with a way out). */
  installReply() {
    const input = this.app._chatEls.input;
    const bar = this.el('div', 'ca-reply-bar');
    bar.hidden = true;
    this.els.replyBar = bar;
    input.parentNode.insertBefore(bar, input.parentNode.firstChild);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.replyTo && !e.defaultPrevented) {
        e.preventDefault();
        this.cancelReply();
      }
    });
    this.replyTo = null;
  }

  // ─── "<name> is typing…" ────────────────────────────────────────────────────────────────────────────────────────

  /** The typing line over the message box. */
  installTyping() {
    const composer = this.app._chatEls.composer;
    const bar = this.el('div', 'ca-typing');
    bar.hidden = true;
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    this.els.typing = bar;
    this.turns = new Map();
    composer.parentNode.insertBefore(bar, composer);
  }

  /**
   * A message woke a member in a room (the server's `chatroom:turn`): it is thinking there until its turn ends (it was busy and is
   * no longer), it posts in that room, or a safety timeout passes (it never started, or the end was missed).
   */
  noteTurn(data) {
    if (!this.built || !data?.roomId || !data?.sessionId) return;
    const key = `${data.roomId}|${data.sessionId}`;
    this.dropTurn(key);
    const entry = { roomId: data.roomId, sessionId: data.sessionId, at: Date.now(), busy: false, timers: [] };
    const view = this.doc.defaultView;
    // Safety nets, not polling: one check when it should have started, one when it should long be over.
    for (const ms of [CA_TURN_START_MS, CA_TURN_MAX_MS]) entry.timers.push(view.setTimeout(() => this.syncTurns(), ms + 50));
    this.turns.set(key, entry);
    this.syncTurns();
    this.renderTyping();
  }

  dropTurn(key) {
    const entry = this.turns?.get(key);
    if (!entry) return false;
    for (const t of entry.timers) this.doc.defaultView.clearTimeout(t);
    this.turns.delete(key);
    return true;
  }

  /** Keep each thinking member only while its turn is plausibly running; true when something changed. */
  syncTurns() {
    if (!this.turns?.size) return false;
    const now = Date.now();
    let changed = false;
    for (const [key, t] of [...this.turns]) {
      const member = this.rooms.find((r) => r.id === t.roomId)?.members?.find((m) => m.sessionId === t.sessionId);
      const state = member ? this.presenceOf(member) : 'gone';
      if (state === 'working') t.busy = true;
      const over = state === 'gone' || (t.busy && state !== 'working') || now - t.at > CA_TURN_MAX_MS || (!t.busy && now - t.at > CA_TURN_START_MS);
      if (over) changed = this.dropTurn(key) || changed;
    }
    if (changed) this.renderTyping();
    return changed;
  }

  renderTyping() {
    const bar = this.els.typing;
    if (!bar) return;
    const names = [...(this.turns?.values() || [])]
      .filter((t) => !this.embassy?.selected && t.roomId === this.roomId)
      .map((t) => this.room?.members?.find((m) => m.sessionId === t.sessionId)?.name)
      .filter(Boolean);
    bar.replaceChildren();
    bar.hidden = names.length === 0;
    if (!names.length) return;
    const dots = this.el('span', 'ca-typing-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(this.el('i'), this.el('i'), this.el('i'));
    bar.append(dots, this.el('span', 'ca-typing-text', caTypingText(names)));
  }

  /** The message being answered in the open room, or null (a reply never follows you to another room). */
  replyTarget() {
    const r = this.replyTo;
    if (!r || r.roomId !== this.roomId || !this.serverFeatures.replies) return null;
    return r;
  }

  startReply(m) {
    if (!this.serverFeatures.replies || !m || m.deleted || m.from.kind === 'system') return;
    this.replyTo = { id: m.id, roomId: this.roomId, from: m.from, text: m.text || '' };
    this.renderReplyBar();
    this.els.composerInput()?.focus?.();
  }

  cancelReplySilently() {
    this.replyTo = null;
    this.renderReplyBar();
  }

  cancelReply() {
    this.replyTo = null;
    this.renderReplyBar();
    this.els.composerInput()?.focus?.();
  }

  authorOf(from) {
    return from.kind === 'user' ? this.userName() : caEmployeeForSender(this.company, from)?.name || from.name;
  }

  /* ── your profile (kept in this browser) ── */

  get profile() {
    return caProfile(caRead('local', 'reverie:chat:profile', ''));
  }

  /** The src of an icon that is an image (see caIconImage), through the page's base path. */
  iconImage(icon) {
    return caIconImage(icon, (p) => this.doc.defaultView?.ReverieBase?.url?.(p) ?? p);
  }

  /** Draw an image icon into an avatar element, replacing its letter or emoji. Returns whether it was an image. */
  fillAvatar(el, icon) {
    const src = this.iconImage(icon);
    if (!src) return false;
    const img = this.el('img', 'chatroom-avatar-img');
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    const glyph = el.querySelector('.chatroom-avatar-glyph');
    // A picture that fails to load (a 404 for a stored avatar) puts the emoji or letter back.
    img.addEventListener('error', () => {
      el.classList.remove('has-image');
      if (glyph) {
        img.replaceWith(glyph);
      } else img.remove();
    });
    el.classList.add('has-icon', 'has-image');
    glyph?.replaceWith(img);
    return true;
  }

  /**
   * A picked picture, shrunk to a small square data URL (128 px, webp or png; smaller and jpeg if it is still big) so it is cheap to
   * store and send. Rejects anything that is not a png, jpeg, webp or gif, or is over 8 MB.
   */
  async imageToIcon(file) {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Pick a png, jpeg, webp or gif picture');
    if (file.size > 8 * 1024 * 1024) throw new Error('That picture is over 8 MB');
    const w = this.doc.defaultView;
    const bitmap = await w.createImageBitmap(file);
    const draw = (px, type, q) => {
      const canvas = this.doc.createElement('canvas');
      canvas.width = canvas.height = px;
      const ctx = canvas.getContext('2d');
      const side = Math.min(bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
      return canvas.toDataURL(type, q);
    };
    let url = draw(128, 'image/webp', 0.85);
    if (!url.startsWith('data:image/webp')) url = draw(128, 'image/png');
    if (url.length > 100000) url = draw(96, 'image/jpeg', 0.8);
    if (!caIconImage(url)) throw new Error('That picture could not be used');
    return url;
  }

  userName() {
    return this.profile.name || this.ownerName || this.doc.defaultView?.__reverieUser?.username || 'You';
  }

  /** Your avatar: the chosen emoji (or initial) on the chosen colour. */
  userAvatar(size = 'md', state) {
    const p = this.profile;
    // Your picture comes from the server (everyone sees it); this browser's own copy is the fallback.
    const image = this.ownerAvatar || p.image;
    const name = this.userName();
    const el = this.el('span', `chatroom-avatar chatroom-avatar--${size}${p.icon || image ? ' has-icon' : ''}`);
    el.style.setProperty('--chat-hue', String(p.hue ?? this.app._chatHue?.(name) ?? 200));
    el.setAttribute('aria-hidden', 'true');
    el.append(this.el('span', 'chatroom-avatar-glyph', p.icon || this.app._chatInitial?.(name) || '?'));
    if (image) this.fillAvatar(el, image);
    if (state) el.append(this.el('span', `chatroom-dot chatroom-dot--${state}`));
    return el;
  }

  /** The avatar of a message author: you, or an agent. */
  avatarFor(from, name, opts) {
    const employee = caEmployeeForSender(this.company, from);
    if (employee) {
      const el = this.app._chatAvatar(undefined, name, opts);
      el.style.setProperty('--chat-hue', String(this.app._chatHue(employee.id)));
      const member = employee.sessionId ? this.app._chatMember?.(employee.sessionId) : undefined;
      const profileIcon = typeof employee.icon === 'string' ? employee.icon.trim() : '';
      const icon = profileIcon && (caIconImage(profileIcon) || Array.from(profileIcon).length <= 4) ? profileIcon : member?.icon || '';
      const glyph = el.querySelector('.chatroom-avatar-glyph');
      if (icon && Array.from(icon).length <= 4 && glyph) {
        el.classList.add('has-icon');
        glyph.textContent = icon;
      }
      const avatar = caIconImage(employee.avatar) ? employee.avatar : caIconImage(member?.avatar) ? member.avatar : '';
      this.fillAvatar(el, avatar || icon);
      return el;
    }
    if (from.kind === 'bot') {
      const el = this.app._chatAvatar(undefined, name, opts);
      // A bot has no session to look an icon up by: its own icon, when it has one, stands in for the initial.
      if (from.icon) el.querySelector('.chatroom-avatar-glyph')?.replaceChildren(from.icon);
      return el;
    }
    return from.kind === 'user' ? this.userAvatar(opts?.size, opts?.state) : this.app._chatAvatar(from.sessionId, name, opts);
  }

  authorHue(from, name) {
    if (from.kind === 'user') return this.profile.hue ?? this.app._chatHue(name);
    const employee = caEmployeeForSender(this.company, from);
    if (employee) return this.app._chatHue(employee.id);
    return from.sessionId ? this.app._chatAccent(from.sessionId) : this.app._chatHue(name);
  }

  /** Put the owner's picture on the server (a data URL from the picker) or clear it (''). True when the server has it (or has none). */
  async saveOwnerPicture(image) {
    try {
      let init = { method: 'DELETE' };
      if (image) {
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
        if (!m) return false;
        const bin = this.doc.defaultView.atob(m[2]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        init = { method: 'POST', headers: { 'Content-Type': m[1] }, body: bytes };
      }
      const res = await this.doc.defaultView.fetch('/api/company/owner/avatar', init);
      if (!res.ok) return false;
      await this.loadOwner();
      return true;
    } catch {
      return false;
    }
  }

  saveProfile(p) {
    const clean = caProfile(p);
    const empty = !clean.name && !clean.pronouns && !clean.status && !clean.icon && !clean.image && clean.hue === null;
    caWrite('local', 'reverie:chat:profile', empty ? null : JSON.stringify(clean));
    this.renderUser();
    this.renderFeed();
    this.renderReplyBar();
  }

  renderReplyBar() {
    const bar = this.els.replyBar;
    if (!bar) return;
    const r = this.replyTarget();
    bar.hidden = !r;
    bar.replaceChildren();
    for (const n of this.app._chatEls.feed.querySelectorAll('.ca-msg.is-replying')) n.classList.remove('is-replying');
    if (!r) return;
    const label = this.el('span', 'ca-reply-label');
    const who = this.el('strong', 'ca-reply-who', this.authorOf(r.from));
    who.style.setProperty('--chat-hue', String(this.authorHue(r.from, this.authorOf(r.from))));
    label.append('Replying to ', who);
    bar.append(label, this.el('span', 'ca-spacer'));
    bar.append(this.button('ca-icon-btn ca-reply-close', 'Cancel reply', () => this.cancelReply(), { text: '\u2715' }));
    this.app._chatEls.feed.querySelector(`[data-msg-id="${CSS.escape(r.id)}"]`)?.classList.add('is-replying');
  }

  async deleteMessage(m) {
    if (!this.doc.defaultView?.confirm(`Delete this message from ${this.authorOf(m.from)}? It is hidden for everyone in the channel and kept in an audit log, where you can restore it. Agents that already received it still have it.`)) return;
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    if (this.replyTo?.id === m.id) this.cancelReplySilently();
    await this.app._loadChatRoom(this.roomId, { quiet: true });
    this.renderAll();
    this.renderFeed();
  }

  /** Report a message to the room's lead (its admin, the coordinator); the user, who sends it, has it in the room too. */
  openReportDialog(m, lead) {
    this.doc.querySelector('.ca-dialog.ca-report')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-report');
    dlg.setAttribute('aria-label', 'Report message');
    dlg.append(this.el('h2', '', 'Report message'));
    dlg.append(this.el('p', 'ca-dialog-note', `${this.authorOf(m.from)}: ${caSnippet(m.text, 140)}`));
    dlg.append(this.el('p', 'ca-dialog-note', this.serverFeatures.reports ? `This goes to ${lead.name}, the admin of this room, in your direct message with them, and is kept in an audit log. Other members do not see it.` : `This is posted in this room, addressed to ${lead.name}, the coordinator. Every member of the room can read it.`));
    const form = this.el('form', 'ca-form');
    const wrap = this.el('label', 'ca-label');
    wrap.append(this.el('span', '', 'What is wrong? (optional)'));
    const reason = this.el('textarea', 'ca-field');
    reason.rows = 3;
    reason.maxLength = 1000;
    wrap.append(reason);
    const row = this.el('div', 'ca-dialog-actions');
    const cancel = this.el('button', 'ca-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const send = this.el('button', 'ca-btn is-primary', 'Send report');
    send.type = 'submit';
    row.append(cancel, send);
    form.append(wrap, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      send.disabled = true;
      if (this.serverFeatures.reports) {
        const out = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(m.id)}/report`, {
          method: 'POST',
          body: { reason: reason.value.trim() },
        });
        send.disabled = false;
        if (!out.ok) return this.toast(`Chat: ${out.error}`, 'error');
        dlg.close();
        this.toast(`Reported to ${lead.name} in your direct message`, 'info');
        return;
      }
      const when = new Date(m.at).toLocaleString();
      const why = reason.value.trim();
      const text = `REPORT from the user: a message by ${this.authorOf(m.from)} (${when}): "${caSnippet(m.text, 200)}"${why ? ` Reason: ${why}` : ''} Please look into it and tell the user what you find.`;
      const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/messages`, {
        method: 'POST',
        body: { text, to: [lead.sessionId], ...(this.serverFeatures.replies ? { replyTo: m.id } : {}) },
      });
      send.disabled = false;
      if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
      dlg.close();
      this.toast(`Reported to ${lead.name}`, 'info');
    });
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    reason.focus();
  }

  /** "Pinned by you / by the coordinator <name>" above a pinned message. */
  pinMarkEl(m) {
    const by = m.pinned.kind === 'agent' ? `${m.pinned.by} (coordinator)` : 'you';
    const el = this.el('div', 'ca-pin-mark');
    el.append(this.icon('pin'), this.el('span', '', `Pinned by ${by}`));
    el.title = `Pinned ${new Date(m.pinned.at).toLocaleString()}`;
    return el;
  }

  /** Edit your own message in place: a text box with Save and Cancel. Survives the feed redrawing (the draft is kept). */
  startEdit(m) {
    this._editing = { id: m.id, draft: m.text };
    this.renderFeed();
    this.msgEl(m.id)?.querySelector('.ca-edit-input')?.focus();
  }

  /** The feed element of a message (ids are UUIDs, matched without building a selector from them). */
  msgEl(id) {
    return [...this.doc.querySelectorAll('.ca-msg')].find((n) => n.dataset.msgId === id) || null;
  }

  cancelEdit() {
    this._editing = null;
    this.renderFeed();
  }

  editorEl(m) {
    const box = this.el('div', 'ca-edit-box');
    const input = this.el('textarea', 'ca-field ca-edit-input');
    input.value = this._editing?.draft ?? m.text;
    input.rows = Math.min(10, Math.max(2, input.value.split('\n').length));
    input.setAttribute('aria-label', 'Edit message');
    input.addEventListener('input', () => {
      if (this._editing) this._editing.draft = input.value;
    });
    const save = this.button('ca-btn ca-edit-save', 'Save edit', () => this.saveEdit(m, input.value), { text: 'Save' });
    const cancel = this.button('ca-btn ca-edit-cancel', 'Cancel edit', () => this.cancelEdit(), { text: 'Cancel' });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.cancelEdit();
      } else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        save.click();
      }
    });
    box.append(input, this.el('div', 'ca-edit-actions', ''), this.el('span', 'ca-hint', 'Enter saves, Esc cancels. Agents that already got the message are sent the new text.'));
    box.querySelector('.ca-edit-actions').append(cancel, save);
    return box;
  }

  async saveEdit(m, text) {
    const next = String(text).trim();
    if (!next) return this.toast('A message cannot be empty', 'error');
    if (next === m.text) return this.cancelEdit();
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(m.id)}`, { method: 'PUT', body: { text: next } });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    this._editing = null;
    await this.app._loadChatRoom(this.roomId, { quiet: true });
    this.renderFeed();
  }

  async setPinned(m, on) {
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(m.id)}/pin`, { method: on ? 'POST' : 'DELETE', body: {} });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    await this.app._loadChatRoom(this.roomId, { quiet: true });
    this.renderFeed();
    this.doc.querySelector('.ca-dialog.ca-pins')?.dispatchEvent(new this.doc.defaultView.Event('ca-pins-changed'));
  }

  /** The channel's pinned messages (its rules), newest first, with Jump and Unpin. */
  async openPinsDialog(roomId) {
    this.doc.querySelector('.ca-dialog.ca-pins')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-pins');
    dlg.setAttribute('aria-label', 'Pinned messages');
    const head = this.el('div', 'ca-invite-head');
    head.append(this.el('h2', '', 'Pinned messages'), this.button('ca-icon-btn', 'Close', () => dlg.close(), { text: '\u2715' }));
    const list = this.el('ul', 'ca-pins-list');
    const paint = async () => {
      const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/pins`);
      list.replaceChildren();
      if (!res.ok) return list.append(this.el('li', 'ca-invite-empty', `Could not load pins: ${res.error}`));
      const pins = res.data?.pins || [];
      if (!pins.length) list.append(this.el('li', 'ca-invite-empty', 'Nothing is pinned. Pin a message from its menu to keep it here and in every agent\'s briefing.'));
      for (const p of pins) {
        const li = this.el('li', 'ca-pins-row');
        const text = this.el('div', 'ca-pins-text');
        const by = p.pinned.kind === 'agent' ? `${p.pinned.by} (coordinator)` : 'you';
        text.append(this.el('strong', '', `${this.authorOf(p.from)}`), this.el('span', 'ca-pins-snippet', caSnippet(p.text, 200)), this.el('span', 'ca-hint', `Pinned by ${by}, ${new Date(p.pinned.at).toLocaleString()}`));
        const jump = this.button('ca-btn', 'Show in channel', () => {
          dlg.close();
          this.msgEl(p.id)?.scrollIntoView?.({ block: 'center' });
        }, { text: 'Show' });
        const unpin = this.button('ca-btn', 'Unpin', () => this.setPinned(p, false), { text: 'Unpin' });
        li.append(text, jump, unpin);
        list.append(li);
      }
    };
    dlg.addEventListener('ca-pins-changed', paint);
    dlg.append(head, list);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    await paint();
  }

  /** What stays of a deleted message: a line saying so, with Restore (the original is in the audit log). */
  tombstoneEl(m) {
    const el = this.el('div', 'ca-msg is-cont is-deleted');
    el.dataset.msgId = m.id;
    el.append(this.el('div', 'ca-msg-gutter'));
    const body = this.el('div', 'ca-msg-body');
    const who = m.from.kind === 'user' ? 'a message from you' : `a message from ${this.authorOf(m.from)}`;
    body.append(this.el('span', 'ca-deleted-text', `This ${who} was deleted.`));
    if (this.serverFeatures.deletes) {
      const restore = this.button('ca-btn ca-restore', `Restore the deleted message at ${new Date(m.at).toLocaleTimeString()} (agents are not sent it again)`, () => this.restoreMessage(m), { text: 'Restore' });
      body.append(restore);
    }
    el.append(body);
    return el;
  }

  async restoreMessage(m) {
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/messages/${encodeURIComponent(m.id)}/restore`, { method: 'POST', body: {} });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    await this.app._loadChatRoom(this.roomId, { quiet: true });
    this.renderFeed();
  }

  /** The quoted line above a reply; clicking it jumps to the original. */
  replyRefEl(m) {
    const found = (this.room?.messages || []).find((x) => x.id === m.replyTo);
    const original = found && !found.deleted ? found : undefined;
    const b = this.el('button', `ca-reply-ref${original ? '' : ' is-missing'}`);
    b.type = 'button';
    if (original) {
      const name = this.authorOf(original.from);
      b.setAttribute('aria-label', `In reply to ${name}: ${caSnippet(original.text)}`);
      b.append(this.avatarFor(original.from, name, { size: 'sm' }));
      const from = this.el('span', 'ca-reply-from', `@${name}`);
      from.style.setProperty('--chat-hue', String(this.authorHue(original.from, name)));
      b.append(from, this.el('span', 'ca-reply-snippet', caSnippet(original.text)));
    } else {
      b.append(this.el('span', 'ca-reply-snippet', found?.deleted ? 'Original message was deleted' : 'Original message is no longer available'));
    }
    b.addEventListener('click', () => this.jumpTo(m.replyTo));
    return b;
  }

  jumpTo(id) {
    const feed = this.app._chatEls.feed;
    const el = [...feed.querySelectorAll('[data-msg-id]')].find((n) => n.dataset.msgId === id);
    if (!el) return this.toast('That message is no longer available', 'info');
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el.classList.add('is-flash');
    this.doc.defaultView?.setTimeout(() => el.classList.remove('is-flash'), 1600);
  }

  /** `@` autocomplete in the message box: members of this room plus @everyone. */
  installMentions() {
    const input = this.app._chatEls.input;
    const list = this.el('div', 'chatroom-suggest ca-mention');
    list.id = 'caMentionList';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Mention someone');
    input.parentNode.insertBefore(list, input);
    this.els.mention = list;
    this.mention = null;
    input.setAttribute('aria-controls', list.id);
    input.addEventListener('input', () => this.updateMentions());
    input.addEventListener('click', () => this.updateMentions());
    input.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) this.updateMentions();
    });
    // The list's own scrollbar or padding must not blur the box and close it.
    list.addEventListener('mousedown', (e) => e.preventDefault());
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.addEventListener('blur', () => this.closeMentions());
    input.addEventListener('keydown', (e) => this.mentionKey(e), true);
  }

  updateMentions() {
    const input = this.app._chatEls?.input;
    const q = input && !this.app._chatCreating ? caMentionQuery(input.value, input.selectionStart) : null;
    const members = this.room ? this.room.members : [];
    const items = q ? caMentionCandidates(members, q.query) : [];
    if (!items.length) {
      this.closeMentions();
      return;
    }
    const prev = this.mention?.items[this.mention.index];
    const keep = prev ? items.findIndex((it) => it.insert === prev.insert) : -1;
    this.mention = { items, index: keep >= 0 ? keep : 0, start: q.start };
    this.renderMentions();
  }

  renderMentions() {
    const { mention: list } = this.els;
    const s = this.mention;
    const input = this.app._chatEls.input;
    list.hidden = false;
    const nodes = [];
    s.items.forEach((it, i) => {
      if (i === 0 && it.kind === 'member') nodes.push(this.el('div', 'ca-mention-head', 'Members'));
      if (it.kind === 'everyone') nodes.push(i > 0 ? this.el('hr', 'ca-mention-sep') : this.el('div', 'ca-mention-head', 'Notify'));
      nodes.push(
        (() => {
        const b = this.el('button', `chatroom-suggest-item ca-mention-item${i === s.index ? ' is-active' : ''}`);
        b.type = 'button';
        b.id = `caMention${i}`;
        b.tabIndex = -1;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(i === s.index));
        if (it.kind === 'everyone') {
          b.append(this.el('span', 'ca-mention-name', '@everyone'), this.el('span', 'ca-mention-sub', 'Everyone in this channel'));
        } else {
          b.append(
            this.app._chatAvatar(it.member.sessionId, it.member.name, { size: 'sm' }),
            this.el('span', 'ca-mention-name', it.member.name),
            this.el('span', 'ca-mention-sub', it.member.role === 'coordinator' ? 'Admin' : caPresence(it.member))
          );
        }
        b.addEventListener('mousedown', (e) => {
          e.preventDefault();
          s.index = i;
          this.acceptMention();
        });
        return b;
        })()
      );
    });
    list.replaceChildren(...nodes);
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `caMention${s.index}`);
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }

  closeMentions() {
    this.mention = null;
    const list = this.els.mention;
    if (list) list.hidden = true;
    const input = this.app._chatEls?.input;
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
  }

  acceptMention() {
    const s = this.mention;
    if (!s) return;
    const input = this.app._chatEls.input;
    const it = s.items[s.index];
    const caret = input.selectionStart ?? input.value.length;
    // The caret may have moved since the list was drawn: only complete the @ it is still in.
    const q = caMentionQuery(input.value, caret);
    if (!q || q.start !== s.start) {
      this.closeMentions();
      return;
    }
    const insert = `@${it.insert} `;
    // Accepting inside a word replaces the whole word, not just the part before the caret.
    const end = caret + (/^[^\s]*/.exec(input.value.slice(caret))?.[0].length ?? 0);
    input.value = `${input.value.slice(0, s.start)}${insert}${input.value.slice(end)}`;
    const at = s.start + insert.length;
    input.setSelectionRange(at, at);
    this.closeMentions();
    this.fitInput();
  }

  /** Keys while the list shows; runs before the composer's Enter-to-send. */
  mentionKey(e) {
    const s = this.mention;
    if (!s || this.els.mention.hidden || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      s.index = (s.index + (e.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length;
      this.renderMentions();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.acceptMention();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeMentions();
    }
  }

  /** Mark `@name` / `@everyone` in a rendered message (text nodes only, never code or links; an address like a@b is left alone). */
  decorateMentions(el) {
    const names = ['everyone', ...(this.room?.members || []).map((m) => m.name).filter(Boolean)];
    names.sort((a, b) => b.length - a.length);
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(^|[^\\w@])(@(?:${escaped.join('|')}))(?![\\w-])`, 'gi');
    const walker = this.doc.createTreeWalker(el, 4);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement?.closest('code, pre, a, .ca-mention-tag')) nodes.push(n);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      const parts = [];
      let last = 0;
      for (const m of text.matchAll(re)) {
        const at = m.index + m[1].length;
        parts.push(text.slice(last, at), this.el('span', 'ca-mention-tag', m[2]));
        last = at + m[2].length;
      }
      if (!parts.length) continue;
      parts.push(text.slice(last));
      node.replaceWith(...parts.filter((p) => p !== ''));
    }
  }

  /** Size the message box to its text (one line to start; the CSS caps it). */
  fitInput() {
    const input = this.app._chatEls?.input;
    if (!input) return;
    input.style.height = 'auto';
    const max = Math.round((this.doc.defaultView?.innerHeight || 800) * 0.4);
    input.style.height = `${Math.max(32, Math.min(input.scrollHeight || 0, max))}px`;
  }

  installDrop(chat) {
    chat.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault();
        chat.classList.add('is-dropping');
      }
    });
    chat.addEventListener('dragleave', (e) => {
      if (!chat.contains(e.relatedTarget)) chat.classList.remove('is-dropping');
    });
    chat.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      chat.classList.remove('is-dropping');
      if (!files.length) return;
      e.preventDefault();
      this.app._attachChatFiles?.(files);
    });
  }

  installKeys() {
    // Ctrl/Cmd+K opens the switcher in the chat view; the terminal UI's own palette stays in debug.
    this.doc.addEventListener(
      'keydown',
      (e) => {
        if (!this.active) return;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.openSwitcher();
        }
      },
      true
    );
    this.doc.addEventListener('visibilitychange', () => {
      this.markReadSoon();
      // Back from a sleeping phone or a background tab: what the live stream missed comes in now.
      if (this.doc.visibilityState === 'visible' && this.roomId && !this.embassy?.selected) this.app._chatOnVisible?.();
    });
    this.doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active && this.drawer && !this.doc.querySelector('dialog[open]')) {
        const trigger = this.drawer === 'members' ? this.els.membersBtn : this.els.navBtn;
        this.toggleDrawer(null);
        trigger?.focus?.();
      }
    });
  }

  /** Track the visual viewport so an on-screen keyboard shrinks the app instead of covering the composer. */
  installViewport() {
    for (const q of ['(max-width: 767px)', '(max-width: 899px)']) {
      this.doc.defaultView?.matchMedia?.(q)?.addEventListener?.('change', () => this.renderChrome());
    }
    const vv = this.doc.defaultView?.visualViewport;
    if (!vv) return;
    const fit = () => {
      // Debug's terminal is a sibling of the chat root and needs the same viewport.
      this.doc.documentElement.style.setProperty('--ca-vh', `${Math.round(vv.height)}px`);
      this.doc.documentElement.style.setProperty('--ca-vtop', `${Math.round(vv.offsetTop)}px`);
      this.els.root.style.setProperty('--ca-vh', `${Math.round(vv.height)}px`);
      this.els.root.style.setProperty('--ca-vtop', `${Math.round(vv.offsetTop)}px`);
      // A keyboard opening, closing or resizing keeps the newest message in view, but only for a reader who was at the
      // bottom: `_feedStick` comes from the feed's own scroll events, so the resize itself cannot change it.
      const feed = this.app._chatEls?.feed;
      if (feed && this._feedStick !== false) this.doc.defaultView.requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }

  /* ── rendering ── */

  renderAll() {
    if (!this.built) return;
    // Another room opened (a click, a link, a notification): leave the page for the conversation.
    if (this.embed) {
      if (this._embedRoom == null) this._embedRoom = this.roomId; // a page opened by a link before any room had loaded
      else if (this.roomId !== this._embedRoom) this.closePage();
    }
    if (!this.app._chatCreating) this._pendingPlacement = null;
    this.renderReplyBar();
    this.syncComposer?.();
    this.renderRail();
    this.renderSidebar();
    this.renderHeader();
    this.renderMembers();
    this._presenceSig = this.presenceSignature();
    this.renderTyping();
    this.renderChrome();
    this.app._renderChatBadge?.();
  }

  renderChrome() {
    const total = caTotals(this.viewRooms);
    const features = this.serverFeatures;
    this.els.root.classList.toggle('ca-members-open', this.membersOpen);
    this.els.root.dataset.drawer = this.drawer || '';
    this.renderMemberChip();
    const placeholder = this.composerPlaceholder();
    const input = this.app._chatEls?.input;
    if (input) input.placeholder = placeholder;
    this.els.root.dataset.unread = features.unread && total.unread ? (total.mentions ? 'mention' : 'unread') : '';
    // The terminal UI's own chat button carries the same total: a number for mentions, else a dot.
    const legacy = this.doc.getElementById('chatroomBadge');
    if (legacy) {
      if (features.unread) {
        const badge = chatBadgeFor(total.unread, total.mentions);
        legacy.hidden = !badge.dot;
        legacy.textContent = badge.kind === 'mention' ? badge.text : '\u2022';
      } else {
        const n = this.app._chatUnread || 0;
        legacy.hidden = !n;
        legacy.textContent = n > 99 ? '99+' : String(n);
      }
    }
    this.renderApprovals();
    this.applyInert();
  }

  /** The focused control survives a redraw (a count changing must not drop keyboard focus). */
  keepFocus(container, render) {
    const key = this.doc.activeElement?.dataset?.key;
    const inside = container.contains(this.doc.activeElement);
    render();
    if (inside && key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  indicator(unread, mentions, { showDot = true } = {}) {
    const wrap = this.el('span', 'ca-ind');
    if (!this.serverFeatures.unread) return wrap;
    const badge = chatBadgeFor(unread, mentions);
    if (badge.kind === 'mention') wrap.append(this.el('span', 'ca-count', badge.text));
    else if (badge.dot && showDot) wrap.append(this.el('span', 'ca-dot'));
    return wrap;
  }

  /* ── channel order (the owner's sidebar; agents' lists are not affected) ── */

  /** The workspace's live channels in the order the sidebar shows them. */
  liveChannelIds() {
    const ws = this.workspace === 'home' ? '' : this.workspace || '';
    return caByPosition(this.viewRooms.filter((r) => r && !caIsDm(r) && !r.archivedAt && (r.workspace || '') === ws)).map((r) => r.id);
  }

  categoryOf(id) {
    return this.rooms.find((r) => r.id === id)?.category || '';
  }

  startOrder() {
    this._order = this.liveChannelIds();
    this._orderWs = this.workspace;
    this.renderSidebar();
  }

  cancelOrder() {
    this._order = null;
    this.renderSidebar();
  }

  async finishOrder() {
    const ids = this._order;
    if (!ids) return;
    if (await this.saveOrder(ids)) {
      this._order = null;
      this.renderSidebar();
    }
  }

  /** Save an order to the server (it is per owner, so phone and desktop match); the page takes it at once, the server's update confirms. */
  async saveOrder(ids) {
    const res = await this.app._chatApi('/api/chatrooms/order', { method: 'PUT', body: { ids } });
    if (!res.ok) {
      this.toast(`Chat: ${res.error}`, 'error');
      return false;
    }
    ids.forEach((id, i) => {
      const room = this.rooms.find((r) => r.id === id);
      if (room) room.position = i + 1;
    });
    this.renderSidebar();
    return true;
  }

  moveChannel(id, step) {
    if (!this._order) return;
    this._order = caMoveWithin(this._order, id, step, (x) => this.categoryOf(x));
    this.renderSidebar();
  }

  /** Dragging a channel row onto another (in the same category) moves it before or after it: saved at once, or into the draft while reordering. */
  wireOrderDrag(wrap, id) {
    if (!this.serverFeatures.order || this.doc.defaultView?.matchMedia?.('(pointer: coarse)')?.matches) return;
    wrap.draggable = true;
    const clear = () => wrap.classList.remove('is-drop-before', 'is-drop-after');
    const after = (ev) => {
      const box = wrap.getBoundingClientRect();
      return (ev.clientY || 0) > box.top + box.height / 2;
    };
    wrap.addEventListener('dragstart', (ev) => {
      this._dragId = id;
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', id);
      }
    });
    wrap.addEventListener('dragover', (ev) => {
      if (!this._dragId || this._dragId === id || this.categoryOf(this._dragId) !== this.categoryOf(id)) return;
      ev.preventDefault();
      const below = after(ev);
      wrap.classList.toggle('is-drop-after', below);
      wrap.classList.toggle('is-drop-before', !below);
    });
    wrap.addEventListener('dragleave', clear);
    wrap.addEventListener('dragend', () => {
      this._dragId = null;
      clear();
    });
    wrap.addEventListener('drop', (ev) => {
      ev.preventDefault();
      clear();
      const dragged = this._dragId;
      this._dragId = null;
      if (!dragged || this.categoryOf(dragged) !== this.categoryOf(id)) return;
      const base = this._order || this.liveChannelIds();
      const next = caMoveBeside(base, dragged, id, after(ev));
      if (next === base) return;
      if (this._order) {
        this._order = next;
        this.renderSidebar();
      } else {
        this.saveOrder(next);
      }
    });
  }

  unreadNote(item) {
    if (!this.serverFeatures.unread) return '';
    if (item.mentions > 0) return `, ${item.mentions} mention${item.mentions === 1 ? '' : 's'}`;
    return item.unread > 0 ? ', unread' : '';
  }

  renderRail() {
    const rail = this.els.rail;
    this.keepFocus(rail, () => {
      rail.replaceChildren();
      const items = caWorkspaceItems(this.viewRooms, this.defaultWorkspaceName());
      const group = this.el('div', 'ca-rail-group');
      for (const w of items) {
        const selected = (w.home ? 'home' : w.key) === this.workspace;
        const b = this.el('button', `ca-rail-btn${selected ? ' is-active' : ''}${w.home ? ' is-home' : ''}`);
        b.type = 'button';
        b.dataset.key = `ws:${w.key}`;
        b.title = w.label;
        b.setAttribute('aria-label', `${w.label}${this.unreadNote(w)}`);
        if (selected) b.setAttribute('aria-current', 'page');
        const meta = w.home ? {} : Object.hasOwn(this.wsMeta, w.key) ? this.wsMeta[w.key] : {};
        if (w.home) b.append(this.icon('chat'));
        else if (this.iconImage(meta.image)) {
          const img = this.el('img', 'ca-rail-img');
          img.alt = '';
          img.draggable = false;
          img.src = this.iconImage(meta.image);
          b.classList.add('has-image');
          b.append(img);
        } else b.append(this.el('span', 'ca-rail-letter', meta.icon || (w.label.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase()));
        if (Number.isFinite(meta.hue)) {
          b.classList.add('has-hue');
          b.style.setProperty('--ws-hue', String(meta.hue));
        }
        if (!w.home) this.wireRailMenu(b, w.key);
        const ind = this.indicator(w.unread, w.mentions);
        ind.classList.add('ca-rail-ind');
        b.append(ind);
        b.addEventListener('click', () => this.selectWorkspace(w.home ? 'home' : w.key));
        group.append(b);
        if (w.home) group.append(this.el('hr', 'ca-rail-sep'));
      }
      // A workspace exists once a room is placed in it, so creating one needs the placement routes.
      if (this.serverFeatures.placement) {
        const add = this.button('ca-rail-btn ca-rail-add', 'Create a workspace', () => this.openWorkspaceDialog(), { icon: 'plus' });
        add.dataset.key = 'add';
        group.append(add);
      }
      // The org chart and the Debug terminals live next to the gear, in the profile bar (renderUser), not in the rail.
      rail.append(group);
    });
  }

  defaultWorkspaceName() {
    return this.doc.defaultView?.ReverieI18n?.displayName || 'Reverie';
  }

  renderSidebar() {
    const { sideTitle, sideScroll } = this.els;
    if (this._order && this._orderWs !== this.workspace) this._order = null; // another workspace: the draft was for the one left
    const home = this.workspace === 'home';
    sideTitle.replaceChildren();
    const label = home ? 'Direct Messages' : this.workspaceLabel();
    const nameBtn = this.el('button', 'ca-side-name-btn');
    nameBtn.type = 'button';
    nameBtn.dataset.key = 'ws-menu';
    nameBtn.setAttribute('aria-haspopup', 'menu');
    nameBtn.setAttribute('aria-label', `${label} menu`);
    const nameText = this.el('h2', 'ca-side-name', label);
    nameBtn.append(nameText, this.icon('chevron'));
    const hue = !home && Object.hasOwn(this.wsMeta, this.workspace || '') ? this.wsMeta[this.workspace || ''].hue : undefined;
    sideTitle.classList.toggle('has-hue', Number.isFinite(hue));
    if (Number.isFinite(hue)) sideTitle.style.setProperty('--ws-hue', String(hue));
    else sideTitle.style.removeProperty('--ws-hue');
    nameBtn.addEventListener('click', () => this.openWorkspaceMenu(nameBtn));
    sideTitle.append(nameBtn);
    if (home) {
      if (this.serverFeatures.dms) {
        sideTitle.append(this.button('ca-icon-btn', 'Start a direct message', () => this.openSwitcher({ agents: true }), { icon: 'plus' }));
      }
    } else if (this._order) {
      sideTitle.append(
        this.button('ca-btn ca-order-cancel', 'Cancel reordering', () => this.cancelOrder(), { text: 'Cancel' }),
        this.button('ca-btn ca-order-done', 'Save the channel order', () => this.finishOrder(), { text: 'Done' })
      );
    } else {
      if (this.serverFeatures.order) sideTitle.append(this.button('ca-icon-btn ca-order-edit', 'Edit channel order', () => this.startOrder(), { icon: 'reorder' }));
      sideTitle.append(this.button('ca-icon-btn', 'New channel', () => this.newRoom(), { icon: 'plus' }));
    }
    this.keepFocus(sideScroll, () => {
      sideScroll.replaceChildren();
      sideScroll.append(this.pagesEl());
      if (home) this.renderDmList(sideScroll);
      else this.renderChannelList(sideScroll);
    });
    this.embassy?.renderSidebar();
  }

  wireRailMenu(b, key) {
    b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.openRailMenu(key, { x: ev.clientX || b.getBoundingClientRect().right, y: ev.clientY || b.getBoundingClientRect().top }, b);
    });
    let timer = 0;
    const stop = () => {
      this.doc.defaultView?.clearTimeout(timer);
      timer = 0;
    };
    b.addEventListener('touchstart', (ev) => {
      const t = ev.touches?.[0];
      timer = this.doc.defaultView?.setTimeout(() => {
        timer = 0;
        this.openRailMenu(key, { x: t?.clientX || 24, y: t?.clientY || 24 }, b);
      }, 500);
    }, { passive: true });
    for (const name of ['touchend', 'touchmove', 'touchcancel']) b.addEventListener(name, stop, { passive: true });
  }

  workspaceLabel() {
    return this.workspace || this.defaultWorkspaceName();
  }

  roomRow(item, kind) {
    const b = this.el('button', `ca-item ca-item--${kind}${item.muted ? ' is-muted' : ''}${item.active ? ' is-active' : ''}${item.unread > 0 && this.serverFeatures.unread ? ' is-unread' : ''}`);
    b.type = 'button';
    b.dataset.key = item.key;
    b.style.setProperty('--ca-depth', String(item.depth || 0));
    if (item.active) b.setAttribute('aria-current', 'true');
    const dmState = kind === 'dm' && item.peer ? this.presenceOf(item.peer) : '';
    const isPrivate = kind !== 'dm' && this.rooms.find((r) => r.id === item.id)?.visibility === 'private';
    b.setAttribute('aria-label', `${kind === 'dm' ? 'Direct message with ' : 'Channel '}${item.label}${isPrivate ? ', private' : ''}${dmState ? `, ${CA_STATE_LABEL[dmState]}` : ''}${this.unreadNote(item)}`);
    if (kind === 'dm') {
      b.append(this.app._chatAvatar(item.peer?.sessionId || item.id, item.label, { size: 'md', state: dmState || undefined }));
    } else {
      const itemRoom = this.rooms.find((r) => r.id === item.id);
      const hash = this.glyphNode(caRoomGlyph(itemRoom));
      hash.setAttribute('aria-hidden', 'true');
      b.append(hash);
    }
    b.append(this.el('span', 'ca-name', item.label));
    // A direct message with an agent that needs you, errored or waits for input says so in words, not only by its dot.
    const note = { needs: 'Needs your approval', error: 'Error', waiting: 'Waiting for input' }[dmState];
    if (note) {
      const words = this.el('span', `ca-dm-state is-${dmState}`, note);
      words.setAttribute('aria-hidden', 'true');
      b.append(words);
    }
    b.append(this.indicator(item.unread, item.mentions, { showDot: false }));
    b.addEventListener('click', () => {
      if (!this._order || kind === 'dm') this.selectRoom(item.id);
    });
    // Right-click, the menu key or a long press opens the channel menu, as in Discord.
    const target = kind === 'dm' ? b : null;
    const wire = (el) => {
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.openChannelMenu(item.id, { x: ev.clientX || el.getBoundingClientRect().left + 24, y: ev.clientY || el.getBoundingClientRect().bottom }, b);
      });
      let timer = 0;
      const stop = () => {
        clearTimeout(timer);
        timer = 0;
      };
      el.addEventListener('touchstart', (ev) => {
        const t = ev.touches?.[0];
        timer = this.doc.defaultView?.setTimeout(() => {
          timer = 0;
          this.openChannelMenu(item.id, { x: t?.clientX || 24, y: t?.clientY || 24 }, b);
        }, 550);
      }, { passive: true });
      for (const name of ['touchend', 'touchmove', 'touchcancel']) el.addEventListener(name, stop, { passive: true });
    };
    if (target) {
      const dmWrap = this.el('div', 'ca-item-wrap');
      dmWrap.append(b);
      const close = this.button('ca-item-act ca-item-close', `Close DM with ${item.label}`, () => this.closeDm(item.id), { text: '\u2715' });
      close.title = 'Close DM';
      close.dataset.key = `close:${item.id}`;
      dmWrap.append(close);
      wire(dmWrap);
      return dmWrap;
    }
    // A channel row also carries its own "Invite" button, shown on hover or focus like Discord's.
    const wrap = this.el('div', `ca-item-wrap${item.active ? ' is-active' : ''}${this._order ? ' is-ordering' : ''}`);
    if (this._order) {
      // Reordering: a handle, the channel, and Up / Down buttons (a touch screen cannot drag reliably).
      const handle = this.el('span', 'ca-order-handle', '\u2630');
      handle.setAttribute('aria-hidden', 'true');
      wrap.append(handle, b);
      const moved = (step) => caMoveWithin(this._order, item.id, step, (x) => this.categoryOf(x));
      for (const [step, label, glyph, key] of [[-1, 'up', '\u25B2', 'up'], [1, 'down', '\u25BC', 'down']]) {
        const btn = this.button('ca-item-act ca-order-btn', `Move ${item.label} ${label}`, () => this.moveChannel(item.id, step), { text: glyph });
        btn.dataset.key = `${key}:${item.id}`;
        btn.disabled = moved(step) === this._order;
        wrap.append(btn);
      }
      this.wireOrderDrag(wrap, item.id);
      return wrap;
    }
    this.wireOrderDrag(wrap, item.id);
    wrap.append(b);
    const invite = this.button('ca-item-act', `Invite agents to ${item.label}`, () => this.openInviteDialog(item.id), { icon: 'invite' });
    invite.title = 'Invite to channel';
    invite.dataset.key = `invite:${item.id}`;
    wrap.append(invite);
    const edit = this.button('ca-item-act ca-item-edit', `Edit channel ${item.label}`, () => this.openChannelSettings(item.id), { icon: 'gearsmall' });
    edit.title = 'Edit channel';
    edit.dataset.key = `edit:${item.id}`;
    wrap.append(edit);
    wire(wrap);
    return wrap;
  }

  /** The state a member's dot shows (see caMemberState): from the session the page already tracks and its pending hooks. */
  presenceOf(member) {
    const id = member?.sessionId;
    const session = id ? this.app.sessions?.get?.(id) : undefined;
    const hooks = id ? this.app.pendingHooks?.get?.(id) : undefined;
    if (!member || !member.alive) return 'gone';
    // The terminal UI's own classifier decides, so the chat can never rank a state differently from the tab rail and the phone
    // overview; caMemberState is the same ranking for a page that does not have it.
    const shared = this.app._mobileOverviewState;
    if (session && typeof shared === 'function') {
      const state = shared.call(this.app, session, hooks);
      if (state === 'done') return 'gone';
      return state === 'idle' && member.working ? 'working' : state;
    }
    return caMemberState(member, session, hooks);
  }

  /** What the state dots show right now, as one string: a redraw is only worth it when this changes. */
  presenceSignature() {
    const people = [...(this.room?.members || []), ...caDmItems(this.viewRooms, this.roomId, this.closedDms, caEmployeeBySession(this.company)).map((i) => i.peer).filter(Boolean)];
    return people.map((m) => `${m.sessionId}:${this.presenceOf(m)}`).join('|');
  }

  /** Redraw what shows a member's state (the member list and the direct-message dots), at most once a frame. */
  schedulePresence() {
    if (!this.built || this._presenceQueued) return;
    this._presenceQueued = true;
    const w = this.doc.defaultView;
    (w?.requestAnimationFrame ? w.requestAnimationFrame.bind(w) : (f) => setTimeout(f, 16))(() => {
      this._presenceQueued = false;
      if (!this.built) return;
      this.syncTurns();
      // A token count or a timestamp changing is not a state change: redrawing then would replace the button under a pointer.
      const signature = this.presenceSignature();
      if (signature === this._presenceSig) return;
      this._presenceSig = signature;
      this.renderMembers();
      this.renderSidebar();
    });
  }

  renderDmList(into) {
    const items = caDmItems(this.viewRooms, this.embed ? null : this.roomId, this.closedDms, caEmployeeBySession(this.company));
    if (!items.length) {
      into.append(this.el('p', 'ca-empty-note', this.serverFeatures.dms
        ? 'No direct messages yet. Start one with the + above, or open an agent in the member list.'
        : 'Direct messages arrive with the next server update.'));
      return;
    }
    const list = this.el('div', 'ca-list');
    for (const item of items) {
      list.append(this.roomRow(item, 'dm'));
      // The earlier chats with the same person are listed while one of the person's chats is open.
      if (item.earlier && (item.active || item.earlier.some((e) => e.active))) {
        for (const e of item.earlier) list.append(this.roomRow({ ...e, depth: 1, label: `${e.label} (earlier)` }, 'dm'));
      }
    }
    into.append(list);
  }

  renderChannelList(into) {
    const hide = this.hideMuted;
    const shown = this.viewRooms.filter((r) => !(hide && r.muted && r.id !== this.roomId));
    const draft = this._order;
    const source = draft ? shown.map((r) => (draft.includes(r.id) ? { ...r, position: draft.indexOf(r.id) + 1 } : r)) : shown;
    const items = caChannelItems(source, this.workspace === 'home' ? '' : this.workspace, this.collapsed, this.embed || this.embassy?.selected ? null : this.roomId);
    if (!items.length) {
      into.append(this.el('p', 'ca-empty-note', 'No channels here yet. Use + to create one.'));
      return;
    }
    const list = this.el('div', 'ca-list');
    for (const item of items) {
      if (item.type === 'room') {
        list.append(this.roomRow(item, 'room'));
        continue;
      }
      const b = this.el('button', `ca-cat${item.unread > 0 && this.serverFeatures.unread ? ' is-unread' : ''}`);
      b.type = 'button';
      b.dataset.key = item.key;
      b.setAttribute('aria-expanded', String(!item.folded));
      b.setAttribute('aria-label', `${item.label} category${this.unreadNote(item)}`);
      const chev = this.icon('chevron');
      chev.classList.add('ca-chev');
      if (item.folded) chev.classList.add('is-folded');
      b.append(chev, this.el('span', 'ca-name', item.label));
      // A folded category tells you what is inside it: a dot for unread, a number for mentions.
      b.append(this.indicator(item.unread, item.mentions, { showDot: item.folded }));
      b.addEventListener('click', () => this.toggleCategory(item.key, item.folded));
      if (item.archived) {
        list.append(b);
        continue;
      }
      const wrap = this.el('div', 'ca-item-wrap ca-cat-wrap');
      wrap.append(b);
      const add = this.button('ca-item-act ca-cat-add', `Create channel in ${item.label}`, () => this.newRoom({ category: item.name }), { icon: 'plus' });
      add.title = 'Create channel';
      add.dataset.key = `cat-add:${item.key}`;
      wrap.append(add);
      list.append(wrap);
    }
    into.append(list);
  }

  toggleCategory(key, folded) {
    this.collapsed[key] = !folded;
    caWrite('local', 'reverie:chat:collapsed', JSON.stringify(this.collapsed));
    this.renderSidebar();
  }

  selectWorkspace(key) {
    this.embassy?.close();
    if (this.orgOpen) this.closeOrg();
    this.workspace = key;
    this._wsPinned = true;
    this.renderAll();
  }

  /** A room was opened (by a click, a link or the first load): the rail goes to the workspace it lives in. */
  followRoom() {
    if (this._wsPinned || !this.room) return;
    this.workspace = caWorkspaceOf(this.room);
  }

  async selectRoom(id) {
    this.embassy?.close();
    if (this.orgOpen) this.closeOrg();
    this.closePage();
    this.reopenDm(id);
    this.app._chatCreating = false;
    this.toggleDrawer(null);
    this._wsPinned = false;
    await this.app._loadChatRoom(id);
    this.renderAll();
    this.els.composerInput()?.focus?.();
  }

  /** `title` replaces the form's heading ("New channel in X"); the room lands in `placement`. */
  /**
   * "+" on the sidebar, a category or the rail's new workspace: the Create Channel dialog. `placement` says where
   * the channel goes ({ workspace?, category? }); `title` replaces the subtitle.
   */
  newRoom(placement, title) {
    const inSpace = this.workspace !== 'home' && this.workspace ? { workspace: this.workspace } : {};
    this.toggleDrawer(null);
    this.openCreateChannelDialog({ ...inSpace, ...(placement || {}) }, title);
  }

  /** Discord's Create Channel: type (text, or voice with a voice agent), name, category, members. */
  openCreateChannelDialog(place = {}, title) {
    this.doc.querySelector('.ca-dialog.ca-create')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-create');
    dlg.setAttribute('aria-label', 'Create channel');
    const head = this.el('div', 'ca-invite-head');
    const titles = this.el('div');
    const where = place.category ? `in ${place.category}` : place.workspace ? `in ${place.workspace}` : '';
    titles.append(this.el('h2', '', 'Create channel'), this.el('p', 'ca-dialog-note', title || where));
    head.append(titles, this.button('ca-icon-btn', 'Close', () => dlg.close(), { text: '\u2715' }));
    const form = this.el('form', 'ca-form');

    // Type
    const typeBox = this.el('div', 'ca-create-types');
    typeBox.setAttribute('role', 'radiogroup');
    typeBox.setAttribute('aria-label', 'Channel type');
    let type = 'text';
    const voiceNote = this.el('p', 'ca-hint');
    const types = [
      ['text', { kind: 'text', text: '#', label: '' }, 'Text', 'Everyone in the channel reads and writes messages, images and files.'],
      ['voice', { kind: 'voice', text: '', label: '' }, 'Voice', 'One agent answers when you speak (phone and car mode), and its replies can be read aloud.'],
    ];
    const radios = {};
    for (const [key, glyph, label, text] of types) {
      const row = this.el('label', 'ca-create-type');
      const radio = this.el('input');
      radio.type = 'radio';
      radio.name = 'ca-channel-type';
      radio.value = key;
      radio.checked = key === type;
      radio.addEventListener('change', () => {
        type = key;
        voiceRow.hidden = type !== 'voice';
        syncMembers();
      });
      const words = this.el('span', 'ca-create-type-text');
      const title = this.el('strong', 'ca-create-type-title');
      title.append(this.glyphNode(glyph), this.el('span', '', label));
      words.append(title, this.el('span', 'ca-hint', text));
      row.append(radio, words);
      typeBox.append(row);
      radios[key] = radio;
    }

    // Name and category
    const nameWrap = this.el('label', 'ca-label');
    nameWrap.append(this.el('span', 'ca-label-text', 'Channel name'));
    const name = this.el('input', 'ca-field ca-create-name');
    name.maxLength = 80;
    name.placeholder = 'new-channel';
    name.required = true;
    nameWrap.append(name);
    const cats = [...new Set(this.rooms.filter((r) => !caIsDm(r) && (r.workspace || '') === (place.workspace || '')).map((r) => r.category).filter(Boolean))];
    const catWrap = this.el('label', 'ca-label');
    catWrap.append(this.el('span', 'ca-label-text', 'Category (optional)'));
    const category = this.el('input', 'ca-field');
    category.maxLength = 40;
    category.value = place.category || '';
    category.setAttribute('list', 'ca-create-cats');
    const catList = this.el('datalist');
    catList.id = 'ca-create-cats';
    for (const c of cats) catList.append(new Option(c, c));
    catWrap.append(category, catList);

    // Members, coordinator, voice agent
    const sessions = (this.app._chatCandidateSessions?.(new Set()) || []).filter((s) => s.mode !== 'shell');
    const membersBox = this.el('div', 'ca-create-members');
    const checks = new Map();
    for (const s of sessions) {
      const row = this.el('label', 'ca-create-member');
      const box = this.el('input');
      box.type = 'checkbox';
      box.value = s.id;
      box.addEventListener('change', syncMembers);
      checks.set(s.id, box);
      row.append(box, this.app._chatAvatar(s.id, s.name, { size: 'sm' }), this.el('span', 'ca-name', s.name), this.el('span', 'ca-invite-sub', (Object.hasOwn(CA_BACKENDS, s.mode) ? CA_BACKENDS[s.mode] : String(s.mode || ''))));
      membersBox.append(row);
    }
    if (!sessions.length) membersBox.append(this.el('p', 'ca-hint', 'No agents are open yet. You can invite them later.'));
    const select = (label, empty) => {
      const wrap = this.el('label', 'ca-label');
      wrap.append(this.el('span', 'ca-label-text', label));
      const sel = this.el('select', 'ca-field');
      sel.append(new Option(empty, ''));
      wrap.append(sel);
      return { wrap, sel };
    };
    const coord = select('Admin', 'No admin (I direct them)');
    const voice = select('Voice agent', 'Choose the agent that answers you');
    const voiceRow = voice.wrap;
    voiceRow.hidden = true;
    function syncMembers() {
      for (const sel of [coord.sel, voice.sel]) {
        const keep = sel.value;
        sel.replaceChildren(new Option(sel === coord.sel ? 'No admin (I direct them)' : 'Choose the agent that answers you', ''));
        for (const s of sessions) if (checks.get(s.id)?.checked) sel.append(new Option(s.name, s.id));
        sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
      }
    }
    const error = this.el('p', 'ca-form-error');
    error.setAttribute('role', 'alert');
    const row = this.el('div', 'ca-dialog-actions');
    const cancel = this.el('button', 'ca-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const create = this.el('button', 'ca-btn is-primary', 'Create channel');
    create.type = 'submit';
    row.append(cancel, create);
    form.append(
      this.el('span', 'ca-label-text', 'Channel type'), typeBox, voiceNote, nameWrap, catWrap,
      this.el('span', 'ca-label-text', 'Members'), membersBox, coord.wrap, voiceRow, error, row
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const picked = sessions.filter((s) => checks.get(s.id)?.checked).map((s) => s.id);
      if (type === 'voice') {
        if (!voice.sel.value) {
          error.textContent = 'Choose the voice agent (it must be one of the members).';
          return;
        }
      }
      const members = picked.map((id) => ({ sessionId: id, ...(type === 'voice' && id === voice.sel.value ? { voice: true } : {}) }));
      const chosenCoordinator = coord.sel.value;
      create.disabled = true;
      const res = await this.app._chatApi('/api/chatrooms', {
        method: 'POST',
        body: {
          name: name.value.trim(),
          members: members.filter((m) => m.sessionId !== chosenCoordinator),
          ...(chosenCoordinator ? { coordinatorSessionId: chosenCoordinator } : {}),
        },
      });
      if (!res.ok) {
        create.disabled = false;
        error.textContent = res.error;
        return;
      }
      const placement = { workspace: place.workspace || '', category: category.value.trim() };
      if (placement.workspace || placement.category) {
        const put = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(res.data.id)}/placement`, { method: 'PUT', body: placement });
        if (!put.ok) this.toast(`Chat: created, but not placed (${put.error})`, 'error');
      }
      dlg.close();
      this._wsPinned = false;
      await this.app._loadChatRooms(res.data.id);
      // A voice agent who is also the coordinator joins as the coordinator, so the flag is set once the room is open.
      if (type === 'voice' && voice.sel.value === chosenCoordinator) await this.app._setChatMemberVoice?.(chosenCoordinator, true);
      this.renderAll();
    });
    dlg.append(head, form);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    name.focus();
  }

  /** The rail's "+": name a workspace, then make its first channel (that is what brings it into being). */
  openWorkspaceDialog() {
    this.doc.querySelector('.ca-dialog.ca-workspace')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-workspace');
    dlg.setAttribute('aria-label', 'Create a workspace');
    dlg.append(this.el('h2', '', 'Create a workspace'));
    dlg.append(this.el('p', 'ca-dialog-note', 'A workspace groups channels, like a server or an organisation. You will create its first channel next.'));
    const form = this.el('form', 'ca-form');
    const wrap = this.el('label', 'ca-label');
    wrap.append(this.el('span', '', 'Workspace name'));
    const input = this.el('input', 'ca-field');
    input.maxLength = 40;
    input.required = true;
    wrap.append(input);
    const error = this.el('p', 'ca-form-error');
    error.setAttribute('role', 'alert');
    const row = this.el('div', 'ca-dialog-actions');
    const cancel = this.el('button', 'ca-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const go = this.el('button', 'ca-btn is-primary', 'Create');
    go.type = 'submit';
    row.append(cancel, go);
    const logo = this.workspaceLogoField('', () => {});
    form.append(wrap, logo.wrap, error, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled || logo.pending()) return;
      const name = input.value.trim().replace(/\s+/g, ' ');
      const same = (a, b) => a.toLowerCase() === b.toLowerCase();
      const existing = this.rooms.find((r) => !caIsDm(r) && !r.archivedAt && r.workspace && same(r.workspace, name));
      if (!name || same(name, 'home') || same(name, this.defaultWorkspaceName())) {
        error.textContent = 'Pick a name that is not Home or the default workspace.';
        return;
      }
      if (existing) {
        dlg.close();
        this.selectWorkspace(existing.workspace);
        return;
      }
      if (logo.value()) {
        go.disabled = true;
        if (!await this.saveWsPicture(name, logo.value())) {
          go.disabled = false;
          error.textContent = 'The logo could not be saved. Try again or remove it to use the first letter.';
          return;
        }
      }
      dlg.close();
      this._wsPinned = false;
      this.newRoom({ workspace: name }, `New workspace ${name}: its first channel`);
    });
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    input.focus();
  }

  async loadPhoneStatus() {
    const res = await this.app._chatApi('/api/chatrooms/phone-status');
    if (!this._phonePending?.size) this.phoneStatus = res.ok ? res.data : undefined;
    this.renderUser();
    if (this.view === 'chat') this.renderMembers();
  }

  async cyclePhoneStatus(target, member) {
    this._phonePending ||= new Set();
    if (this._phonePending.has(target)) return;
    const previous = member ? member.alertMode : this.phoneStatus?.alertMode;
    const mode = previous?.until > Date.now() ? previous.mode : 'ring';
    const next = ({ ring: 'vibrate', vibrate: 'silent', silent: 'ring' })[mode] || 'ring';
    const update = lease => {
      if (member) member.alertMode = lease;
      for (const room of [...this.rooms, this.room].filter(Boolean)) for (const m of room.members || []) {
        if (m.sessionId === target) m.alertMode = lease;
      }
      if (this.phoneStatus?.self === target) this.phoneStatus.alertMode = lease;
      this.renderUser();
      this.renderMembers();
    };
    this._phonePending.add(target);
    update(next === 'ring' ? null : { mode: next, until: Date.now() + 28800000 });
    try {
      const res = await this.app._chatApi(`/api/chatrooms/phone-status/${encodeURIComponent(target)}`, { method: 'PUT', body: { mode: next } });
      if (!res.ok) throw new Error('Phone status refused');
      update(res.data?.alertMode ?? null);
    } catch {
      update(previous);
      this.toast('Phone status could not be saved', 'error');
    } finally {
      this._phonePending.delete(target);
      this.renderUser(); this.renderMembers();
    }
  }

  renderUser() {
    const user = this.els.user;
    user.replaceChildren();
    const name = this.userName();
    const who = this.el('button', 'ca-user-btn');
    who.type = 'button';
    who.dataset.key = 'me';
    who.setAttribute('aria-label', `${name}, your profile`);
    const av = this.userAvatar('md', 'idle');
    av.querySelector('.chatroom-dot')?.classList.add('ca-me-dot');
    const text = this.el('div', 'ca-user-text');
    text.append(this.el('strong', 'ca-user-name', name));
    const status = this.el('span', 'ca-user-status');
    status.setAttribute('role', 'status');
    text.append(status);
    this.els.userStatus = status;
    this.els.userDot = av.querySelector('.chatroom-dot');
    who.append(av, text);
    who.addEventListener('click', () => this.openMyProfile(who));
    user.append(who);
    const phone = this.button('ca-icon-btn ca-phone-status', 'Cycle your phone mode', () => this.cyclePhoneStatus(this.phoneStatus?.self || 'owner'));
    const badge = this.app._chatAlertBadge?.({ alertMode: this.phoneStatus?.alertMode }, 'ca-own-alert');
    if (badge) { phone.append(badge); phone.setAttribute('aria-label', `${badge.title}; cycle your phone mode`); }
    phone.disabled = !this.phoneStatus?.canSetOwn || !!this._phonePending?.has(this.phoneStatus?.self || 'owner');
    user.append(phone);
    // Approvals waiting on the user: shown only while there are some (and the inbox is on).
    const approvals = this.button('ca-icon-btn ca-approvals', 'Approvals waiting on you', () => this.app.toggleApprovalsInbox?.(), { icon: 'bell' });
    approvals.hidden = true;
    approvals.append(this.el('span', 'ca-count ca-approvals-count', '0'));
    this.els.approvals = approvals;
    user.append(approvals);
    user.append(this.button('ca-icon-btn', 'App settings', () => this.app.openAppSettings?.(), { icon: 'gear' }));
    this.renderConnection();
    this.renderApprovals();
  }

  renderApprovals() {
    const btn = this.els.approvals;
    if (!btn) return;
    const enabled = !!this.app.approvalsInboxEnabled?.();
    const n = enabled ? this.app.pendingApprovalsCount?.() || 0 : 0;
    btn.hidden = !n;
    btn.querySelector('.ca-approvals-count').textContent = n > 99 ? '99+' : String(n);
    btn.setAttribute('aria-label', n ? `${n} approval${n === 1 ? '' : 's'} waiting on you` : 'Approvals waiting on you');
  }

  /** On a narrow screen the closed drawers are off-screen: keep them out of the Tab order too. */
  applyInert() {
    const mq = (q) => !!this.doc.defaultView?.matchMedia?.(q)?.matches;
    const phone = mq('(max-width: 767px)');
    const compact = mq('(max-width: 899px)');
    const set = (el, off) => {
      if (!el) return;
      if (off) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    };
    const channels = this.drawer === 'channels';
    for (const el of [this.els.rail, this.els.side, this.els.user]) set(el, phone && !channels);
    set(this.els.members, compact && this.drawer !== 'members');
  }

  /** Presence for the signed-in user: whether this page is actually connected to the server. */
  renderConnection() {
    if (!this.els.userStatus) return;
    const state = this.app._connectionStatus || 'connected';
    const online = state === 'connected';
    this.els.userStatus.textContent = online ? 'Online' : state === 'offline' ? 'Offline' : 'Reconnecting…';
    this.els.userDot.classList.toggle('chatroom-dot--gone', !online);
  }

  openHeaderMenu(anchor) {
    const { inviteBtn, pinsBtn, phoneBtn, bellBtn } = this.els;
    const entries = [inviteBtn, pinsBtn, phoneBtn, bellBtn]
      .filter(button => button && !button.hidden && (!(this.embed || this.app._chatCreating) || button === phoneBtn))
      .filter(button => button !== bellBtn || !!this.room)
      .map(button => ({
        label: button.getAttribute('aria-label') || button.title,
        run: () => button === bellBtn ? this.openNotifyMenu(anchor) : button.click(),
      }));
    this.openMenu(entries, { at: anchor, focus: anchor, right: true, label: 'More actions', className: 'ca-head-menu' });
  }

  renderHeader() {
    const { headTitle, headTopic } = this.els;
    const room = this.room;
    this.renderMemberChip();
    const voiceControls = !!room && caSpeaks(room) && !this.embed && !this.embassy?.selected && !this.app._chatCreating;
    this.els.head?.classList.toggle('has-voice-controls', voiceControls);
    if (this.els.speakBtn) {
      // Read aloud is any room's choice (opt-in per room); car mode needs a voice member.
      this.els.speakBtn.hidden = !room || !!this.embed || !!this.embassy?.selected || !!this.app._chatCreating;
      const mode = this.app._speakRepliesMode?.(room?.id) || 'off';
      this.els.speakBtn.setAttribute('aria-pressed', String(mode !== 'off'));
      this.els.speakBtn.dataset.mode = mode;
      // The hover text says what a click does.
      const label =
        mode === 'off'
          ? 'Enable spoken replies in this room'
          : `Disable spoken replies in this room (now: ${mode === 'all' ? 'everyone' : 'replies to you'})`;
      this.els.speakBtn.setAttribute('aria-label', label);
      this.els.speakBtn.title = label;
    }
    if (this.els.carBtn) this.els.carBtn.hidden = !voiceControls || !this.app.openCarMode;
    headTitle.replaceChildren();
    headTopic.textContent = '';
    if (this.embassy?.selected) {
      headTitle.append(this.el('span', 'ca-hash', '#'), this.el('span', 'ca-head-name', this.embassy.connection()?.roomName || 'Shared room'));
      headTopic.textContent = 'Embassy · UNTRUSTED EXTERNAL';
      this.els.pinsBtn.hidden = true; this.els.inviteBtn.hidden = true; this.els.bellBtn.hidden = true;
      return;
    }
    this.els.bellBtn.hidden = false;
    if (this.embed) {
      const page = CA_PAGES[this.embed];
      const mark = this.el('span', 'ca-hash is-drawn');
      mark.setAttribute('aria-hidden', 'true');
      mark.append(this.icon(page.icon));
      headTitle.append(mark, this.el('span', 'ca-head-name', page.label));
      if (this.els.pinsBtn) this.els.pinsBtn.hidden = true;
      if (this.els.inviteBtn) this.els.inviteBtn.hidden = true;
      return;
    }
    // Add people: for a channel that is open (not a direct message, not the new-channel form).
    if (this.els.pinsBtn) {
      const pinned = (room?.messages || []).filter((m) => m.pinned && !m.deleted).length;
      this.els.pinsBtn.hidden = !(room && !this.app._chatCreating && this.serverFeatures.pins && !caIsDm(room));
      this.els.pinsBtn.setAttribute('aria-label', pinned ? `Pinned messages (${pinned})` : 'Pinned messages');
      this.els.pinsBtn.classList.toggle('has-pins', pinned > 0);
    }
    if (this.els.inviteBtn) {
      const canInvite = !!room && !this.app._chatCreating && !caIsDm(room);
      this.els.inviteBtn.hidden = !canInvite;
      if (canInvite) this.els.inviteBtn.setAttribute('aria-label', `Add people to ${room.name}`);
    }
    if (!room || this.app._chatCreating) {
      headTitle.append(this.el('span', 'ca-hash', '#'), this.el('span', '', this.app._chatCreating ? 'New channel' : 'Reverie'));
      return;
    }
    const dm = caIsDm(room);
    const mutedNow = caIsMuted(this.notifyPrefs[room.id]);
    this.els.bellBtn.classList.toggle('is-muted', mutedNow);
    this.els.bellBtn.setAttribute('aria-label', mutedNow ? 'Notification settings (this channel is muted)' : 'Notification settings');
    const headGlyph = dm ? { kind: 'text', text: '@', label: '' } : caRoomGlyph(room);
    const headHash = this.glyphNode(headGlyph);
    if (headGlyph.label) {
      headHash.setAttribute('role', 'img');
      headHash.setAttribute('aria-label', headGlyph.kind === 'voice-private' ? 'Private voice channel' : 'Private channel');
      headHash.title = 'Private channel: members only';
    }
    headTitle.append(headHash, this.el('span', 'ca-head-name', caRoomLabel(room)));
    if (dm) {
      const peer = caDmPeer(room);
      headTopic.textContent = peer ? `${peer.alive ? (peer.working ? 'Working' : 'Online') : 'Offline'}${peer.goal ? ` · ${peer.goal}` : ''}` : '';
    } else {
      const coord = room.members.find((m) => m.role === 'coordinator');
      headTopic.textContent = room.topic ? room.topic : `${room.members.length} member${room.members.length === 1 ? '' : 's'}${coord ? ` · admin ${coord.name}` : ''}`;
    }
  }

  /* ── members ── */

  renderMemberChip() {
    const button = this.els.membersBtn;
    if (!button) return;
    const members = this.room?.members || [];
    const online = members.filter(member => this.presenceOf(member) !== 'gone').length;
    const compact = !!this.doc.defaultView?.matchMedia?.('(max-width: 899px)')?.matches;
    const expanded = compact ? this.drawer === 'members' : this.membersOpen;
    button.hidden = !this.room || !!this.embed || !!this.embassy?.selected || !!this.app._chatCreating;
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-pressed', String(expanded));
    const count = `${members.length} ${members.length === 1 ? 'member' : 'members'}, ${online} online`;
    button.setAttribute('aria-label', `Show member list (${count})`);
    button.title = count;
    this.els.membersCount.textContent = members.length > 99 ? '99+' : String(members.length);
    this.els.membersDot.dataset.online = String(online > 0);
  }

  renderMembers() {
    this.renderMemberChip();
    this.refreshSettings?.();
    const box = this.els.members;
    this.keepFocus(box, () => {
      box.replaceChildren();
      if (this.embassy?.selected) {
        box.append(this.el('h3', 'ca-members-head', 'Shared with other companies'), this.el('p', 'ca-hint', 'External identities are labels, not local employees.'));
        return;
      }
      const room = this.room;
      if (!room || this.app._chatCreating) return;
      for (const section of caMemberSections(room.members)) {
        const h = this.el('h3', 'ca-members-head', `${section.label} — ${section.members.length}`);
        box.append(h);
        for (const m of section.members) box.append(this.memberRow(m));
      }
      if (!caIsDm(room)) box.append(this.addMemberRow());
    });
  }

  memberRow(m) {
    const presence = caPresence(m);
    const state = this.presenceOf(m);
    const b = this.el('button', `ca-member is-${presence} is-state-${state}`);
    b.type = 'button';
    b.dataset.key = `member:${m.sessionId}`;
    b.style.setProperty('--chat-hue', String(this.app._chatAccent(m.sessionId)));
    const role = m.role === 'coordinator' ? 'admin' : 'member';
    const pronouns = this.pronounsOf(m);
    b.setAttribute('aria-label', `${m.name}${pronouns ? ` (${pronouns})` : ''}, ${role}, ${CA_STATE_LABEL[state]}`);
    if (pronouns) b.title = `${m.name} (${pronouns})`;
    b.append(this.app._chatAvatar(m.sessionId, m.name, { size: 'md', state: this.presenceOf(m) }));
    const text = this.el('span', 'ca-member-text');
    const line = this.el('span', 'ca-member-name', m.name);
    text.append(line);
    const alert = this.app._chatAlertBadge?.(m, 'ca-member-alert');
    if (alert) {
      line.append(' ', alert);
      if (this.phoneStatus?.canSetAgents || this.phoneStatus?.self === m.sessionId) {
        alert.setAttribute('role', 'button'); alert.tabIndex = 0;
        alert.setAttribute('aria-label', `${m.name}: ${alert.title}; cycle phone mode`);
        alert.style.cursor = 'pointer';
        alert.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); this.cyclePhoneStatus(m.sessionId, m); });
        alert.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); this.cyclePhoneStatus(m.sessionId, m); }
        });
      }
      // Ring is everyone's default: only a held mode is worth saying aloud.
      if (alert.dataset.alertMode !== 'ring') b.setAttribute('aria-label', `${b.getAttribute('aria-label')}, ${alert.title}`);
    }
    if (m.role === 'coordinator') text.append(this.el('span', 'ca-tag', 'Admin'));
    if (m.voice) text.append(this.el('span', 'ca-tag', 'Voice'));
    // A member that needs you says so in words as well as colour.
    const sub = state === 'needs' ? 'Needs your approval' : state === 'error' ? 'Error' : state === 'waiting' ? 'Waiting for input' : state === 'working' ? 'Working…' : m.progress || m.goal || '';
    if (sub) text.append(this.el('span', 'ca-member-sub', sub));
    b.append(text);
    b.addEventListener('click', () => this.openProfile(m, b));
    b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const r = b.getBoundingClientRect();
      this.openMemberMenu(m, b, { x: ev.clientX || r.left, y: ev.clientY || r.bottom });
    });
    b.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ContextMenu' && !(ev.shiftKey && ev.key === 'F10')) return;
      ev.preventDefault();
      this.openMemberMenu(m, b);
    });
    return b;
  }

  openMemberMenu(m, anchor, at = anchor) {
    this.closeProfile();
    const manage = this.canManageMembers(this.room);
    const appoint = this.canAppointLead(this.room);
    const own = this.app._chatSelf === m.sessionId;
    const remove = manage || own;
    const entries = [
      { label: 'Profile', run: () => this.openProfile(m, anchor) },
    ];
    if (this.serverFeatures.dms && !caIsDm(this.room)) {
      entries.push({ label: 'Message', run: () => this.startDm(m.sessionId) });
    }
    const employee = this.company?.employees?.find(entry => entry.sessionId === m.sessionId);
    if (!this.app._chatSelf && employee && this.company?.canManage === true && this.phoneStatus?.self === 'owner' && this.phoneStatus?.canSetOwn === true) {
      entries.push({ label: 'Restart session', disabled: employee.onVacation === true, reason: employee.onVacation ? 'Return this expert from vacation before restarting' : '', run: () => this.openEmployeeRestart(employee) });
    }
    if (!caIsDm(this.room)) {
      entries.push(
        { sep: true },
        { label: m.role === 'coordinator' ? 'Remove lead' : 'Make lead', disabled: !appoint,
          tip: appoint ? 'Change the room coordinator seat' : '',
          reason: !appoint ? 'Only the owner or a server Admin can change the channel lead' : '',
          run: () => this.app._appointChatCoordinator(m.role === 'coordinator' ? null : m.sessionId) },
        { label: 'Remove from channel', danger: true, disabled: !remove,
          reason: !remove ? 'Only the user or channel lead can remove another member' : '',
          run: () => this.app._removeChatMember(m) },
      );
    }
    entries.push({ sep: true });
    if (this.app.sessions?.has?.(m.sessionId)) {
      entries.push({ label: 'Debug terminal', run: () => this.showDebug(m.sessionId) });
    }
    entries.push({ sep: true }, { label: 'Copy session id', run: async () => {
      try {
        await this.doc.defaultView.navigator.clipboard.writeText(m.sessionId);
        this.toast('Session id copied', 'info');
      } catch {
        this.toast('Could not copy session id', 'error');
      }
    } });
    this.openMenu(entries, { at, focus: anchor, label: `${m.name} actions`, className: 'ca-member-menu' });
  }

  canManageMembers(room = this.room) {
    if (!room || caIsDm(room)) return false;
    const self = this.app._chatSelf;
    return !self || !!room.members.some((m) => m.sessionId === self && m.role === 'coordinator');
  }

  canAppointLead(room = this.room) {
    return !!room && !caIsDm(room) && !this.app._chatSelf;
  }

  addMemberRow() {
    const wrap = this.el('div', 'ca-add');
    if (!this.canManageMembers()) return wrap;
    const add = this.button('ca-icon-btn ca-add-button', 'Add an agent', () => this.openMemberPicker(add), { icon: 'plus' });
    add.setAttribute('aria-haspopup', 'menu');
    wrap.append(add);
    return wrap;
  }

  openMemberPicker(anchor) {
    if (!this.canManageMembers()) return;
    this.closeProfile();
    const roomId = this.roomId;
    const inRoom = new Set(this.room.members.map((m) => m.sessionId));
    const postOnly = new Set((this.rooms || []).flatMap((r) => r.members || []).filter((m) => m.postOnly).map((m) => m.sessionId));
    const candidates = (this.app._chatCandidateSessions?.(inRoom) || [])
      .filter((s) => s.mode !== 'shell' && (
        (Array.isArray(this.serverFeatures.pollingModes) && this.serverFeatures.pollingModes.includes(s.mode)) ||
        (!postOnly.has(s.id) && !this.app.sessions?.get(s.id)?.postOnly)
      ));
    const entries = candidates.map((s) => ({
      label: s.name, hint: s.mode || '', avatar: s,
      run: async () => {
        const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/members`, {
          method: 'POST', body: { sessionId: s.id },
        });
        if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
        if (this.roomId === roomId) {
          await this.app._loadChatRoom(roomId, { quiet: true });
          this.els.members.querySelector('.ca-add-button')?.focus();
        }
      },
    }));
    const menu = this.openMenu(entries, {
      at: anchor, focus: anchor, label: 'Add an agent', className: 'ca-member-picker', restoreFocus: true,
    });
    const empty = this.el('p', 'ca-hint ca-member-empty', 'No other agents to add');
    empty.setAttribute('role', 'status');
    empty.hidden = !!candidates.length;
    menu.append(empty);
    if (candidates.length > 8) {
      const search = this.el('input', 'ca-field ca-member-search');
      search.type = 'search';
      search.placeholder = 'Search agents';
      search.setAttribute('aria-label', 'Search agents');
      search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        const rows = [...menu.querySelectorAll('button')];
        rows.forEach((b, i) => { b.hidden = !`${candidates[i].name} ${candidates[i].mode || ''}`.toLowerCase().includes(query); });
        empty.hidden = rows.some((b) => !b.hidden);
        empty.textContent = 'No agents match';
      });
      menu.prepend(search);
      search.focus();
    }
    this.fitMemberMenu(menu);
  }

  fitMemberMenu(menu) {
    const w = this.doc.defaultView?.innerWidth || 1024;
    const h = this.doc.defaultView?.innerHeight || 768;
    const r = menu.getBoundingClientRect();
    menu.style.top = `${Math.max(8, Math.min(r.top, h - r.height - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, w - r.width - 8))}px`;
  }

  closeProfile() {
    this.els.profile?.remove();
    this.els.profile = null;
    this._profileDismiss && this.doc.removeEventListener('pointerdown', this._profileDismiss, true);
    this._profileKey && this.doc.removeEventListener('keydown', this._profileKey, true);
    this._profileDismiss = this._profileKey = null;
  }

  /** A member's owner-set pronouns: the company record the page loaded, else what the room view carries. */
  pronounsOf(m) {
    return this.profilePronouns?.get(m.sessionId) || (typeof m.pronouns === 'string' ? m.pronouns.trim() : '');
  }

  /** Ask for new pronouns (empty clears them), checked like the server does, then save them. */
  editPronouns(employeeId, m, current) {
    const answer = this.doc.defaultView?.prompt(`Pronouns for ${m.name} (leave empty to clear)`, current || '');
    if (answer === null || answer === undefined) return;
    const text = String(answer).trim();
    if (!text && !current) return;
    const problem = text ? caPronounsProblem(text) : '';
    if (problem) return this.toast(problem, 'error');
    return this.setPronouns(employeeId, m, text || null);
  }

  /** The owner's employee edit (PUT /api/company/employees/:id); null clears the field. */
  async setPronouns(employeeId, m, pronouns) {
    const res = await this.app._chatApi(`/api/company/employees/${encodeURIComponent(employeeId)}`, { method: 'PUT', body: { pronouns } });
    if (!res.ok) return this.toast(`Pronouns: ${res.error}`, 'error');
    this.toast(pronouns ? `${m.name}'s pronouns are now ${pronouns}` : `${m.name}'s pronouns were cleared`, 'info');
    this._profilesAt = 0;
    this.refreshProfiles();
  }

  openProfile(m, anchor) {
    this.closeMenus();
    this.closeProfile();
    const card = this.el('div', 'ca-profile');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `${m.name} profile`);
    card.style.setProperty('--chat-hue', String(this.app._chatAccent(m.sessionId)));
    const top = this.el('div', 'ca-profile-top');
    top.append(this.app._chatAvatar(m.sessionId, m.name, { size: 'md', state: this.presenceOf(m) }));
    const names = this.el('div', 'ca-profile-names');
    names.append(this.literalText('strong', '', m.name));
    const tags = [m.role === 'coordinator' ? 'Admin' : 'Member', CA_STATE_LABEL[this.presenceOf(m)]].filter(Boolean).join(' · ');
    names.append(this.el('span', 'ca-profile-sub', tags));
    // Who they are in the company: position and the owner-set pronouns, from the employee record.
    const employee = (Array.isArray(this.company?.employees) ? this.company.employees : []).find((e) => e?.sessionId === m.sessionId);
    const pronouns = this.pronounsOf(m);
    const who = [typeof employee?.position === 'string' ? employee.position : '', pronouns].filter(Boolean).join(' · ');
    if (who) names.append(this.literalText('span', 'ca-profile-sub ca-profile-who', who));
    top.append(names);
    card.append(top);
    const technical = this.profileSection('Technical details');
    technical.classList.add('ca-profile-technical');
    const diagnosticLabel = label => label === 'Backend' ? 'Harness' : label === 'Account' ? 'Plan' : label;
    const kv = (k, v, target = card) => {
      if (!v) return;
      const row = this.el('div', 'ca-kv');
      row.append(this.el('span', 'ca-k', diagnosticLabel(k)), this.el('span', 'ca-v', v));
      target.append(row);
    };
    const session = this.app.sessions?.get?.(m.sessionId);
    const facts = caAgentFacts(session);
    for (const [k, v] of facts.headline) kv(k, v, technical);
    kv('Goal', m.goal);
    kv('Progress', m.progress ? `${m.progress}${m.updatedAt ? ` · ${this.app._chatAgo(m.updatedAt)}` : ''}` : '');
    if (this.serverFeatures.notify && !caIsDm(this.room)) kv('Wakes on', m.notify === 'mentions' ? 'Only @mentions, replies and you' : 'What the room says', technical);
    // What the page already knows is shown at once; the runtime's fuller profile replaces it when it arrives.
    const local = this.el('div', 'ca-profile-local');
    const full = this.el('div', 'ca-profile-full');
    full.setAttribute('aria-live', 'polite');
    technical.append(local, full);
    const section = (title, rows) => {
      if (!rows.length) return;
      const group = this.profileSection(title);
      for (const [k, v] of rows) {
        const row = this.el('div', 'ca-kv');
        row.append(this.el('span', 'ca-k', diagnosticLabel(k)), this.el('span', 'ca-v', v));
        group.append(row);
      }
      local.append(group);
    };
    section('Runtime', facts.runtime);
    section('Usage', facts.usage);
    if (session?.createdAt) {
      section('Session', [
        ['Started', new Date(session.createdAt).toLocaleString()],
        ...(session.lastActivityAt ? [['Last active', this.app._chatAgo(session.lastActivityAt)]] : []),
      ]);
    }
    const actions = this.el('div', 'ca-profile-actions');
    let actionHost = actions;
    const manage = this.canManageMembers(this.room);
    const own = this.app._chatSelf === m.sessionId;
    const act = (label, fn, primary, tip, reason = '') => {
      const item = this.el('div', 'ca-act-item');
      const b = this.el('button', `ca-btn${primary ? ' is-primary' : ''}`, label);
      b.type = 'button';
      b.disabled = !!reason;
      b.addEventListener('click', () => {
        this.closeProfile();
        fn();
      });
      item.append(b);
      if (tip) this.describeButton(item, b, reason || tip);
      actionHost.append(item);
    };
    if (this.serverFeatures.dms && !caIsDm(this.room)) act('Message', () => this.startDm(m.sessionId), true, 'Start a private chat with this agent');
    if (!this.app._chatSelf && employee && this.company?.canManage === true && this.phoneStatus?.self === 'owner' && this.phoneStatus?.canSetOwn === true) {
      act('Runtime settings', () => this.openRuntimeSettings(employee), false, 'Change this expert’s plan, harness, model and effort');
      act('Edit profile', () => this.openEmployeeProfile(employee, () => {
        this._profilesAt = 0;
        this.refreshProfiles();
      }), false, 'Edit this expert’s picture and optional profile details');
      act('Restart session', () => this.openEmployeeRestart(employee), false, 'Restart this expert’s session while keeping their identity and channels', employee.onVacation ? 'Return this expert from vacation before restarting' : '');
    }
    const secondary = this.el('div', 'ca-profile-secondary'); actions.append(secondary); actionHost = secondary;
    if (this.app.sessions?.has?.(m.sessionId)) act('Debug terminal', () => this.showDebug(m.sessionId), false, "Open this agent's live terminal");
    if (!caIsDm(this.room)) {
      if (m.role !== 'coordinator') act('Make lead', () => this.app._appointChatCoordinator(m.sessionId), false, 'Change the room coordinator seat', !this.canAppointLead(this.room) ? 'Only the owner or a server Admin can change the channel lead' : '');
      act(m.voice ? 'Remove voice' : 'Make voice', () => this.app._setChatMemberVoice(m.sessionId, !m.voice), false, m.voice ? 'Stop this agent answering push-to-talk' : 'This agent answers push-to-talk in this room');
      if (this.serverFeatures.replace && !m.postOnly && m.alive === false) {
        act('Move to new session', () => this.openReplaceDialog(m), false, "Give this offline agent's place in every room to its new session");
      }
      act('Remove from channel', () => this.app._removeChatMember(m), false, 'Take this agent out of this channel', !manage && !own ? 'Only the user or channel lead can remove another member' : '');
    }
    // Hover has no touch equivalent, so on a touch screen an (i) toggle shows each button's one-liner under it.
    if (this.doc.defaultView?.matchMedia?.('(hover: none)')?.matches) {
      const toggle = this.button('ca-btn ca-tips-toggle', 'Show what each button does', () => {
        const on = card.classList.toggle('show-tips');
        toggle.setAttribute('aria-pressed', String(on));
      }, { text: '\u24D8 What do these buttons do?' });
      toggle.setAttribute('aria-pressed', 'false');
      card.append(toggle);
    }
    card.append(actions, technical);
    this.presentCard(card, anchor);
    this.loadAgentProfile(m, card, local, full);
  }

  /**
   * A one-line description of a button: the tooltip on hover, read out with the button (`aria-describedby`), and shown under it when the
   * card's (i) toggle is on.
   */
  describeButton(item, button, text) {
    this._tipCount = (this._tipCount || 0) + 1;
    const tip = this.el('span', 'ca-tip', text);
    tip.id = `ca-tip-${this._tipCount}`;
    button.title = text;
    button.setAttribute('aria-describedby', tip.id);
    item.append(tip);
  }

  profileSection(title) {
    const group = this.el('details', 'ca-profile-group');
    group.append(this.el('summary', 'ca-profile-section', title));
    return group;
  }

  /** Fetch the runtime's read-only profile for an agent and show it in its card (the local facts stay if it fails). */
  async loadAgentProfile(m, card, local, full) {
    full.replaceChildren(this.el('p', 'ca-hint', 'Loading the full profile\u2026'));
    const res = await this.app._chatApi(`/api/agents/${encodeURIComponent(m.sessionId)}/profile`);
    if (!card.isConnected) return;
    if (!res.ok) {
      if (this.company?.employees?.some(employee => employee.sessionId === m.sessionId)) { full.replaceChildren(); return; }
      full.replaceChildren(this.el('p', 'ca-hint', 'The technical profile is unavailable.'));
      return;
    }
    const profile = caAgentProfile(res.data);
    full.replaceChildren();
    if (profile.persona) {
      const about = this.profileSection('About');
      const head = [profile.persona.name, profile.persona.role, profile.persona.kind].filter(Boolean).join(' \u00B7 ');
      if (head) about.append(this.el('p', 'ca-persona-head', head));
      if (profile.persona.text) about.append(this.el('p', 'ca-persona', profile.persona.text));
      full.append(about);
    } else if (profile.personaError && !this.company?.employees?.some(employee => employee.sessionId === m.sessionId)) {
      full.append(this.el('p', 'ca-hint', 'Personality details are unavailable.'));
    }
    for (const sec of profile.sections) {
      const group = this.profileSection(sec.title === 'Channels' ? `Channels · in ${sec.rows.length} channels` : sec.title);
      for (const [k, v] of sec.rows) {
        const row = this.el('div', 'ca-kv');
        row.append(this.el('span', 'ca-k', k === 'Backend' ? 'Harness' : k === 'Account' ? 'Plan' : k), sec.title === 'Role' ? this.literalText('span', 'ca-v', v) : this.el('span', 'ca-v', v));
        group.append(row);
      }
      full.append(group);
    }
    if (profile.switchInfo && !this.app._chatSelf && !this.company?.employees?.some(employee => employee.sessionId === m.sessionId)) {
      const group = this.profileSection('Harness switch');
      group.append(this.switchEl(profile.switchInfo));
      full.append(group);
    }
    if (profile.sections.length || profile.persona || profile.switchInfo) local.remove();
  }

  /** The backend switch: shown, and disabled with the runtime's own reason while switching is not available. */
  switchEl(info) {
    const box = this.el('div', 'ca-switch');
    box.append(this.el('h3', 'ca-profile-section', 'Harness'));
    const label = this.el('label', 'ca-label');
    label.append(this.el('span', '', 'Switch harness'));
    const sel = this.el('select', 'ca-field');
    sel.disabled = !info.available;
    for (const b of info.backends) {
      const o = new Option(`${b.name}${b.model ? ` \u00B7 ${b.model}` : ''}${b.enabled ? '' : ' (off)'}`, b.name);
      o.disabled = !b.enabled;
      sel.append(o);
    }
    if (!info.backends.length) sel.append(new Option(info.current || 'unknown', ''));
    sel.value = info.current && [...sel.options].some((o) => o.value === info.current) ? info.current : sel.value;
    label.append(sel);
    const go = this.el('button', 'ca-btn', 'Switch');
    go.type = 'button';
    go.disabled = true;
    box.append(label, go, this.el('p', 'ca-hint ca-switch-reason', info.reason));
    return box;
  }

  /** Put a card beside its anchor, dismissed by an outside click or Escape, Tab kept inside. */
  presentCard(card, anchor) {
    this.doc.body.append(card);
    const a = anchor.getBoundingClientRect();
    const w = this.doc.defaultView?.innerWidth || 1024;
    const h = this.doc.defaultView?.innerHeight || 768;
    if (w <= CA_SHEET_MAX_WIDTH) {
      // A phone has no room beside the row: the card is a sheet at the bottom of the screen, as wide as the screen (CSS).
      card.classList.add('ca-profile--sheet');
    } else {
      const top = Math.max(8, Math.min(a.top, h - card.getBoundingClientRect().height - 8));
      card.style.top = `${top}px`;
      card.style.maxHeight = `${h - top - 8}px`;
      // Left of the row, but never past the left edge of the window (a narrow window used to put it half off-screen).
      card.style.right = `${Math.min(Math.max(8, w - a.left + 8), Math.max(8, w - CA_CARD_WIDTH - 8))}px`;
    }
    if (anchor.classList?.contains('ca-user-btn') && w > CA_SHEET_MAX_WIDTH) {
      card.style.top = 'auto';
      card.style.right = 'auto';
      card.style.left = `${Math.max(8, a.left)}px`;
      card.style.bottom = `${Math.max(8, h - a.top + 8)}px`;
      card.style.maxHeight = `${Math.max(0, a.top - 16)}px`;
    }
    this.els.profile = card;
    this._profileDismiss = (e) => {
      if (!card.contains(e.target)) this.closeProfile();
    };
    this._profileKey = (e) => {
      if (e.key === 'Escape') {
        this.closeProfile();
        anchor.focus?.();
        return;
      }
      if (e.key !== 'Tab') return;
      // The card is modal in spirit: Tab and Shift+Tab stay inside it until it is closed.
      const items = [...card.querySelectorAll('button, summary, select, input:not([type="hidden"]), textarea, a[href]')]
        .filter((b) => !b.disabled && !b.hidden && !b.closest('details:not([open]) > :not(summary)'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = this.doc.activeElement;
      if (!card.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    this.doc.addEventListener('pointerdown', this._profileDismiss, true);
    this.doc.addEventListener('keydown', this._profileKey, true);
    card.querySelector('button')?.focus();
  }

  /** The card over your name: how you look, with a way to edit it. */
  openMyProfile(anchor) {
    this.closeProfile();
    const p = this.profile;
    const name = this.userName();
    const card = this.el('div', 'ca-profile ca-me-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Your profile');
    card.style.setProperty('--chat-hue', String(p.hue ?? this.app._chatHue(name)));
    card.append(this.el('div', 'ca-me-banner'));
    const top = this.el('div', 'ca-profile-top');
    top.append(this.userAvatar('md', 'online'));
    const names = this.el('div', 'ca-profile-names');
    names.append(this.el('strong', '', name));
    const account = this.doc.defaultView?.__reverieUser?.username;
    const sub = [account && account !== name ? account : '', p.pronouns].filter(Boolean).join(' \u2022 ');
    if (sub) names.append(this.el('span', 'ca-profile-sub', sub));
    top.append(names);
    card.append(top);
    if (p.status) card.append(this.el('p', 'ca-me-status', p.status));
    const actions = this.el('div', 'ca-profile-actions');
    const edit = this.el('button', 'ca-btn is-primary', 'Edit profile');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      this.closeProfile();
      this.openProfileEditor();
    });
    actions.append(edit);
    card.append(actions);
    this.presentCard(card, anchor);
  }

  /**
   * Store the name as the company's owner name. The settings are replaced as a whole by the server, so the
   * current ones are sent back with only the name changed.
   */
  async saveOwnerName(ownerName, { quiet = false } = {}) {
    // Read the settings again now: the server replaces them as a whole, so the copy from startup could be stale.
    const fresh = await this.app._chatApi('/api/company');
    const current = fresh.ok ? fresh.data?.settings : null;
    if (!current) { if (!quiet) this.toast('Could not read the instance settings, so only this browser has the name', 'error'); return false; }
    this.company = fresh.data;
    const { owner: _owner, ...rest } = current;
    const res = await this.app._chatApi('/api/company/settings', { method: 'PUT', body: { ...rest, ownerName } });
    if (!res.ok) { if (!quiet) this.toast(`Chat: ${res.error} (the name is saved in this browser only)`, 'error'); return false; }
    this.company = { ...this.company, settings: { ...current, ownerName } };
    this.ownerName = ownerName;
    this.renderUser();
    return true;
  }

  /**
   * A "choose a picture" row: a preview, Choose and Remove. `value()` is the data URL (or '' for none); `onChange` runs after a pick or removal.
   */
  expertVoiceFields(form, pronouns, name, current) {
    const win = this.doc.defaultView;
    const wrap = this.el('label', 'ca-label'); wrap.append(this.el('span', 'ca-label-text', 'Voice'));
    const select = this.el('select', 'ca-field'); select.name = 'voice'; select.setAttribute('aria-label', 'Voice');
    const play = this.el('button', 'ca-btn', 'Play sample'); play.type = 'button';
    const note = this.el('span', 'ca-hint'); note.setAttribute('role', 'status');
    wrap.append(select, play, note); form.append(wrap);
    let serverVoices = [], stop = null;
    const key = voice => voice ? JSON.stringify({ provider: voice.provider, id: voice.id }) : '';
    const populate = () => {
      const previous = select.options.length ? select.value : key(current);
      const automatic = this.el('option', '', 'Automatic (based on profile)'); automatic.value = '';
      select.replaceChildren(automatic);
      const browser = (win.speechSynthesis?.getVoices?.() || []).map(voice => ({ provider: 'browser', id: voice.voiceURI || voice.name, label: voice.name, language: voice.lang }));
      const options = new Map([...serverVoices, ...browser].map(voice => [key(voice), voice]));
      if (previous && !options.has(previous)) {
        try { const voice = JSON.parse(previous); options.set(previous, { ...voice, label: `${voice.id} (saved voice)` }); } catch { /* Invalid saved data stays automatic. */ }
      }
      for (const [id, voice] of options) {
        const option = this.el('option', '', `${voice.label}${voice.language ? ` · ${voice.language}` : ''} (${voice.provider === 'browser' ? 'this device' : voice.provider})`);
        option.value = id; select.append(option);
      }
      select.value = previous;
      note.textContent = options.size ? 'Pronouns may suggest a default. Your selected voice takes precedence.' : 'No voices available yet. Connect a voice service or enable speech voices on this device.';
    };
    const value = () => { try { return select.value ? JSON.parse(select.value) : null; } catch { return null; } };
    const done = () => { stop = null; play.textContent = 'Play sample'; };
    select.addEventListener('focus', populate);
    play.addEventListener('click', async () => {
      if (stop) { stop(); done(); return; }
      note.textContent = '';
      const selected = value();
      try {
        if (!selected || selected.provider === 'browser') {
          const synth = win.speechSynthesis;
          if (!synth || !win.SpeechSynthesisUtterance) throw new Error('Speech voices are not available on this device.');
          const voices = synth.getVoices();
          const voice = selected ? voices.find(voice => (voice.voiceURI || voice.name) === selected.id) : win.carModePickVoice?.(voices, '', name.value || 'expert', pronouns.value);
          if (selected && !voice) throw new Error('This saved voice is not installed on this device. Choose another voice.');
          const utterance = new win.SpeechSynthesisUtterance('Hello! I am ready to help. This is a sample of my voice.');
          if (voice) utterance.voice = voice;
          utterance.onend = done; utterance.onerror = () => { done(); note.textContent = 'The sample could not be played.'; };
          stop = () => synth.cancel(); play.textContent = 'Stop sample'; synth.speak(utterance);
        } else {
          play.disabled = true;
          const result = await this.app._chatApi('/api/voice/preview', { method: 'POST', body: { voice: selected } });
          if (!result.ok || !result.data?.audioUrl) throw new Error(result.error || 'The voice sample is unavailable.');
          const audio = new win.Audio(result.data.audioUrl);
          audio.onended = done; audio.onerror = () => { done(); note.textContent = 'The sample could not be played.'; };
          stop = () => audio.pause(); play.textContent = 'Stop sample'; await audio.play();
        }
      } catch (error) { done(); note.textContent = error.message || 'The sample could not be played.'; }
      finally { play.disabled = false; }
    });
    populate();
    void this.app._chatApi('/api/voice/options').then(result => {
      if (result.ok && Array.isArray(result.data?.voices)) serverVoices = result.data.voices;
      populate();
    }).catch(() => {});
    return { value };
  }

  expertInitial(name) {
    return Array.from((name || '').trim())[0]?.toUpperCase().slice(0, 2) || '?';
  }

  /** Pictures are optional; initials provide a quiet fallback. */
  expertAppearanceFields(form, currentPhoto = '', { name, random = false } = {}) {
    let intent = 0, converting = null;
    const picture = this.pictureField('Profile picture', currentPhoto, () => {}, {
      fallback: () => this.expertInitial(name?.value), alwaysRemove: true,
      onIntent: () => { intent++; converting = null; },
    });
    const [upload, initials] = picture.wrap.querySelectorAll('button');
    upload.textContent = 'Upload picture'; initials.textContent = 'Use initials';
    name?.addEventListener?.('input', picture.refresh);
    form.append(picture.wrap);
    const select = async (avatar, automatic = false) => {
      const ticket = automatic ? intent : ++intent;
      if (!automatic) { converting = null; picture.cancelPending(); }
      try {
        const response = await this.doc.defaultView.fetch(avatar.src);
        if (!response.ok) throw new Error('Picture unavailable');
        const blob = await response.blob();
        if (ticket !== intent || !form.isConnected) return false;
        converting = ticket;
        const image = await this.imageToIcon(blob);
        if (ticket !== intent || !form.isConnected) return false;
        picture.set(image);
        return true;
      } catch {
        if (!automatic && ticket === intent) this.toast('The avatar could not be loaded. Try again or upload a picture.', 'error');
        return false;
      } finally { if (converting === ticket) converting = null; }
    };
    const initialIntent = intent;
    const pack = (async () => {
      try {
        const response = await this.doc.defaultView.fetch('/assets/avatars/pack-manifest.json');
        if (!response.ok) return [];
        const manifest = await response.json();
        const avatars = (Array.isArray(manifest.avatars) ? manifest.avatars : []).filter(avatar => avatar && /^pack-(?:0[1-9]|[1-4][0-9]|50)$/.test(avatar.id) && avatar.src === `/assets/avatars/${avatar.id}.png`);
        if (random && avatars.length && intent === initialIntent && !picture.value()) void select(avatars[Math.floor(Math.random() * avatars.length)], true);
        return avatars;
      } catch { return []; }
    })();
    const choose = this.button('ca-btn', 'Choose avatar', async () => {
      if (this.doc.querySelector('.ca-avatar-dialog')) return;
      intent++; converting = null; picture.cancelPending();
      const dialog = this.el('dialog', 'ca-dialog ca-avatar-dialog');
      dialog.setAttribute('aria-label', 'Choose avatar');
      dialog.append(this.el('h2', '', 'Choose an avatar'));
      const gallery = this.el('div', 'ca-expert-portraits');
      gallery.setAttribute('role', 'group'); gallery.setAttribute('aria-label', 'Expert illustrations');
      const note = this.el('p', 'ca-hint', 'Loading avatars…'); note.setAttribute('role', 'status');
      const close = () => { intent++; converting = null; dialog.close(); };
      const cancel = this.button('ca-btn', 'Cancel', close, { text: 'Cancel' });
      const actions = this.el('div', 'ca-dialog-actions'); actions.append(cancel);
      dialog.append(note, gallery, actions);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('close', () => { intent++; converting = null; dialog.remove(); choose.focus(); });
      this.doc.body.append(dialog); dialog.showModal(); cancel.focus();
      const avatars = await pack;
      if (!dialog.isConnected) return;
      note.textContent = avatars.length ? '' : 'Avatars are unavailable. You can still upload a picture or use initials.';
      for (const avatar of avatars) {
        const button = this.button('ca-btn', `Use ${avatar.name}`, async () => { if (await select(avatar) && dialog.isConnected) dialog.close(); });
        button.title = avatar.name;
        const image = this.el('img'); image.src = avatar.src; image.alt = ''; image.loading = 'lazy'; image.width = image.height = 56;
        button.append(image); gallery.append(button);
      }
    }, { text: 'Choose avatar' });
    initials.before(choose);
    return { picture, pending: () => converting !== null || picture.pending() };
  }

  async saveEmployeePicture(sessionId, image) {
    try {
      const url = `/api/company/agents/${encodeURIComponent(sessionId)}/avatar`;
      if (!image) return (await this.doc.defaultView.fetch(url, { method: 'DELETE' })).ok;
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!match) return false;
      const binary = this.doc.defaultView.atob(match[2]);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return (await this.doc.defaultView.fetch(url, { method: 'POST', headers: { 'Content-Type': match[1] }, body: bytes })).ok;
    } catch { return false; }
  }

  async openEmployeeRestart(employee, onSaved) {
    const existing = this.doc.querySelector('.ca-employee-restart');
    if (existing) { existing.querySelector('button')?.focus(); return; }
    this._restartingEmployees ||= new Set();
    if (this._restartingEmployees.has(employee.id)) return this.toast(`A restart is already in progress for ${employee.name}.`, 'info');
    const dialog = this.el('dialog', 'ca-dialog ca-company-confirm ca-employee-restart');
    dialog.setAttribute('aria-label', `Restart session: ${employee.name}`);
    dialog.append(this.literalText('h2', '', `Restart session · ${employee.name}`), this.literalText('p', 'ca-dialog-note', `Restart ${employee.name} using their saved runtime settings? Their expert identity, memory and channel memberships stay the same. Wait for any current work to finish first.`));
    const error = this.el('p', 'ca-company-error'); error.setAttribute('role', 'alert');
    const status = this.el('p', 'ca-hint', 'Checking owner access…'); status.setAttribute('role', 'status');
    const actions = this.el('div', 'ca-dialog-actions');
    const cancel = this.button('ca-btn', 'Cancel', () => dialog.close(), { text: 'Cancel' }); cancel.autofocus = true;
    const restart = this.button('ca-btn is-primary', 'Restart session', async () => {
      if (restart.disabled || this._restartingEmployees.has(employee.id)) return;
      this._restartingEmployees.add(employee.id); restart.disabled = true; error.textContent = ''; status.textContent = 'Restarting session…';
      try {
        const result = await this.app._chatApi(`/api/company/employees/${encodeURIComponent(employee.id)}/restart`, { method: 'POST', body: {} });
        if (!result.ok) { error.textContent = result.error || 'The session could not restart. Check Runtime settings, then try again.'; status.textContent = ''; return; }
        await this.loadOwner(); await onSaved?.(); dialog.close(); this.toast(`Session restarted for ${employee.name}.`, 'info');
      } catch { error.textContent = 'The restart could not be confirmed. Check the expert’s status before trying again.'; status.textContent = ''; }
      finally { this._restartingEmployees.delete(employee.id); restart.disabled = false; }
    }, { text: 'Restart session' });
    restart.disabled = true; actions.append(cancel, restart); dialog.append(status, error, actions);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove()); this.doc.body.append(dialog); dialog.showModal(); cancel.focus();
    try {
      const auth = await this.app._chatApi('/api/chatrooms/phone-status');
      if (!dialog.isConnected) return;
      status.textContent = '';
      if (this.app._chatSelf || this.company?.canManage !== true || !auth.ok || auth.data?.self !== 'owner' || auth.data?.canSetOwn !== true) error.textContent = 'Sign in as the owner to restart this session.';
      else if (employee.onVacation) error.textContent = 'Return this expert from vacation before restarting.';
      else restart.disabled = false;
    } catch { if (dialog.isConnected) { status.textContent = ''; error.textContent = 'Owner access could not be checked. Close this dialog and try again.'; } }
  }

  async openRuntimeSettings(employee, onSaved) {
    const existing = this.doc.querySelector('.ca-runtime-settings');
    if (existing) { existing.querySelector('button')?.focus(); return; }
    const dialog = this.el('dialog', 'ca-dialog ca-runtime-settings');
    dialog.setAttribute('aria-label', `Runtime settings: ${employee.name}`);
    dialog.append(this.literalText('h2', '', `Runtime settings · ${employee.name}`), this.el('p', 'ca-dialog-note', 'Changes restart this expert’s runtime. Their identity, memory and channel memberships stay with them.'));
    const status = this.el('p', 'ca-hint', 'Loading runtime settings…'); status.setAttribute('role', 'status');
    const error = this.el('p', 'ca-company-error'); error.setAttribute('role', 'alert');
    const body = this.el('div');
    const close = this.button('ca-btn', 'Close runtime settings', () => dialog.close(), { text: 'Close' });
    dialog.append(status, error, body, close);
    dialog.addEventListener('close', () => { this._companyConfirm?.(false); dialog.remove(); });
    this.doc.body.append(dialog); dialog.showModal(); close.focus();
    try {
      const path = `/api/sessions/${encodeURIComponent(employee.sessionId)}/runtime`;
      const [runtime, options, auth] = await Promise.all([this.app._chatApi(path), this.app._chatApi('/api/company/hire-options'), this.app._chatApi('/api/chatrooms/phone-status')]);
      if (!dialog.isConnected) return;
      if (this.app._chatSelf || this.company?.canManage !== true || !auth.ok || auth.data?.self !== 'owner' || auth.data?.canSetOwn !== true) throw new Error('Sign in as the owner to change runtime settings.');
      if (!runtime.ok) throw new Error(runtime.error || 'Runtime settings are unavailable.');
      if (!options.ok) throw new Error(options.error || 'Plans and harnesses are unavailable.');
      const current = runtime.data || {};
      const sources = Array.isArray(options.data?.sources) ? options.data.sources : [];
      const harnesses = Array.isArray(options.data?.harnesses) ? options.data.harnesses : [];
      const form = this.el('form', 'ca-runtime-form');
      const field = (name, label, tag = 'input') => {
        const wrap = this.el('label', 'ca-label');
        const input = this.el(tag, 'ca-field'); input.name = name; input.setAttribute('aria-label', label);
        wrap.append(this.el('span', 'ca-label-text', label), input); form.append(wrap); return input;
      };
      const plan = field('source', 'Plan', 'select'); plan.required = true;
      const placeholder = this.el('option', '', 'Choose a plan or local model'); placeholder.value = ''; plan.append(placeholder);
      for (const source of sources) {
        const option = this.literalText('option', '', `${source.label}${source.kind === 'local' ? ' · Local model' : ''}`);
        option.value = `${source.kind}:${source.id}`; option.disabled = !source.modes?.length; plan.append(option);
      }
      const currentKey = current.source?.kind === 'subscription' ? `subscription:${current.source.profileId}` : current.source?.kind === 'local' ? `local:${current.source.endpointId}` : '';
      if (currentKey && !sources.some(source => `${source.kind}:${source.id}` === currentKey)) {
        const unavailable = this.el('option', '', 'Current plan unavailable'); unavailable.value = currentKey; unavailable.disabled = true; plan.append(unavailable);
      }
      plan.value = currentKey;
      const harness = field('mode', 'Harness', 'select'); harness.required = true;
      const model = field('model', 'Model'); model.maxLength = 100;
      const models = this.el('datalist'); models.id = 'ca-runtime-models'; model.setAttribute('list', models.id); form.append(models);
      const effort = field('effort', 'Effort', 'select');
      const source = () => sources.find(entry => `${entry.kind}:${entry.id}` === plan.value);
      const compatible = () => !!source()?.modes?.includes(harness.value) && harnesses.some(entry => entry.id === harness.value);
      const apply = this.el('button', 'ca-btn is-primary', 'Apply runtime settings'); apply.type = 'submit';
      const updateEffort = value => {
        effort.replaceChildren();
        const automatic = this.el('option', '', 'Harness default'); automatic.value = ''; effort.append(automatic);
        const values = harnesses.find(entry => entry.id === harness.value)?.efforts || [];
        for (const entry of values) { const option = this.el('option', '', entry); option.value = entry; effort.append(option); }
        effort.value = values.includes(value) ? value : ''; effort.disabled = !values.length;
      };
      const updateSource = initial => {
        const selected = source(); const previous = initial ? current.mode : selected?.defaultMode || selected?.modes?.[0];
        harness.replaceChildren();
        const empty = this.el('option', '', 'Choose a harness'); empty.value = ''; harness.append(empty);
        for (const id of selected?.modes || []) {
          const entry = harnesses.find(item => item.id === id); if (!entry) continue;
          const option = this.literalText('option', '', entry.label); option.value = id; harness.append(option);
        }
        harness.value = [...harness.options].some(option => option.value === previous) ? previous : initial ? '' : harness.options[1]?.value || '';
        harness.disabled = harness.options.length < 2;
        model.value = initial ? current.model || '' : selected?.defaultModel || '';
        model.required = selected?.kind === 'local'; model.placeholder = selected?.kind === 'local' ? 'Choose a local model' : 'Leave empty for the harness default';
        models.replaceChildren(); for (const id of selected?.models || []) { const option = this.el('option'); option.value = id; models.append(option); }
        updateEffort(initial ? current.effort : ''); apply.disabled = !compatible();
      };
      plan.addEventListener('change', () => updateSource(false));
      harness.addEventListener('change', () => { model.value = source()?.defaultModel || ''; updateEffort(''); apply.disabled = !compatible(); });
      updateSource(true);
      const actions = this.el('div', 'ca-dialog-actions'); actions.append(apply); form.append(actions);
      let saving = false;
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (saving || !form.reportValidity()) return;
        if (!compatible()) { error.textContent = 'Choose a compatible plan and harness.'; return; }
        saving = true; apply.disabled = true; error.textContent = ''; status.textContent = '';
        const selected = source();
        const payload = { mode: harness.value, source: selected.kind === 'local' ? { kind: 'local', endpointId: selected.id } : { kind: 'subscription', profileId: selected.id }, ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(effort.value ? { effort: effort.value } : {}) };
        try {
          if (!await this.confirmCompanyAction(employee.name, `Apply runtime settings for ${employee.name}? This restarts their runtime using ${selected.label} and ${harness.selectedOptions[0].textContent}. Their identity, memory and channel memberships stay the same.`, 'Apply runtime settings') || !dialog.isConnected) return;
          const result = await this.app._chatApi(path, { method: 'POST', body: payload });
          if (!result.ok) { error.textContent = result.error || 'Runtime settings could not be applied.'; return; }
          await this.loadOwner(); await onSaved?.(); dialog.close();
          this.toast(`Runtime settings updated for ${employee.name}.`, 'info');
        } catch { error.textContent = 'Runtime settings could not be applied. Check the current runtime before trying again.'; }
        finally { saving = false; apply.disabled = !compatible(); }
      });
      body.append(form); status.textContent = '';
    } catch (failure) { if (dialog.isConnected) { status.textContent = ''; error.textContent = failure.message || 'Runtime settings are unavailable.'; } }
  }

  openEmployeeProfile(employee, onSaved) {
    this.doc.querySelector('.ca-expert-profile')?.remove();
    const dialog = this.el('dialog', 'ca-dialog ca-expert-profile');
    dialog.setAttribute('aria-label', `Edit profile: ${employee.name}`);
    dialog.append(this.literalText('h2', '', employee.name));
    dialog.append(this.button('ca-btn', 'Runtime settings', () => this.openRuntimeSettings(employee, onSaved), { text: 'Runtime settings' }));
    const form = this.el('form');
    const pronounLabel = this.el('label', 'ca-label'); pronounLabel.append(this.el('span', 'ca-label-text', 'Pronouns (optional)'));
    const pronouns = this.el('input', 'ca-field'); pronouns.name = 'pronouns'; pronouns.maxLength = 24; pronouns.value = employee.pronouns || ''; pronouns.placeholder = 'e.g. they/them'; pronounLabel.append(pronouns); form.append(pronounLabel);
    const voice = this.expertVoiceFields(form, pronouns, { value: employee.name }, employee.voice);
    const appearance = this.expertAppearanceFields(form, employee.avatar || '', { name: { value: employee.name } });
    const error = this.el('p', 'ca-company-error'); error.setAttribute('role', 'alert');
    const save = this.el('button', 'ca-btn is-primary', 'Save profile'); save.type = 'submit';
    const cancel = this.el('button', 'ca-btn', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    form.append(error, save, cancel);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled || appearance.pending()) return;
      save.disabled = true;
      try {
        const changed = await this.app._chatApi(`/api/company/employees/${encodeURIComponent(employee.id)}`, { method: 'PUT', body: { icon: this.expertInitial(employee.name), pronouns: pronouns.value.trim() || null, voice: voice.value() || null } });
        if (!changed.ok) { error.textContent = changed.error || 'Profile could not be saved.'; return; }
        if (appearance.picture.value() !== (employee.avatar || '') && !await this.saveEmployeePicture(employee.sessionId, appearance.picture.value())) {
          error.textContent = 'The profile picture could not be saved. Try again.'; return;
        }
        await this.loadOwner(); await onSaved?.(); dialog.close();
      } catch { error.textContent = 'Profile could not be saved. Try again.'; }
      finally { save.disabled = false; }
    });
    dialog.append(form); dialog.addEventListener('close', () => dialog.remove()); this.doc.body.append(dialog); dialog.showModal();
  }

  /** Company marks share the existing upload, preview and workspace-picture persistence. */
  workspaceLogoField(current, onChange) {
    const picture = this.pictureField('Company logo (optional)', current, onChange);
    picture.wrap.append(this.el('p', 'ca-hint', 'Choose a logo or upload your own. Remove the picture to use the first letter or your chosen icon.'));
    const choices = this.el('div', 'ca-company-logos');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', 'Company logos');
    picture.wrap.append(choices);
    let loading = false;
    const load = async () => {
      try {
        const response = await this.doc.defaultView.fetch('/assets/company-logos/pack-manifest.json', { cache: 'no-cache' });
        if (!response.ok) return;
        const manifest = await response.json();
        if (manifest.version !== 1 || !Array.isArray(manifest.logos)) return;
        const revision = manifest.revision === undefined ? '1' : manifest.revision;
        if (typeof revision !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(revision)) return;
        const seen = new Set();
        for (const logo of manifest.logos.slice(0, 100)) {
          if (!logo || !/^company-(?:0[1-9]|1[0-2])$/.test(logo.id) ||
              logo.src !== `/assets/company-logos/${logo.id}.png` ||
              typeof logo.name !== 'string' || !logo.name.trim() || logo.name.length > 80 || seen.has(logo.id)) continue;
          seen.add(logo.id);
          const src = `${logo.src}?rev=${encodeURIComponent(revision)}`;
          const button = this.el('button', 'ca-btn');
          button.type = 'button';
          button.setAttribute('aria-label', `Use ${logo.name} logo`);
          button.title = logo.name;
          const image = this.el('img');
          image.src = src; image.alt = ''; image.loading = 'lazy';
          image.width = image.height = 56;
          button.append(image);
          button.addEventListener('click', async () => {
            if (loading || picture.pending()) return;
            loading = true; button.disabled = true;
            try {
              const selected = await this.doc.defaultView.fetch(src);
              if (!selected.ok) throw new Error('Logo unavailable');
              const value = await this.imageToIcon(await selected.blob());
              picture.set(value);
              onChange(value);
            } catch {
              this.toast('The logo could not be loaded. Try again or upload your own.', 'error');
            } finally {
              loading = false; button.disabled = false;
            }
          });
          choices.append(button);
        }
      } catch { /* The upload and initial remain available if the logo pack cannot load. */ }
    };
    void load();
    return { ...picture, pending: () => loading || picture.pending() };
  }

  pictureField(label, current, onChange, { fallback, alwaysRemove = false, onIntent } = {}) {
    const wrap = this.el('div', 'ca-label ca-picture');
    wrap.append(this.el('span', 'ca-label-text', label));
    const row = this.el('div', 'ca-picture-row');
    let image = current || '';
    let loading = false;
    let revision = 0;
    const preview = this.el('span', 'ca-picture-preview');
    const input = this.el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.hidden = true;
    const choose = this.el('button', 'ca-btn', 'Choose picture');
    choose.type = 'button';
    const remove = this.el('button', 'ca-btn', 'Remove');
    remove.type = 'button';
    const note = this.el('span', 'ca-hint');
    note.setAttribute('role', 'status');
    const paint = () => {
      preview.replaceChildren();
      const src = this.iconImage(image);
      if (src) {
        const img = this.el('img', 'chatroom-avatar-img');
        img.alt = '';
        img.src = src;
        preview.append(img);
      } else preview.append(this.el('span', fallback ? 'chatroom-avatar-glyph' : 'ca-hint', fallback ? fallback() : 'none'));
      remove.hidden = !alwaysRemove && !src;
    };
    choose.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const ticket = ++revision;
      onIntent?.();
      loading = true;
      try {
        const converted = await this.imageToIcon(file);
        if (ticket !== revision) return;
        image = converted;
        note.textContent = '';
        paint();
        onChange(image);
      } catch (e) {
        if (ticket === revision) note.textContent = e?.message || 'That picture could not be used';
      } finally { if (ticket === revision) loading = false; }
    });
    remove.addEventListener('click', () => {
      revision++; loading = false; onIntent?.();
      image = '';
      paint();
      onChange('');
    });
    paint();
    row.append(preview, choose, remove, input);
    wrap.append(row, note);
    return { wrap, value: () => image, pending: () => loading, refresh: paint, cancelPending: () => { revision++; loading = false; }, set: (v) => { revision++; loading = false; image = v || ''; paint(); } };
  }

  openProfileEditor({ firstRun = false } = {}) {
    this.doc.querySelector('.ca-dialog.ca-profile-edit')?.remove();
    const p = this.profile;
    const dlg = this.el('dialog', 'ca-dialog ca-profile-edit');
    dlg.setAttribute('aria-label', firstRun ? 'Your name' : 'Edit profile');
    dlg.append(this.el('h2', '', firstRun ? 'What should we call you?' : 'Edit profile'));
    dlg.append(this.el('p', 'ca-dialog-note', firstRun ? 'Your name appears in chat and your organization. You can change it later in your profile.' : 'Your name and picture appear with your messages.'));
    const form = this.el('form', 'ca-form');
    const field = (label, value, max, placeholder = '') => {
      const wrap = this.el('label', 'ca-label');
      wrap.append(this.el('span', '', label));
      const input = this.el('input', 'ca-field');
      input.maxLength = max;
      input.value = value || '';
      input.placeholder = placeholder;
      wrap.append(input);
      return { wrap, input };
    };
    const fallback = this.ownerName || this.doc.defaultView?.__reverieUser?.username || 'You';
    const name = field(firstRun ? 'Your name' : 'Display name', p.name || (firstRun ? '' : fallback), firstRun ? 100 : 32, firstRun ? '' : fallback);
    if (firstRun) { name.input.required = true; name.input.setAttribute('aria-label', 'Your name'); }
    // Optionally make the name the instance's owner name: it follows you to other browsers and the org chart.
    const instance = this.el('label', 'ca-check');
    const instanceBox = this.el('input');
    instanceBox.type = 'checkbox';
    instance.append(instanceBox, this.el('span', '', 'Use this name across browsers and in the company chart.'));
    const pronouns = field('Pronouns', p.pronouns, 24, 'e.g. they/them');
    const status = field('Status', p.status, 60, 'What are you up to?');
    const pictureBefore = this.ownerAvatar || p.image;
    if (!firstRun) form.append(name.wrap, instance, pronouns.wrap, status.wrap);
    const appearance = !firstRun ? this.expertAppearanceFields(form, pictureBefore, { name: name.input }) : null;
    const pic = appearance?.picture;
    const swatches = this.el('div', 'ca-swatches');
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', 'Profile colour');
    let hue = p.hue;
    const paint = () => {
      for (const b of swatches.children) b.setAttribute('aria-checked', String(Number(b.dataset.hue) === hue));
    };
    for (const h of CA_PROFILE_HUES) {
      const b = this.el('button', 'ca-swatch');
      b.type = 'button';
      b.dataset.hue = String(h);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `Colour ${h}`);
      b.style.setProperty('--chat-hue', String(h));
      b.addEventListener('click', () => {
        hue = h;
        paint();
      });
      swatches.append(b);
    }
    paint();
    const colourWrap = this.el('div', 'ca-label');
    colourWrap.append(this.el('span', '', 'Colour'), swatches);
    const row = this.el('div', 'ca-dialog-actions');
    const reset = this.el('button', 'ca-btn', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.saveProfile({});
      dlg.close();
    });
    const cancel = this.el('button', 'ca-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const save = this.el('button', 'ca-btn is-primary', 'Save');
    save.type = 'submit';
    if (!firstRun) row.append(reset);
    row.append(this.el('span', 'ca-spacer'), cancel, save);
    const nameError = this.el('p', 'ca-company-error'); nameError.setAttribute('role', 'alert');
    if (firstRun) form.append(name.wrap, nameError, row);
    else form.append(colourWrap, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (firstRun) {
        const ownerName = name.input.value.trim();
        if (!ownerName) { nameError.textContent = 'Enter your name, or choose Cancel.'; return; }
        save.disabled = true;
        try {
          if (await this.saveOwnerName(ownerName, { quiet: true })) dlg.close();
          else nameError.textContent = 'Your name could not be saved. Try again.';
        } catch { nameError.textContent = 'Your name could not be saved. Try again.'; }
        finally { save.disabled = false; }
        return;
      }
      if (save.disabled || appearance.pending()) return;
      save.disabled = true;
      // The picture goes to the server (owner only), so it shows on your messages for everyone; if that is refused it stays in this
      // browser. A server link is never kept locally.
      let image = pic.value();
      if (image !== pictureBefore && (image || this.ownerAvatar)) {
        const stored = await this.saveOwnerPicture(image);
        if (stored) image = '';
        else if (image) this.toast('Your picture could not be saved on the server; it is kept on this device only.', 'info');
        else this.toast('Your picture could not be removed on the server, so it is still shown.', 'error');
      }
      if (image.startsWith('/api/')) image = '';
      this.saveProfile({ name: name.input.value, pronouns: pronouns.input.value, status: status.input.value, icon: '', image, hue });
      if (instanceBox.checked && name.input.value.trim()) await this.saveOwnerName(name.input.value.trim());
      dlg.close();
    });
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    name.input.focus();
  }

  editStatus(m) {
    const host = this.el('div', 'ca-edit-host');
    const dlg = this.el('dialog', 'ca-dialog');
    dlg.setAttribute('aria-label', `Edit ${m.name}`);
    dlg.append(this.el('h2', '', `Edit ${m.name}`), host);
    const close = this.button('ca-btn', 'Close', () => dlg.close(), { text: 'Close' });
    dlg.append(close);
    this.doc.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    // The shared editor draws its form into the element it is given.
    this.app._editChatSynopsis(host, m);
    dlg.showModal();
  }

  /* ── room menu & dialogs ── */

  /* ── menus (Discord's: a right-click menu on a channel, a dropdown on the workspace name, a bell in the header) ── */

  /**
   * One menu, used by all of them. `entries` are { label, run, danger, checked, sub, disabled } or { sep: true }; `sub` is a list
   * shown beside the entry. Arrow keys move, ArrowRight opens a sub-list, ArrowLeft/Escape close it, Escape closes the
   * menu and gives focus back to `focus`. `at` is { x, y } or an element to hang under (right-aligned when `right`).
   */
  openMenu(entries, { at, focus, right = false, above = false, label = 'Menu', className = '', restoreFocus = false } = {}) {
    this.closeMenus();
    const restore = focus || this.doc.activeElement;
    const open = [];
    const place = (menu, anchor, side) => {
      const w = this.doc.defaultView?.innerWidth || 1024;
      const h = this.doc.defaultView?.innerHeight || 768;
      if (anchor && typeof anchor.getBoundingClientRect === 'function') {
        const r = anchor.getBoundingClientRect();
        // From the message box the menu opens upward, like Discord's "+".
        if (above) menu.style.bottom = `${Math.max(8, h - r.top + 6)}px`;
        else menu.style.top = `${Math.min(r.bottom + 6, h - 40)}px`;
        if (right) menu.style.right = `${Math.max(8, w - r.right)}px`;
        else menu.style.left = `${Math.max(8, Math.min(r.left, w - 240))}px`;
      } else if (anchor) {
        menu.style.top = `${Math.max(8, Math.min(anchor.y, h - 40))}px`;
        menu.style.left = `${Math.max(8, Math.min(anchor.x, w - 240))}px`;
      }
      if (side) {
        const r = side.getBoundingClientRect();
        menu.style.top = `${r.top}px`;
        menu.style.left = `${Math.min(r.right + 4, w - 236)}px`;
        menu.style.right = '';
      }
    };
    const build = (list, anchor, side) => {
      const menu = this.el('div', `ca-menu ca-popmenu${className ? ` ${className}` : ''}`);
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', label);
      for (const e of list) {
        if (e.sep) {
          menu.append(this.el('hr', 'ca-menu-sep'));
          continue;
        }
        if (e.row) {
          const strip = this.el('div', 'ca-menu-row');
          strip.setAttribute('role', 'group');
          for (const r of e.row) {
            const rb = this.el('button', 'ca-menu-emoji', r.glyph);
            rb.type = 'button';
            rb.setAttribute('aria-label', r.label);
            rb.addEventListener('click', () => {
              closeAll(false);
              r.run?.();
            });
            strip.append(rb);
          }
          menu.append(strip);
          continue;
        }
        const b = this.el('button', `${e.danger ? 'is-danger' : ''}${e.checked !== undefined ? ' has-check' : ''}`);
        b.type = 'button';
        b.setAttribute('role', e.checked === undefined ? 'menuitem' : e.checkbox ? 'menuitemcheckbox' : 'menuitemradio');
        if (e.checked !== undefined) b.setAttribute('aria-checked', String(!!e.checked));
        b.disabled = !!e.disabled;
        if (e.tip) b.title = e.tip;
        if (e.avatar) {
          const avatar = this.app._chatAvatar(e.avatar.id, e.avatar.name, { size: 'sm' });
          avatar.setAttribute('aria-hidden', 'true');
          b.append(avatar);
        }
        if (e.glyph) {
          const g = this.el('span', 'ca-menu-glyph', e.glyph);
          g.setAttribute('aria-hidden', 'true');
          b.append(g);
        }
        const text = this.el('span', 'ca-menu-label', e.label);
        if (e.disabled && e.reason) {
          b.title = [e.reason, e.tip].filter(Boolean).join('; ');
          text.append(this.el('span', 'ca-menu-reason', e.reason));
        }
        b.append(text);
        if (e.hint) b.append(this.el('span', 'ca-menu-hint', e.hint));
        if (e.sub) b.append(this.el('span', 'ca-menu-arrow', '\u203A'));
        if (e.checked !== undefined) b.append(this.el('span', e.checkbox ? 'ca-menu-box' : 'ca-menu-radio'));
        if (e.sub) b.setAttribute('aria-haspopup', 'menu');
        b.addEventListener('click', () => {
          if (e.sub) return openSub(menu, b, e.sub);
          closeAll(false);
          e.run?.();
        });
        menu.append(b);
      }
      this.doc.body.append(menu);
      place(menu, anchor, side);
      if (className === 'ca-member-menu' || className === 'ca-member-picker') this.fitMemberMenu(menu);
      open.push(menu);
      return menu;
    };
    const openSub = (parent, trigger, list) => {
      while (open.length > open.indexOf(parent) + 1) open.pop().remove();
      const m = build(list, null, trigger);
      m.querySelector('button')?.focus();
    };
    const closeAll = (refocus) => {
      for (const m of open.splice(0)) m.remove();
      this.doc.removeEventListener('pointerdown', onPointer, true);
      this.doc.removeEventListener('keydown', onKey, true);
      this._openMenuClose = null;
      if (refocus || restoreFocus) restore?.focus?.();
    };
    const onPointer = (ev) => {
      if (!open.some((m) => m.contains(ev.target))) {
        if (restoreFocus) ev.preventDefault();
        closeAll(false);
      }
    };
    const onKey = (ev) => {
      const menu = open.at(-1);
      if (!menu) return;
      const items = [...menu.querySelectorAll('button:not(:disabled)')].filter((b) => !b.hidden);
      const at = items.indexOf(this.doc.activeElement);
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (open.length > 1) {
          const sub = open.pop();
          sub.remove();
          open.at(-1).querySelector('[aria-haspopup]:focus, [aria-haspopup]')?.focus();
        } else closeAll(true);
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const next = at < 0 ? (ev.key === 'ArrowDown' ? 0 : items.length - 1)
          : (at + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      } else if (ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        items[ev.key === 'Home' ? 0 : items.length - 1]?.focus();
      } else if (ev.key === 'ArrowRight' && this.doc.activeElement?.getAttribute('aria-haspopup')) {
        ev.preventDefault();
        this.doc.activeElement.click();
      } else if (ev.key === 'ArrowLeft' && open.length > 1) {
        ev.preventDefault();
        ev.stopPropagation();
        open.pop().remove();
        open.at(-1).querySelector('[aria-haspopup]')?.focus();
      } else if (ev.key === 'Enter' || (ev.key === ' ' && !this.doc.activeElement?.matches('input'))) {
        ev.preventDefault();
        items[at < 0 ? 0 : at]?.click();
      } else if (ev.key === 'Tab') {
        closeAll(false);
      }
    };
    this._openMenuClose = closeAll;
    const root = build(entries, at, null);
    root.querySelector('button:not(:disabled)')?.focus();
    this.doc.addEventListener('pointerdown', onPointer, true);
    this.doc.addEventListener('keydown', onKey, true);
    return root;
  }

  closeMenus() {
    this._openMenuClose?.(false);
    this.doc.querySelector('.ca-popmenu')?.remove();
  }

  /* ── workspace look (icon and colour, kept in this browser) ── */

  /** What this browser itself keeps about workspaces (colour, emoji, and a picture from before pictures lived on the server). */
  get wsMetaLocal() {
    try {
      const o = JSON.parse(caRead('local', 'reverie:chat:wsmeta', '{}'));
      return o && typeof o === 'object' ? o : {};
    } catch {
      return {};
    }
  }

  /** The look the page draws: the browser's own, with the server's picture over its picture. */
  get wsMeta() {
    const all = this.wsMetaLocal;
    // The server matches names ignoring case ("Acme" and "acme" share a picture), so every spelling in use gets it.
    const byLower = new Map(Object.entries(this.wsIcons || {}).map(([name, image]) => [name.toLowerCase(), image]));
    if (byLower.size) {
      const spellings = new Set([...Object.keys(all), ...Object.keys(this.wsIcons), ...(this.rooms || []).map((r) => r.workspace).filter(Boolean), '']);
      for (const name of spellings) {
        const image = byLower.get(name.toLowerCase());
        if (image) all[name] = { ...(Object.hasOwn(all, name) ? all[name] : {}), image };
      }
    }
    return all;
  }

  setWsMeta(key, patch) {
    const all = this.wsMetaLocal;
    const next = { ...(Object.hasOwn(all, key) ? all[key] : {}), ...patch };
    if (!next.icon) delete next.icon;
    if (!next.image) delete next.image;
    if (next.hue === null || next.hue === undefined) delete next.hue;
    if (Object.keys(next).length) all[key || ''] = next;
    else delete all[key || ''];
    caWrite('local', 'reverie:chat:wsmeta', Object.keys(all).length ? JSON.stringify(all) : null);
    this.renderAll();
  }

  /* ── closing a direct message (hidden from the list, kept, and back when it is opened or answered) ── */

  get closedDms() {
    return caClosedDms(caRead('local', 'reverie:chat:closedDms', ''));
  }

  reopenDm(roomId) {
    const all = this.closedDms;
    if (!Object.hasOwn(all, roomId)) return false;
    delete all[roomId];
    caWrite('local', 'reverie:chat:closedDms', Object.keys(all).length ? JSON.stringify(all) : null);
    return true;
  }

  async closeDm(roomId) {
    const all = this.closedDms;
    all[roomId] = Date.now();
    caWrite('local', 'reverie:chat:closedDms', JSON.stringify(all));
    if (this.roomId === roomId) {
      // Leave it: the next direct message, else the first channel, else nothing is selected.
      const next = caDmItems(this.rooms, null, all)[0]?.id || this.rooms.find((r) => !caIsDm(r) && !r.archivedAt)?.id;
      if (next) await this.selectRoom(next);
    }
    this.renderAll();
  }

  /* ── notification settings (kept in this browser) ── */

  get notifyPrefs() {
    return caNotifyPrefs(caRead('local', 'reverie:chat:notify', ''));
  }

  get viewRooms() {
    return caViewRooms(this.rooms, this.notifyPrefs, Date.now());
  }

  /** Change one channel's notification choice; `patch` is { level?, until? }. Expired mutes are dropped as it saves. */
  setNotify(roomId, patch) {
    const all = this.notifyPrefs;
    const now = Date.now();
    for (const [id, p] of Object.entries(all)) if (p.until > 0 && p.until <= now && p.level === 'default') delete all[id];
    const next = { ...(all[roomId] || { level: 'default', until: 0 }), ...patch };
    all[roomId] = next;
    const clean = caNotifyPrefs(all);
    caWrite('local', 'reverie:chat:notify', Object.keys(clean).length ? JSON.stringify(clean) : null);
    this.scheduleNotifyTick();
    this.renderAll();
  }

  /** Redraw when the next timed mute ends, so a channel un-dims by itself. */
  scheduleNotifyTick() {
    clearTimeout(this._notifyTimer);
    const now = Date.now();
    const next = Object.values(this.notifyPrefs).filter((p) => p.until > now).map((p) => p.until).sort((a, b) => a - b)[0];
    if (!next) return;
    this._notifyTimer = this.doc.defaultView?.setTimeout(() => {
      this.renderAll();
      this.scheduleNotifyTick();
    }, Math.min(next - now + 500, 2 ** 31 - 1));
  }

  /** The "Mute channel" sub-list and the notification radios, shared by the bell and the channel menu. */
  notifyEntries(room) {
    const pref = this.notifyPrefs[room.id] || { level: 'default', until: 0 };
    const muted = caIsMuted(pref);
    const noun = room.noun || (caIsDm(room) ? 'conversation' : 'channel');
    const mute = muted
      ? { label: `Unmute ${noun}`, hint: pref.until === -1 ? '' : `until ${new Date(pref.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, run: () => this.setNotify(room.id, { until: 0 }) }
      : {
          label: `Mute ${noun}`,
          sub: CA_MUTE_CHOICES.map(([label, ms]) => ({ label, run: () => this.setNotify(room.id, { until: ms === -1 ? -1 : Date.now() + ms }) })),
        };
    const levels = CA_NOTIFY_LEVELS.map(([level, label, hint]) => ({ label, hint, checked: pref.level === level, run: () => this.setNotify(room.id, { level }) }));
    return { mute, levels, muted };
  }

  /** The bell in the header: this channel's notification options (Discord's own layout). */
  openNotifyMenu(anchor) {
    const room = this.room;
    if (!room || this.app._chatCreating) return;
    const { mute, levels } = this.notifyEntries(room);
    this.openMenu([mute, { sep: true }, ...levels], { at: anchor, focus: anchor, right: true, label: 'Notification settings' });
  }

  /** What the menus can do to a channel (a room), whichever is open. */
  channelEntries(room) {
    const dm = caIsDm(room);
    const out = [];
    const unread = Math.max(0, Number(room.unread) || 0);
    if (this.serverFeatures.unread) out.push({ label: dm ? 'Mark conversation as read' : 'Mark channel as read', disabled: !unread, run: () => this.markRead(room.id) });
    if (!dm) {
      out.push({ sep: true });
      out.push({ label: 'Invite agents', run: () => this.openInviteDialog(room.id) });
    }
    if (dm) out.push({ label: 'Close DM', run: () => this.closeDm(room.id) });
    const { mute, levels } = this.notifyEntries(room);
    out.push({ sep: true }, mute, { label: 'Notification settings', sub: levels });
    if (!dm) {
      out.push({ sep: true });
      out.push({ label: 'Edit channel', run: () => this.openChannelSettings(room.id) });
      out.push({ label: 'Re-brief members', run: async () => {
        if (this.roomId !== room.id) await this.selectRoom(room.id);
        this.app._rebriefChatMember('all');
      } });
      if (this.app._speakRepliesMode) {
        const now = this.app._speakRepliesMode(room.id);
        const choices = CA_READ_ALOUD_MODES.map(([mode, label, said]) => ({ label, checked: now === mode, run: () => {
          this.app._setSpeakReplies(room.id, mode);
          if (this.roomId === room.id) this.renderHeader();
          this.toast(said, 'info');
        } }));
        if (this.app._readAloudOptions && this.app._setReadAloudOptions) {
          const options = this.app._readAloudOptions(room.id);
          choices.push({ sep: true }, {
            label: 'Maximum spoken length (approx.)',
            sub: [[null, 'Default (80-word limit)'], [5, '5 seconds'], [10, '10 seconds'], [20, '20 seconds'], [30, '30 seconds'], [0, 'Unlimited']].map(([seconds, label]) => ({
              label, checked: options.seconds === seconds, run: () => {
                this.app._setReadAloudOptions(room.id, { seconds });
                this.toast('Speech length saved for this channel on this device; full text stays in chat', 'info');
              },
            })),
          }, {
            label: 'Speak emojis', checkbox: true, checked: options.emojis, run: () => {
              this.app._setReadAloudOptions(room.id, { emojis: !options.emojis });
              this.toast(`Emoji speech ${options.emojis ? 'off' : 'on'} for this channel on this device`, 'info');
            },
          });
        }
        out.push({ label: 'Read aloud', sub: choices });
      }
      if (caSpeaks(room)) {
        if (this.app.openCarMode) out.push({ label: 'Car mode', run: async () => {
          if (this.roomId !== room.id) await this.selectRoom(room.id);
          this.app.openCarMode();
        } });
      }
      if (this.serverFeatures.placement) {
        out.push({ label: room.archivedAt ? 'Restore channel' : 'Archive channel', run: () => this.archive(!room.archivedAt, room.id) });
      }
      out.push({ sep: true });
      out.push({ label: 'Delete channel', danger: true, run: () => this.deleteRoom(room.id) });
    }
    return out;
  }

  /** Right-click (or the menu key) on a channel, or its name in the header. */
  openChannelMenu(roomId, at, focus) {
    const room = this.rooms.find((r) => r.id === roomId) || (this.room?.id === roomId ? this.room : null);
    if (!room) return;
    this.openMenu(this.channelEntries(room), { at, focus, label: `${caRoomLabel(room)} channel` });
  }

  /** A workspace is a grouping label. Removing it moves channels; it never deletes their history. */
  async deleteWorkspace(key) {
    const owner = this.company?.canManage === true && this.phoneStatus?.self === 'owner' && this.phoneStatus?.canSetOwn === true;
    if (!owner || !key || key === 'home' || !this.serverFeatures.placement) return false;
    const rooms = this.rooms.filter((r) => !caIsDm(r) && r.workspace === key);
    const destination = this.defaultWorkspaceName();
    const question = rooms.length
      ? `Delete workspace "${key}"? Move its ${rooms.length} channel${rooms.length === 1 ? '' : 's'} to "${destination}". All messages, members and channel categories will be kept.`
      : `Delete empty workspace "${key}"? No channels or messages will be deleted.`;
    if (!this.doc.defaultView?.confirm(question)) return false;
    let moved = 0;
    try {
      for (const room of rooms) {
        const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(room.id)}/placement`, {
          method: 'PUT', body: { workspace: '', category: room.category || '' },
        });
        if (!res.ok) throw new Error(res.error || 'Channel move refused');
        moved++;
      }
    } catch (error) {
      await this.app._loadChatRooms(this.roomId);
      this.toast(`Workspace not removed: ${error.message}. ${moved} channel${moved === 1 ? '' : 's'} moved to "${destination}"; move the remaining channels and try again.`, 'error');
      return false;
    }
    const meta = this.wsMetaLocal;
    delete meta[key];
    caWrite('local', 'reverie:chat:wsmeta', JSON.stringify(meta));
    const notify = this.notifyPrefs;
    delete notify[`ws:${key}`];
    caWrite('local', 'reverie:chat:notify', JSON.stringify(notify));
    if (this.workspace === key) this.workspace = '';
    if (Object.keys(this.wsIcons || {}).some((name) => name.toLowerCase() === key.toLowerCase())) {
      if (!await this.saveWsPicture(key, '')) this.toast('Channels moved, but the old workspace picture could not be removed.', 'error');
    }
    await this.app._loadChatRooms(this.roomId);
    this.renderAll();
    this.toast(`Workspace removed. Channels and messages are kept in "${destination}".`, 'info');
    return true;
  }

  /** What the workspace menus offer; `key` is a workspace key or "home". `full` adds the page-wide tools. */
  workspaceEntries(key, { full = false } = {}) {
    const home = key === 'home';
    const rooms = this.rooms.filter((r) => (home ? caIsDm(r) : !caIsDm(r) && (r.workspace || '') === (key || '')));
    const name = home ? 'Direct Messages' : key || this.defaultWorkspaceName();
    const out = [];
    if (this.serverFeatures.unread) {
      out.push({ label: 'Mark all as read', disabled: !rooms.some((r) => (Number(r.unread) || 0) > 0), run: () => this.markAllRead(rooms) });
    }
    if (!home) {
      const { mute, levels } = this.notifyEntries({ id: `ws:${key || ''}`, noun: 'workspace' });
      out.push({ sep: true }, mute, { label: 'Notification settings', sub: levels });
      out.push({ label: 'Hide muted channels', checkbox: true, checked: this.hideMuted, run: () => this.setHideMuted(!this.hideMuted) });
      out.push({ sep: true });
      out.push({ label: 'Workspace settings', run: () => this.openWorkspaceSettings(key || '') });
      out.push({ label: 'Create channel', run: () => this.newRoom({ workspace: key || '' }) });
      if (key && this.serverFeatures.placement && this.company?.canManage === true && this.phoneStatus?.self === 'owner' && this.phoneStatus?.canSetOwn === true) {
        out.push({ sep: true }, { label: 'Delete workspace', danger: true, run: () => this.deleteWorkspace(key) });
      }
    } else if (this.serverFeatures.dms) {
      out.push({ sep: true }, { label: 'Start a direct message', run: () => this.openSwitcher({ agents: true }) });
    }
    if (full) {
      out.push({ sep: true });
      out.push({ label: 'Custom emotes', run: () => this.app._openEmoteManager?.() });
      out.push({ label: 'Org chart', run: () => this.openOrg() });
      if (this.serverFeatures.replace && (this.app._chatRetired || []).length) out.push({ label: 'Retired sessions', run: () => this.openRetiredDialog() });
      out.push({ label: 'Send diagnostics', run: () => this.app.sendChatDiagnostics?.() });
    }
    this._lastWsName = name;
    return out;
  }

  /** The workspace name at the top of the sidebar, as a dropdown. */
  openWorkspaceMenu(anchor) {
    this.openMenu(this.workspaceEntries(this.workspace || '', { full: true }), { at: anchor, focus: anchor, label: 'Workspace' });
  }

  /** Right-click or long press on a workspace icon in the rail. */
  openRailMenu(key, at, focus) {
    this.openMenu(this.workspaceEntries(key), { at, focus, label: 'Workspace' });
  }

  get hideMuted() {
    return caRead('local', 'reverie:chat:hideMuted', '') === '1';
  }

  setHideMuted(on) {
    caWrite('local', 'reverie:chat:hideMuted', on ? '1' : null);
    this.renderAll();
  }

  viewRoomsHere() {
    const home = this.workspace === 'home';
    return this.rooms.filter((r) => (home ? caIsDm(r) : !caIsDm(r) && (r.workspace || '') === (this.workspace || '')));
  }

  /** Mark one channel read on the server (and here, at once). */
  async markRead(roomId) {
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/read`, { method: 'POST', body: {} });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    const room = this.rooms.find((r) => r.id === roomId);
    if (room) {
      room.unread = 0;
      room.mentions = 0;
      if (res.data?.userReadAt !== undefined) room.userReadAt = res.data.userReadAt;
    }
    this.renderAll();
  }

  async markAllRead(rooms = this.viewRoomsHere()) {
    for (const room of rooms) {
      if ((Number(room.unread) || 0) > 0) await this.markRead(room.id);
    }
  }

  async promptRename() {
    const name = this.doc.defaultView?.prompt('Channel name', this.room?.name || '');
    if (!name) return;
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}`, { method: 'PUT', body: { name } });
    if (!res.ok) this.toast(`Chat: ${res.error}`, 'error');
  }

  async deleteRoom(id = this.roomId) {
    const room = this.rooms.find((r) => r.id === id) || this.room;
    if (!this.doc.defaultView?.confirm(`Delete channel "${room?.name}" and its history?`)) return;
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) this.toast(`Chat: ${res.error}`, 'error');
  }

  async archive(archived, id = this.roomId) {
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(id)}/archive`, {
      method: 'PUT',
      body: { archived },
    });
    if (!res.ok) this.toast(`Chat: ${res.error}`, 'error');
  }

  openPlacementDialog() {
    const room = this.room;
    const dlg = this.el('dialog', 'ca-dialog');
    dlg.setAttribute('aria-label', 'Move channel');
    dlg.append(this.el('h2', '', `Move #${room.name}`));
    const form = this.el('form', 'ca-form');
    const field = (label, value, listId, options) => {
      const wrap = this.el('label', 'ca-label');
      wrap.append(this.el('span', '', label));
      const input = this.el('input', 'ca-field');
      input.value = value || '';
      input.maxLength = 40;
      input.setAttribute('list', listId);
      const list = this.el('datalist');
      list.id = listId;
      for (const o of options) list.append(new Option(o, o));
      wrap.append(input, list);
      return { wrap, input };
    };
    const spaces = [...new Set(this.rooms.filter((r) => !caIsDm(r)).map((r) => r.workspace).filter(Boolean))];
    const cats = [...new Set(this.rooms.filter((r) => !caIsDm(r)).map((r) => r.category).filter(Boolean))];
    const ws = field('Workspace (empty for the default one)', room.workspace, 'ca-ws-list', spaces);
    const cat = field('Category (empty for none)', room.category, 'ca-cat-list', cats);
    const row = this.el('div', 'ca-dialog-actions');
    const cancel = this.el('button', 'ca-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    const save = this.el('button', 'ca-btn is-primary', 'Move');
    save.type = 'submit';
    row.append(cancel, save);
    form.append(ws.wrap, cat.wrap, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/placement`, {
        method: 'PUT',
        body: { workspace: ws.input.value.trim(), category: cat.input.value.trim() },
      });
      if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
      dlg.close();
    });
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    dlg.showModal();
    ws.input.focus();
  }

  /* ── quick switcher ── */

  agents() {
    const out = [];
    for (const s of this.app.sessions?.values?.() || []) {
      if (!s || s.mode === 'shell') continue;
      out.push({ id: s.id, name: this.app.getSessionName?.(s) || s.name || s.id.slice(0, 8) });
    }
    return out;
  }

  openSwitcher({ agents = false } = {}) {
    this.doc.querySelector('.ca-switcher')?.remove();
    const dlg = this.el('dialog', 'ca-dialog ca-switcher');
    dlg.setAttribute('aria-label', 'Find or start a conversation');
    const input = this.el('input', 'ca-field ca-switcher-input');
    input.type = 'search';
    input.placeholder = 'Where would you like to go?';
    input.setAttribute('aria-label', 'Search channels, direct messages and agents');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'ca-switcher-list');
    const list = this.el('div', 'ca-switcher-list');
    list.id = 'ca-switcher-list';
    list.setAttribute('role', 'listbox');
    dlg.append(input, list);
    let results = [];
    let cursor = 0;
    const paint = () => {
      list.replaceChildren();
      let heading = '';
      results.forEach((r, i) => {
        // Results come grouped (channels, direct messages, agents without one): each group gets a heading.
        const group = r.type === 'room' ? 'Channels' : r.type === 'dm' ? 'Direct messages' : 'Start a conversation';
        if (group !== heading) {
          heading = group;
          const h = this.el('div', 'ca-switcher-head', group);
          h.setAttribute('role', 'presentation');
          list.append(h);
        }
        const o = this.el('button', `ca-switcher-item${i === cursor ? ' is-active' : ''}`);
        o.type = 'button';
        o.id = `ca-switcher-opt-${i}`;
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', String(i === cursor));
        const room = r.type === 'agent' ? null : this.rooms.find((x) => x.id === r.id);
        if (r.type === 'room') {
          const g = caRoomGlyph(room);
          const mark = this.glyphNode(g);
          mark.setAttribute('aria-hidden', 'true');
          o.append(mark);
          if (g.label) o.setAttribute('aria-label', `${r.label}, private channel`);
        }
        else {
          const peer = room ? caDmPeer(room) : null;
          o.append(this.app._chatAvatar(peer?.sessionId || r.id, r.label, { size: 'sm' }));
        }
        o.append(this.el('span', 'ca-name', r.label));
        const hint = r.archived ? 'archived' : r.type === 'room' && room?.category ? room.category : '';
        if (hint) o.append(this.el('span', 'ca-switcher-kind', hint));
        o.addEventListener('click', () => choose(r));
        list.append(o);
      });
      if (!results.length) list.append(this.el('p', 'ca-empty-note', 'Nothing matches.'));
      input.setAttribute('aria-activedescendant', results.length ? `ca-switcher-opt-${cursor}` : '');
    };
    const refresh = () => {
      const agentsList = this.serverFeatures.dms ? this.agents() : [];
      results = caSwitcherResults(this.rooms, agentsList, input.value);
      if (agents) results = results.filter((r) => r.type === 'agent' || r.type === 'dm');
      cursor = Math.min(cursor, Math.max(0, results.length - 1));
      paint();
    };
    const choose = (r) => {
      dlg.close();
      if (r.type === 'agent') this.startDm(r.id);
      else this.selectRoom(r.id);
    };
    input.addEventListener('input', () => {
      cursor = 0;
      refresh();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') cursor = Math.min(results.length - 1, cursor + 1);
      else if (e.key === 'ArrowUp') cursor = Math.max(0, cursor - 1);
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[cursor]) choose(results[cursor]);
        return;
      } else return;
      e.preventDefault();
      paint();
      list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
    });
    dlg.addEventListener('close', () => dlg.remove());
    this.doc.body.append(dlg);
    refresh();
    dlg.showModal();
    input.focus();
  }

  async startDm(sessionId) {
    const res = await this.app._chatApi('/api/chatrooms/dms', { method: 'POST', body: { sessionId } });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    this.reopenDm(res.data.id);
    this._wsPinned = false;
    await this.app._loadChatRooms(res.data.id);
    this.renderAll();
  }

  /* ── drawers and members panel ── */

  toggleDrawer(which) {
    this.drawer = this.drawer === which ? null : which;
    this.renderChrome();
    // A drawer that just opened takes focus, so a keyboard user lands in it.
    if (this.drawer === 'channels') this.els.side.querySelector('button')?.focus();
    else if (this.drawer === 'members') this.els.members.querySelector('button')?.focus();
  }

  toggleMembers() {
    const narrow = this.doc.defaultView?.matchMedia?.('(max-width: 899px)')?.matches;
    if (narrow) {
      this.toggleDrawer('members');
      return;
    }
    this.membersOpen = !this.membersOpen;
    caWrite('local', 'reverie:chat:members', this.membersOpen ? '1' : '0');
    this.renderChrome();
  }

  /* ── messages ── */

  /**
   * A poll card: the question, one big tap target per option with a share bar, the count, your choice marked and the author's
   * recommendation tagged. Each option is a radio (one choice) or a checkbox (several) button, so it works from the keyboard.
   */
  pollEl(m) {
    const view = caPollView(m.poll, Date.now());
    const card = this.el('div', `ca-poll${view.open ? '' : ' is-closed'}`);
    card.dataset.pollId = m.id;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `Poll: ${m.poll.question}`);
    const head = this.el('div', 'ca-poll-head');
    head.append(this.el('span', 'ca-poll-kind', 'Poll'));
    const status = !view.open
      ? 'Closed'
      : view.closesAt
        ? `Closes ${new Date(view.closesAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Open';
    head.append(this.el('span', 'ca-poll-status', `${status}${view.multi ? ' \u00B7 choose any' : ''}`));
    card.append(head, this.el('div', 'ca-poll-q', m.poll.question));
    if (view.open) card.append(this.el('div', 'ca-poll-hint', view.multi ? 'Pick as many as you like' : 'Pick one'));
    const list = this.el('div', 'ca-poll-options');
    list.setAttribute('role', view.multi ? 'group' : 'radiogroup');
    list.setAttribute('aria-label', 'Options');
    const mineIds = new Set(view.rows.filter((r) => r.mine).map((r) => r.id));
    for (const row of view.rows) {
      const btn = this.el('button', `ca-poll-opt${row.mine ? ' is-mine' : ''}${row.leading && !view.open ? ' is-winner' : ''}`);
      btn.type = 'button';
      btn.setAttribute('role', view.multi ? 'checkbox' : 'radio');
      btn.setAttribute('aria-checked', String(row.mine));
      if (!view.open) btn.disabled = true;
      const fill = this.el('span', 'ca-poll-fill');
      fill.style.width = `${row.pct}%`;
      fill.setAttribute('aria-hidden', 'true');
      const mark = this.el('span', `ca-poll-mark ${view.multi ? 'is-box' : 'is-dot'}`, row.mine ? '\u2713' : '');
      mark.setAttribute('aria-hidden', 'true');
      const label = this.el('span', 'ca-poll-label', row.label);
      const tag = row.rec ? this.el('span', 'ca-tag ca-poll-rec', 'rec') : null;
      const count = this.el('span', 'ca-poll-count', `${row.count} \u00B7 ${row.pct}%`);
      btn.append(fill, mark, label);
      if (tag) btn.append(tag);
      btn.append(count);
      btn.setAttribute('aria-label', `${row.label}${row.rec ? ', recommended' : ''}, ${row.count} vote${row.count === 1 ? '' : 's'}, ${row.pct} percent${row.mine ? ', your choice' : ''}`);
      btn.addEventListener('click', () => {
        const next = new Set(view.multi ? mineIds : []);
        if (row.mine) next.delete(row.id);
        else next.add(row.id);
        this.castVote(m, card, [...next]);
      });
      list.append(btn);
      if (row.voters.length) {
        const names = row.voters.map((v) => (v === 'user' ? this.userName() : this.app._chatNameOf(v)));
        list.append(this.el('span', 'ca-poll-voters', names.length > 5 ? `${names.slice(0, 5).join(', ')} +${names.length - 5}` : names.join(', ')));
      }
    }
    card.append(list);
    const foot = this.el('div', 'ca-poll-foot');
    foot.append(this.el('span', 'ca-poll-total', `${view.total} vote${view.total === 1 ? '' : 's'}`));
    if (view.open) {
      const end = this.el('button', 'ca-btn ca-poll-close', 'Close poll');
      end.type = 'button';
      end.addEventListener('click', () => this.closePoll(m, card));
      foot.append(end);
    }
    card.append(foot);
    return card;
  }

  /** Send this page's vote (an empty list withdraws it) and redraw the card from the server's answer. */
  async castVote(m, card, ids) {
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(m.roomId || this.roomId)}/messages/${encodeURIComponent(m.id)}/poll/vote`, {
      method: 'POST',
      body: { options: ids },
    });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    this.redrawPoll(m, card, res.data.poll);
  }

  async closePoll(m, card) {
    if (!this.doc.defaultView?.confirm('Close this poll? No one can vote after it is closed.')) return;
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(m.roomId || this.roomId)}/messages/${encodeURIComponent(m.id)}/poll/close`, {
      method: 'POST',
      body: {},
    });
    if (!res.ok) return this.toast(`Chat: ${res.error}`, 'error');
    this.redrawPoll(m, card, res.data.poll);
  }

  /** Replace a card with one drawn from fresh poll data, keeping focus on the same option. */
  redrawPoll(m, card, poll) {
    if (!poll) return;
    const at = [...card.querySelectorAll('.ca-poll-opt')].findIndex((b) => b === this.doc.activeElement);
    m.poll = poll;
    const fresh = this.pollEl(m);
    // Swapping the card must not move the feed: keep the scroll where it was, and focus without scrolling into view.
    const feed = this.app._chatEls?.feed;
    const top = feed ? feed.scrollTop : 0;
    card.replaceWith(fresh);
    if (at >= 0) fresh.querySelectorAll('.ca-poll-opt')[at]?.focus({ preventScroll: true });
    if (feed) feed.scrollTop = top;
  }

  /** One message as the feed draws it: avatar, name and time on a group's head, a bare line after. */
  messageEl(m, head) {
    if (m.from.kind === 'system') {
      const el = this.el('div', 'ca-sys');
      el.dataset.msgId = m.id;
      el.append(this.el('span', 'ca-sys-arrow', '→'), this.el('span', 'ca-sys-text', m.text));
      el.append(this.el('time', 'ca-time', new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      return el;
    }
    if (m.deleted) return this.tombstoneEl(m);
    const mine = m.from.kind === 'user';
    const direct = m.to !== 'all';
    const el = this.el('div', `ca-msg${m.pinned ? ' is-pinned' : ''}${head ? ' is-head' : ' is-cont'}${mine ? ' is-mine' : ''}${direct ? ' is-direct' : ''}${this.replyTarget()?.id === m.id ? ' is-replying' : ''}`);
    el.dataset.msgId = m.id;
    // One tab stop per message; its toolbar shows (and is reachable) while it has focus.
    el.tabIndex = 0;
    // Right-click, or a long press on a phone, opens the message's actions (a bottom sheet on a phone).
    if (!m.deleted && !m.external) this.wireMessageMenu(el, m);
    el.setAttribute('role', 'article');
    const gutter = this.el('div', 'ca-msg-gutter');
    const name = this.authorOf(m.from);
    if (head) {
      gutter.append(this.avatarFor(m.from, name, { size: 'md' }));
    } else {
      const t = this.el('time', 'ca-time-hover', new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      t.title = new Date(m.at).toLocaleString();
      gutter.append(t);
    }
    const body = this.el('div', 'ca-msg-body');
    if (m.replyTo && this.serverFeatures.replies) body.append(this.replyRefEl(m));
    if (m.pinned) body.append(this.pinMarkEl(m));
    if (head) {
      const meta = this.el('div', 'ca-msg-meta');
      const from = this.el('span', 'ca-msg-from', name);
      from.style.setProperty('--chat-hue', String(this.authorHue(m.from, name)));
      if (m.from.sessionId && m.from.sessionId === this.room?.coordinatorId) from.append(this.el('span', 'ca-tag', 'Admin'));
      if (m.from.kind === 'bot') from.append(this.el('span', 'ca-tag ca-tag--bot', 'Bot'));
      const time = this.el('time', 'ca-time', new Date(m.at).toLocaleString([], { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }));
      time.dateTime = new Date(m.at).toISOString();
      meta.append(from, time);
      if (m.external) meta.append(this.el('span', m.own ? 'ca-tag eg-own' : 'ca-tag eg-trust', m.own ? 'Sent from this console' : 'UNTRUSTED EXTERNAL'));
      if (direct) meta.append(this.el('span', 'ca-msg-to', `→ ${m.to.map((r) => this.app._chatNameOf(r)).join(', ')}`));
      if (m.voice) meta.prepend(this.el('span', 'ca-voice-mark', '\u{1F3A4}'));
      body.append(meta);
    }
    if (this._editing?.id === m.id && !m.poll) body.append(this.editorEl(m));
    else if (m.poll) body.append(this.pollEl(m));
    else if (m.text) {
      const text = this.app._chatTextEl ? this.app._chatTextEl(m.text) : this.el('div', 'chatroom-msg-text', m.text);
      if (m.external) text.classList.add('eg-text');
      this.decorateMentions(text);
      if (m.edited) {
        const mark = this.el('span', 'ca-edited', '(edited)');
        mark.title = `Edited ${new Date(m.edited.at).toLocaleString()}`;
        text.append(' ', mark);
      }
      body.append(text);
    }
    const files = !m.external && this.app._chatAttachmentsEl?.(m);
    if (files) body.append(files);
    if (!m.external && this.app._chatReactionsEl) body.append(this.app._chatReactionsEl(m));
    if (m.audioUrl) {
      const play = this.el('button', 'ca-btn', '▶ Play');
      play.type = 'button';
      play.addEventListener('click', () => this.app._playChatAudio(m.audioUrl));
      body.append(play);
    }
    el.append(gutter, body);
    if (!m.external && this.serverFeatures.replies) {
      el.append(this.actionsEl(m));
    }
    return el;
  }

  /**
   * Draw the room's messages again. Opening a room lands on the newest; `keepScroll` redraws where the reader already is, and a
   * reader within a thumb's width of the bottom stays pinned to it, so they keep following new messages.
   */
  renderFeed({ keepScroll = false } = {}) {
    if (this.embassy?.selected) return this.embassy.renderPosts();
    const feed = this.app._chatEls.feed;
    this.app._watchChatFeedTop?.(feed);
    if (!feed._caStick) {
      feed._caStick = true;
      feed.addEventListener('scroll', () => (this._feedStick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60), { passive: true });
    }
    const top = feed.scrollTop;
    const pinned = feed.scrollHeight - top - feed.clientHeight < 40;
    feed.replaceChildren();
    const messages = this.room?.messages || [];
    this._readMarkAt = this.serverFeatures.unread ? Number(this.room?.userReadAt) || 0 : 0;
    if (!messages.length) {
      feed.append(this.el('p', 'ca-feed-empty', this.room && caIsDm(this.room) ? `This is the beginning of your conversation with @${caRoomLabel(this.room)}.` : `This is the start of #${this.room?.name || 'the channel'}. Say hello: everyone in the channel reads it.`));
    }
    for (const item of caFeedItems(messages, this._readMarkAt)) feed.append(this.feedNode(item));
    this.app._chatPendingDraw?.();
    feed.scrollTop = keepScroll && !pinned ? top : feed.scrollHeight;
    this._feedStick = !(keepScroll && !pinned);
    this.markReadSoon();
  }

  feedNode(item) {
    if (item.type === 'day') {
      const d = this.el('div', 'ca-day');
      d.setAttribute('role', 'separator');
      d.append(this.el('span', '', item.label));
      return d;
    }
    if (item.type === 'new') {
      const n = this.el('div', 'ca-new');
      n.setAttribute('role', 'separator');
      n.append(this.el('span', '', 'NEW'));
      return n;
    }
    return this.messageEl(item.m, item.head);
  }

  /** A live message arrives: draw it after the last one, with its day divider or group head as needed. */
  appendMessage(m) {
    const feed = this.app._chatEls.feed;
    feed.querySelector(':scope > .ca-feed-empty')?.remove();
    const messages = this.room.messages;
    const idx = messages.findIndex((x) => x.id === m.id);
    const prev = idx > 0 ? messages[idx - 1] : undefined;
    if (!prev || caDayKey(prev.at) !== caDayKey(m.at)) feed.append(this.feedNode({ type: 'day', label: caDayLabel(m.at) }));
    feed.append(this.messageEl(m, !caContinues(prev, m)));
  }

  /* ── live events (called from chatroom-ui.js) ── */

  noteSeen(data) {
    this.seenAt[data.roomId] = Math.max(this.seenAt[data.roomId] || 0, data.message?.at || 0);
  }

  /** A new message. Returns true when handled, so the floating-panel code does not run. */
  handleMessage(data) {
    if (!this.built) return false;
    const room = this.rooms.find((r) => r.id === data.roomId);
    // Something new arrives in a closed direct message: it comes back.
    if (room && caIsDm(room) && data.message?.from?.kind !== 'user') this.reopenDm(room.id);
    // A member that posts in the room it was woken from is done there (a quick answer ends "is typing").
    if (data.message?.from?.kind === 'agent' && this.dropTurn(`${data.roomId}|${data.message.from.sessionId}`)) this.renderTyping();
    const open = !this.embassy?.selected && this.active && data.roomId === this.roomId && this.room;
    if (open) {
      if (this.room.messages.some((m) => m.id === data.message.id)) return true;
      this.room.messages.push(data.message);
      this.noteSeen(data);
      const feed = this.app._chatEls.feed;
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      this.appendMessage(data.message);
      this.app._chatPendingDraw?.();
      if (atBottom || data.message.from.kind === 'user') feed.scrollTop = feed.scrollHeight;
      if (atBottom && this.doc.visibilityState !== 'hidden') this.markReadSoon();
      else this.countMessage(data, room);
      return true;
    }
    this.countMessage(data, room);
    return true;
  }

  countMessage(data, room) {
    this.noteSeen(data);
    if (!room) {
      // A room this page has not heard of: one list fetch for a burst, on the shared 150ms timer.
      clearTimeout(this._listTimer);
      this._listTimer = setTimeout(() => this.refreshRooms(), 150);
      return;
    }
    Object.assign(room, chatCountsAfterMessage(room, data.message, this.app._chatOwnerNames));
    room.lastMessageAt = data.message.at;
    // An older server sends no counts: keep the terminal UI's own running total, as it always did.
    if (!this.serverFeatures.unread && data.message.from?.kind === 'agent') {
      this.app._chatUnread = (this.app._chatUnread || 0) + 1;
    }
    this.renderRail();
    this.renderSidebar();
    this.app._renderChatBadge?.();
  }

  /** A room changed (created, renamed, members, archived, read elsewhere). */
  handleChanged(data) {
    if (!this.built) return false;
    if (data?.action === 'read' && data?.roomId === this.roomId) return true;
    clearTimeout(this._changedTimer);
    this._changedTimer = setTimeout(async () => {
      this.refreshProfiles();
      if (data?.action === 'created' || data?.action === 'deleted' || data?.roomId !== this.roomId) {
        await this.refreshRooms({ reloadCurrent: data?.action === 'deleted' && data?.roomId === this.roomId });
      } else if (data?.action === 'emotes') {
        this.app._loadChatEmotes?.().then(() => this.renderFeed());
      } else {
        await this.app._loadChatRoom(this.roomId, { quiet: true });
        await this.refreshRooms({ keepRoom: true });
      }
    }, 150);
    return true;
  }

  /**
   * Fetch the room list and keep it right: repeats (briefly, a few times) while a snapshot is older
   * than a message already seen over SSE, so a count is never lost to a race with a read.
   */
  async refreshRooms({ attempt = 0, reloadCurrent = false, keepRoom = false } = {}) {
    const res = await this.app._chatApi('/api/chatrooms');
    if (!res.ok) return;
    this.app._chatRooms = res.data.rooms || [];
    this.app._chatFeatures = res.data.features || this.app._chatFeatures;
    this.app._chatOwnerNames = Array.isArray(res.data.ownerNames) ? res.data.ownerNames : this.app._chatOwnerNames;
    this.app._chatRetired = Array.isArray(res.data.retired) ? res.data.retired : this.app._chatRetired;
    const stillThere = this.rooms.some((r) => r.id === this.roomId);
    if ((!stillThere || reloadCurrent) && !keepRoom && !this.app._chatCreating) {
      await this.loadRooms();
    } else {
      this.renderAll();
    }
    if (attempt < 3 && chatStaleRoomIds(this.rooms, this.seenAt).length) {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      return this.refreshRooms({ attempt: attempt + 1, keepRoom: true });
    }
  }

  markReadSoon() {
    if (this.embassy?.selected) { this.embassy.markRead(); return; }
    clearTimeout(this._readTimer);
    this._readTimer = setTimeout(() => this.markRead(), 250);
  }

  /** The user can see the newest message of the open room: move the server-side read cursor. */
  async markRead() {
    if (this.embassy?.selected) { this.embassy.markRead(); return; }
    if (!this.active || !this.serverFeatures.unread) return;
    const entry = this.rooms.find((r) => r.id === this.roomId);
    const room = this.room;
    if (!room || !entry || this.doc.visibilityState === 'hidden') return;
    const feed = this.app._chatEls.feed;
    if (feed.hidden || feed.scrollHeight - feed.scrollTop - feed.clientHeight > 60) return;
    // One person, one badge: the chats folded under this one are read with it.
    const folded = caFoldedUnreadIds(this.rooms, this.roomId, this.closedDms, caEmployeeBySession(this.company));
    // The server's own count decides: nothing unread (including another owner's room) means no request.
    if (!entry.unread && !entry.mentions && !folded.length) return;
    for (const id of folded) {
      const r = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
      if (!r.ok) return;
    }
    if (!entry.unread && !entry.mentions) {
      await this.refreshRooms({ keepRoom: true });
      return;
    }
    const newest = room.messages.at(-1)?.at;
    const res = await this.app._chatApi(`/api/chatrooms/${encodeURIComponent(this.roomId)}/read`, {
      method: 'POST',
      body: newest ? { at: newest } : {},
    });
    if (!res.ok) return;
    await this.refreshRooms({ keepRoom: true });
  }
}

/* ───────────────────────── wiring into ReverieApp ───────────────────────── */

function caInstall(proto) {
  const original = {
    isChatroomOpen: proto.isChatroomOpen,
    openChatroom: proto.openChatroom,
    toggleChatroom: proto.toggleChatroom,
    closeChatroom: proto.closeChatroom,
    _applyChatLayout: proto._applyChatLayout,
    _fitChatToKeyboard: proto._fitChatToKeyboard,
    _renderChatBadge: proto._renderChatBadge,
    _sendChatMessage: proto._sendChatMessage,
    _attachChatFiles: proto._attachChatFiles,
    _chatApi: proto._chatApi,
    setPendingHook: proto.setPendingHook,
    clearPendingHooks: proto.clearPendingHooks,
    _onSessionUpdated: proto._onSessionUpdated,
    _chatAvatar: proto._chatAvatar,
    _chatVoiceTarget: proto._chatVoiceTarget,
    _syncChatMic: proto._syncChatMic,
    _renderChatTo: proto._renderChatTo,
    renderApprovals: proto.renderApprovals,
    handleNotificationAction: proto.handleNotificationAction,
    _selectUrlSession: proto._selectUrlSession,
    setConnectionStatus: proto.setConnectionStatus,
  };
  Object.assign(proto, {
    isChatroomOpen() {
      if (this._chatApp?.built) return this._chatApp.active && !!this._chatroomPanel && !this._chatroomPanel.hidden;
      return original.isChatroomOpen.call(this);
    },
    openChatroom(roomId) {
      if (!this._chatApp?.built) return original.openChatroom.call(this, roomId);
      this._chatApp.showChat();
      return roomId ? this._chatApp.selectRoom(roomId) : undefined;
    },
    toggleChatroom() {
      if (!this._chatApp?.built) return original.toggleChatroom.call(this);
      this._chatApp.showChat();
    },
    closeChatroom() {
      if (this._chatApp?.built) return undefined;
      return original.closeChatroom.call(this);
    },
    _applyChatLayout() {
      if (this._chatApp?.built) return undefined;
      return original._applyChatLayout.call(this);
    },
    _fitChatToKeyboard() {
      if (this._chatApp?.built) return undefined;
      return original._fitChatToKeyboard.call(this);
    },
    // Approvals changed: the shell's own indicator follows the terminal UI's bell.
    renderApprovals(...args) {
      const result = original.renderApprovals?.apply(this, args);
      this._chatApp?.renderApprovals?.();
      return result;
    },
    // Opening a session from a notification is a request for its terminal, not for the chat view.
    handleNotificationAction(action, approvalId, sessionId) {
      const reviewing = !!approvalId && this.approvalsInboxEnabled?.();
      if (this._chatApp?.built && this._chatApp.active && !reviewing && sessionId && this.sessions?.has(sessionId)) {
        this._chatApp.setView('debug');
      }
      return original.handleNotificationAction?.call(this, action, approvalId, sessionId);
    },
    // A `#session=<id>` link is a request for that session's terminal: go there at once, even when the
    // session is not in the list yet (the app waits for it and selects it when it appears).
    _selectUrlSession() {
      if (this._chatApp?.built && this._urlSessionId) this._chatApp.setView('debug');
      return original._selectUrlSession.call(this);
    },
    // The message being replied to (the composer sends its id, and a reply answers its author).
    _chatReplyTarget() {
      return this._chatApp?.replyTarget?.() || null;
    },
    _chatReplySent() {
      this._chatApp?.cancelReplySilently?.();
    },
    // An agent wears the icon it chose for itself (its profile) in every channel and workspace; the room's own member
    // icon is only the fallback for an agent with no profile icon.
    _chatAvatar(sessionId, name, opts) {
      const el = original._chatAvatar.call(this, sessionId, name, opts);
      const app = this._chatApp?.built ? this._chatApp : null;
      // A picture the agent set for itself wins; the emoji icon (profile, then room) is the fallback.
      const avatar = app ? app.profileAvatar(sessionId, this._chatMember?.(sessionId)) : '';
      if (avatar && app.fillAvatar(el, avatar)) return el;
      const icon = app ? app.profileIcon(sessionId) || this._chatMember?.(sessionId)?.icon || '' : '';
      if (icon && !(app && app.fillAvatar(el, icon))) {
        // An icon that is not an image (an emoji) replaces the letter; one that looks like an image reference but is not safe is not shown.
        if (Array.from(String(icon)).length <= 4) {
          el.classList.add('has-icon');
          const glyph = el.querySelector('.chatroom-avatar-glyph');
          if (glyph) glyph.textContent = icon;
        }
      }
      return el;
    },
    // Voice belongs to voice channels: the voice member is the room's, and the mic shows nowhere else.
    _chatVoiceTarget() {
      if (this._chatApp?.embassy?.selected) return null;
      if (!this._chatApp?.built) return original._chatVoiceTarget.call(this);
      return this._chatRoom?.members?.find((m) => m.voice === true) || null;
    },
    _syncChatMic() {
      original._syncChatMic.call(this);
      if (this._chatApp?.built && !caIsVoice(this._chatRoom)) this._chatEls.mic.hidden = true;
    },
    _renderChatTo() {
      original._renderChatTo.call(this);
      if (this._chatApp?.built) this._chatEls.to.value = '';
    },
    // A room made from "+" in a workspace (or the rail's new workspace) is placed there as it is created.
    async _chatApi(path, opts) {
      const res = await original._chatApi.call(this, path, opts);
      const app = this._chatApp;
      const place = app?._pendingPlacement;
      // Kept until a create succeeds, so a retry after a refusal still lands in the workspace.
      if (place && opts?.method === 'POST' && path === '/api/chatrooms') {
        if (res.ok && res.data?.id) {
          app._pendingPlacement = null;
          const put = await original._chatApi.call(this, `/api/chatrooms/${encodeURIComponent(res.data.id)}/placement`, {
            method: 'PUT',
            body: place,
          });
          if (!put.ok) app.toast(`Chat: created, but not placed in the workspace (${put.error})`, 'error');
        }
      }
      return res;
    },
    // The live stream does not replay what was sent while it was down (the heartbeat watchdog or a page coming back
    // into view reconnects a dead one), so every time it (re)opens, the open room catches up from the last message
    // proved complete. That includes the page's first open: the transport's own state is the only signal used (no
    // memory of earlier opens, which a shell installed on an already-connected page would not have), and with
    // nothing missed it costs one small request.
    setConnectionStatus(status) {
      const was = this._connectionStatus;
      original.setConnectionStatus?.call(this, status);
      if (status !== 'connected' || was === 'connected') return;
      if (this._chatRoomId && !this._chatApp?.embassy?.selected) this._chatBackfill?.();
    },
    // A session's state changes (a hook arrives or clears, its status changes): the member dots follow.
    setPendingHook(sessionId, hookType) {
      original.setPendingHook?.call(this, sessionId, hookType);
      this._chatApp?.schedulePresence?.();
    },
    clearPendingHooks(sessionId, hookType) {
      original.clearPendingHooks?.call(this, sessionId, hookType);
      this._chatApp?.schedulePresence?.();
    },
    // This WRAPS the app's own SSE handler (it calls it first). The name is quoted so the one-definition guard in
    // sse-dispatch-table.test.ts, which looks for a second copy of a handler that would shadow the app's, does not read it as one.
    '_onSessionUpdated'(data) {
      const result = original._onSessionUpdated?.call(this, data);
      this._chatApp?.schedulePresence?.();
      return result;
    },
    async _sendChatMessage(options) {
      if (this._chatApp?.embassy?.selected) return this._chatApp.embassy.publish();
      const result = await original._sendChatMessage.call(this, options);
      this._chatApp?.fitInput?.();
      return result;
    },
    _attachChatFiles(files) {
      if (this._chatApp?.embassy?.selected) { this.showToast?.('Embassy attachments are not available yet', 'info'); return; }
      return original._attachChatFiles?.call(this, files);
    },
    _renderChatBadge() {
      original._renderChatBadge?.call(this);
      if (this._chatApp?.built) this._chatApp.renderChrome?.();
    },
    // The sidebar redraws whenever the room list is (re)loaded.
    _fillChatRoomSelect() {
      const { select } = this._chatEls;
      select.replaceChildren(new Option('', ''));
      if (this._chatApp?.built) this._chatApp.renderAll();
    },
    _renderChatMembers() {
      if (this._chatApp?.built) {
        this._chatApp.followRoom();
        this._chatApp.renderRail();
        this._chatApp.renderHeader();
        this._chatApp.renderMembers();
        this._chatApp.renderSidebar();
        this._chatApp.renderChrome();
      }
    },
    _renderChatFeed(opts) {
      if (this._chatApp?.built) return this._chatApp.renderFeed(opts);
      return undefined;
    },
    _chatMessageEl(m) {
      if (this._chatApp?.built) return this._chatApp.messageEl(m, true);
      return undefined;
    },
    _toggleChatRoomMenu(e) {
      if (this._chatApp?.built) return this._chatApp.openChannelMenu(this._chatApp.roomId, e.currentTarget, e.currentTarget);
      return undefined;
    },
  });
}

/** Start the app once the ReverieApp singleton exists. */
/** Pairing QR parsers are local and inert: no navigation, redeem or authority from labels. */
function caPairFields(value, version) {
  if (typeof value !== 'string' || value.length > 512 || new TextEncoder().encode(value).length > 512) throw new Error('Invalid pairing QR');
  const qr = value.trim(), fields = qr.split('|');
  if (fields.length !== 4 || fields[0] !== version) throw new Error('Invalid pairing QR');
  // Reuse the existing strict canonical HTTPS-origin parser; never accept arbitrary URLs.
  const { origin } = caEmbassyInvite(`embassy-v1|${fields[1]}|${'A'.repeat(43)}`);
  return { qr, origin, fields };
}
function caPairInvite(value) {
  const { qr, origin, fields } = caPairFields(value, 'embassy-v2');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fields[2]) || !/^[A-Za-z0-9_-]{43}$/.test(fields[3])) throw new Error('Invalid pairing invitation');
  return { qr, origin, roomId: fields[2] };
}
function caPairCode(value) {
  if (typeof value !== 'string' || value.length > 16) throw new Error('Invalid confirmation code');
  const code = value.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/.test(code)) throw new Error('Invalid confirmation code');
  const compact = code.replace('-', '');
  return compact.slice(0, 4) + '-' + compact.slice(4);
}
function caPairRequest(value, expectedOrigin) {
  const { qr, origin, fields } = caPairFields(value, 'embassy-pair-v1');
  if (origin !== expectedOrigin || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fields[2])) throw new Error('Wrong host or request');
  return { qr, origin, requestId: fields[2], code: caPairCode(fields[3]) };
}

/** Parse the existing guest key, or our fragment-only sharing envelope. No I/O. */
function caEmbassyInvite(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid invite');
  value = value.trim();
  let claimedHost = null;
  if (!value.startsWith('embassy-v1|')) {
    const link = new URL(value);
    if (link.protocol !== 'https:' || link.username || link.password || link.search || link.pathname !== '/') throw new Error('Invalid invite');
    const fields = new URLSearchParams(link.hash.slice(1));
    if ([...fields].length !== 3 || fields.get('embassy') !== '1' || !fields.has('host') || !fields.has('key') || new Set(fields.keys()).size !== 3) throw new Error('Invalid invite');
    claimedHost = fields.get('host');
    value = fields.get('key');
  }
  if (value.length > 512 || new TextEncoder().encode(value).length > 512) throw new Error('Invalid invite');
  const parts = value.split('|');
  if (parts.length !== 3 || parts[0] !== 'embassy-v1' || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw new Error('Invalid invite');
  const host = new URL(parts[1]);
  if (host.protocol !== 'https:' || host.origin !== parts[1] || host.username || host.password || host.pathname !== '/' || host.search || host.hash ||
      host.hostname.length > 253 || !host.hostname.includes('.') || /^[0-9.]+$/.test(host.hostname) ||
      !host.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      (claimedHost !== null && claimedHost !== host.origin)) throw new Error('Invalid invite');
  return { key: value, origin: host.origin };
}

function caEmbassyJoinLink(value) {
  const invite = caEmbassyInvite(value);
  const link = new URL('/', invite.origin);
  link.hash = new URLSearchParams({ embassy: '1', host: invite.origin, key: invite.key }).toString();
  return link.href;
}

function caEmbassyTakeFragment(win) {
  const staged = win.ReverieEmbassyInvite?.take?.();
  if (staged?.invalid) return { invalid: true };
  const hash = staged?.hash || win.location.hash;
  if (!/^#embassy(?:=|&)/.test(hash)) return null;
  // Invalid envelopes are scrubbed too. Preserve unrelated page/query state.
  try { if (!staged?.scrubbed) win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search); }
  catch { return { invalid: true }; }
  // The envelope is independent of the joining console's (possibly localhost)
  // origin. This dummy origin is parsed only and is never requested.
  try { return caEmbassyInvite('https://invite.invalid/' + hash); }
  catch { return { invalid: true }; }
}

const caEmbassyQrLoads = new Map();
function caEmbassyQrAsset(win, kind) {
  const loaded = () => kind === 'code' ? win.ReverieQRCode : win.jsQR;
  if (loaded()) return Promise.resolve(loaded());
  if (caEmbassyQrLoads.has(kind)) return caEmbassyQrLoads.get(kind);
  const promise = new Promise((resolve, reject) => {
    const script = win.document.createElement('script');
    script.src = kind === 'code' ? '/vendor/embassy-qr-code.min.js?v=1.5.4' : '/vendor/embassy-qr-scan.min.js?v=1.4.0';
    script.referrerPolicy = 'no-referrer';
    script.onload = () => loaded() ? resolve(loaded()) : reject(new Error('QR unavailable'));
    script.onerror = () => { script.remove(); caEmbassyQrLoads.delete(kind); reject(new Error('QR unavailable')); };
    win.document.head.append(script);
  });
  caEmbassyQrLoads.set(kind, promise);
  return promise;
}

/** Guest-only embassy conversations. External posts never enter local chat delivery. */
class ReverieEmbassyView {
  constructor(shell) {
    this.shell = shell;
    this.doc = shell.doc;
    this.win = this.doc.defaultView;
    this.connections = [];
    this.posts = new Map();
    this.pending = new Map();
    this.drafts = new Map();
    this.ownVerified = new Map();
    this.sentReceipts = new Map();
    this.allowed = false;
    this.selected = null;
    this.version = 0;
    this.listEpoch = 0;
    this.mutationUnknown = new Set();
    this.startInvite = caEmbassyIncomingInvite;
    caEmbassyIncomingInvite = null;
    this.win.addEventListener('hashchange', () => {
      const invite = caEmbassyTakeFragment(this.win);
      if (invite && this.allowed && !this.dialog) this.joinDialog(invite);
    });
    this.pairing = new ReverieEmbassyPairingView(this);
    this.collapsed = caRead('local', 'reverie:embassies:collapsed', '') === '1';
    this.refresh().catch(() => {});
    const tick = async () => {
      try { if (!this.doc.hidden) await this.refresh(); } catch { /* status is shown by refresh */ }
      this.timer = this.win.setTimeout(tick, 5000);
    };
    this.timer = this.win.setTimeout(tick, 5000);
  }
  el(tag, cls, text) { return this.shell.el(tag, cls, text); }
  button(label, run) { return this.shell.button('ca-btn eg-button', label, run, { text: label }); }
  async api(path = '', options = {}) {
    try {
      if (/^\/__host__\/posts(?:\?|$)/.test(path)) {
        if (!this.hostedConnection()) return { ok: false, error: 'Hosting unavailable' };
        return await this.pairing.api('/api/embassy-host/posts' + path.slice('/__host__/posts'.length), options);
      }
      return await this.shell.app._chatApi(`/api/embassy-guest${path}`, options);
    }
    catch { return { ok: false, error: 'Connection unavailable' }; }
  }
  failure(result) { return typeof result?.error === 'string' ? result.error : 'Request refused'; }
  key(id, kind) {
    const scope = id === '__host__' ? `__host__:${encodeURIComponent(this.hostScope || 'unbound')}` : id;
    return `reverie:embassy:${scope}:${kind}`;
  }
  syncHostScope() {
    const host = this.hostedConnection();
    const scope = host ? JSON.stringify([host.origin, host.roomId, this.pairing.host.bindingId || null]) : null;
    if (scope === this.hostScope) return;
    if (this.selected === '__host__') this.close();
    this.hostScope = scope;
    this.version++;
    for (const cache of [this.posts, this.pending, this.drafts, this.ownVerified, this.sentReceipts]) cache.delete('__host__');
    this.mutationUnknown.delete('__host__');
  }
  readCount(id) {
    const n = Number(caRead('local', this.key(id, 'read'), '0'));
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }
  unread(c) { return Math.max(0, (Number(c.postCount) || 0) - this.readCount(c.id)); }
  hostedConnection() {
    const p = this.pairing;
    if (!p?.owner || p.host.status !== 'ready') return null;
    return { id: '__host__', origin: p.host.origin, roomId: p.host.room.id, roomName: p.host.room.name,
      hostCompany: this.shell.defaultWorkspaceName(), enabled: true, status: 'live', expiresAt: Number.MAX_SAFE_INTEGER,
      postCount: this.posts.get('__host__')?.size || 0 };
  }
  availableConnections() { const host = this.hostedConnection(); return host ? [host, ...this.connections] : this.connections; }
  connection() { return this.availableConnections().find(c => c.id === this.selected); }
  async refresh() {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    const epoch = this.listEpoch;
    try {
      const result = await this.api();
      if (epoch !== this.listEpoch || this.changing) return;
      if (!result.ok) {
        this.ownerRequired = result.status === 403 || /HTTP 403|signed-in owner|owner dashboard/i.test(this.failure(result));
        this.lastFailure = { error: this.failure(result), status: Number.isInteger(result.status) ? result.status : undefined };
        // Do not retain a previous owner's external content after authorization disappears.
        this.allowed = false;
        this.pairing.deny();
        this.connections = [];
        this.posts.clear();
        this.pending.clear();
        this.ownVerified.clear();
        this.sentReceipts.clear();
        this.startInvite = null;
        this.cancelJoin?.();
        this.close();
        this.renderSidebar();
        return;
      }
      this.allowed = true;
      this.mutationUnknown.clear();
      this.ownerRequired = false;
      this.lastFailure = undefined;
      this.connections = Array.isArray(result.data?.connections) ? result.data.connections.filter(c => c?.id !== '__host__') : [];
      await this.pairing.refresh();
      if (this.selected && !this.connection()) this.close();
      this.renderSidebar();
      if (this.startInvite && !this.dialog) {
        const invite = this.startInvite; this.startInvite = null;
        this.joinDialog(invite);
      }
      if (this.selected) {
        this.updateControls();
        await this.loadPosts();
      }
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); }
    }
  }
  renderSidebar() {
    const host = this.shell.els.sideScroll;
    if (!host) return;
    const previous = host.querySelector('.eg-category');
    const focused = previous?.contains(this.doc.activeElement) ? this.doc.activeElement : null;
    const focusId = focused?.dataset?.connection;
    const focusLabel = focused?.getAttribute('aria-label');
    previous?.remove();
    host.querySelector('.eg-access-note')?.remove();
    if (!this.allowed) {
      if (this.ownerRequired) {
        const note = this.el('section', 'eg-access-note');
        note.setAttribute('role', 'status');
        note.append(this.el('strong', '', 'Embassies'), this.el('p', '', 'Embassies need owner sign-in: run reverie owner bootstrap, then sign in at /owner/login.'));
        const login = this.el('a', '', 'Owner sign-in');
        login.href = '/owner/login';
        note.append(login);
        host.append(note);
        this.renderDirectory();
        return;
      }
      // Any other failure stays visible with the real error: the section never silently disappears, and there is no
      // Add control until a refresh succeeds.
      const failure = this.lastFailure || { error: 'Request refused' };
      const note = this.el('section', 'eg-access-note');
      note.setAttribute('role', 'alert');
      const detail = failure.status ? `${failure.error} (HTTP ${failure.status})` : failure.error;
      note.append(this.el('strong', '', 'Embassies'), this.el('p', '', `Embassies unavailable: ${detail}`));
      const retry = this.button('Retry', () => { void this.refresh(); });
      retry.setAttribute('aria-label', 'Retry loading embassies');
      note.append(retry);
      host.append(note);
      this.renderDirectory();
      return;
    }
    const section = this.el('section', 'eg-category');
    const header = this.el('div', 'eg-category-head');
    const toggle = this.shell.button('ca-cat eg-category-toggle', 'Embassies', () => {
      this.collapsed = !this.collapsed;
      caWrite('local', 'reverie:embassies:collapsed', this.collapsed ? '1' : '0');
      this.renderSidebar();
      host.querySelector('.eg-category-toggle')?.focus();
    });
    const chevron = this.shell.icon('chevron');
    chevron.classList.add('ca-chev');
    chevron.classList.toggle('is-folded', this.collapsed);
    toggle.append(chevron, this.el('span', 'ca-name', 'Embassies'));
    toggle.setAttribute('aria-label', 'Embassies');
    toggle.setAttribute('aria-expanded', String(!this.collapsed));
    toggle.setAttribute('aria-controls', 'eg-channel-list');
    const add = this.shell.button('ca-icon-btn eg-add', 'Add embassy channel', () => this.pairing.open(), { icon: 'plus' });
    add.setAttribute('aria-label', 'Add embassy channel');
    const total = this.availableConnections().reduce((n, c) => n + this.unread(c), 0);
    header.append(toggle, this.el('span', 'eg-unread-total', total ? String(total) : ''), add);
    const list = this.el('div', 'eg-channel-list');
    list.id = 'eg-channel-list';
    list.hidden = this.collapsed;
    for (const c of this.availableConnections()) {
      const row = this.shell.button('ca-item eg-channel', c.roomName || 'Shared room', () => this.open(c.id), { text: c.roomName || 'Shared room' });
      row.dataset.connection = c.id;
      const label = row.querySelector('span');
      label.classList.add('ca-name', 'eg-channel-label');
      const mark = this.el('span', 'ca-hash is-drawn');
      mark.setAttribute('aria-hidden', 'true');
      mark.append(this.shell.icon('embassy'));
      row.prepend(mark);
      row.title = `${c.roomName} · ${c.origin} · ${c.status}`;
      const count = this.unread(c);
      row.setAttribute('aria-label', `${c.roomName} · ${c.origin}${count ? `, ${count} unread` : ''}`);
      if (c.id === this.selected) row.setAttribute('aria-current', 'page');
      row.append(this.el('span', 'eg-unread', count ? String(count) : ''));
      list.append(row);
    }
    if (!this.availableConnections().length) list.append(this.el('p', 'ca-hint', 'No embassy rooms connected'));
    section.append(header, list);
    host.append(section);
    this.renderDirectory();
    if (focused) [...section.querySelectorAll('button')].find(b => focusId ? b.dataset.connection === focusId : b.getAttribute('aria-label') === focusLabel)?.focus();
  }
  platformName() {
    const name = this.el('span', '', 'Reverie');
    // This is the platform name, independent of the company's display name.
    name.setAttribute('data-i18n-skip', '');
    return name;
  }
  directoryEl() {
    const box = this.el('section', 'eg-directory');
    box.setAttribute('aria-label', 'Embassy rooms');
    const intro = this.el('p', 'ca-hint');
    intro.append('Shared rooms with other companies, here in your own ', this.platformName(), '.');
    box.append(this.el('h1', '', 'Embassies'), intro);
    if (!this.allowed) {
      box.append(this.el('p', 'eg-directory-status', this.ownerRequired ? 'Sign in as the console owner to connect shared rooms.' : 'Checking embassy access…'));
      if (this.ownerRequired) { const a = this.el('a', '', 'Owner sign-in'); a.href = '/owner/login'; box.append(a); }
      return box;
    }
    const add = this.button('Add embassy channel', () => this.joinDialog());
    box.append(add);
    const list = this.el('div', 'eg-directory-list');
    for (const c of this.availableConnections()) {
      const row = this.button(c.roomName || 'Shared room', () => this.open(c.id));
      row.classList.add('eg-directory-room'); row.dataset.connection = c.id;
      row.append(this.el('small', '', `${c.hostCompany || 'External company'} · ${c.origin}`));
      row.append(this.el('span', `eg-connection-state is-${c.status}`, this.connectionState(c)));
      const count = this.unread(c); if (count) row.append(this.el('span', 'eg-unread', String(count)));
      const card = this.el('article', 'eg-directory-card');
      const disconnect = this.button('Disconnect', () => this.leave(c.id));
      disconnect.classList.add('eg-disconnect'); disconnect.disabled = !!this.changing || c.status === 'left';
      disconnect.setAttribute('aria-label', `Disconnect ${c.roomName || 'shared room'}`);
      card.append(row, disconnect); list.append(card);
    }
    if (!this.availableConnections().length) list.append(this.el('p', 'ca-hint', 'No shared rooms connected. Add a key, scan a QR or paste a link.'));
    box.append(list); return box;
  }
  connectionState(c) {
    if (c.id === '__host__') return 'Hosted here';
    return { live: 'Connected', connecting: 'Connecting…', disabled: 'Disabled here', left: 'Disconnected',
      unreachable: 'Connection unavailable', expired: 'Access expired', refused: 'Connection refused', 'storage-full': 'Local copy full' }[c.status] || 'Connection unavailable';
  }
  ownReceipts(id) {
    if (!this.sentReceipts.has(id)) {
      let receipts = [];
      try {
        const value = caRead('local', this.key(id, 'sent-receipts'), '[]');
        if (value.length <= 65536) {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed) && parsed.length <= 256) receipts = parsed.filter(r => r && typeof r.ackId === 'string' && r.ackId.length <= 64 &&
            Number.isSafeInteger(r.sequence) && r.sequence > 0 && /^[a-f0-9]{64}$/.test(r.sha256));
        }
      } catch { /* Missing/corrupt proof never turns an imported post into our own. */ }
      this.sentReceipts.set(id, receipts);
    }
    return this.sentReceipts.get(id);
  }
  async textDigest(text) {
    if (typeof text !== 'string') throw new Error('No receipt');
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 4096) throw new Error('No receipt');
    const digest = await this.win.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async rememberOwn(id, post, sent) {
    // Human-readable company/identity labels are spoofable. Only a confirmed
    // response to THIS console's exact publication can establish a local receipt.
    if (!this.allowed || !post || typeof post.ackId !== 'string' || post.ackId.length > 64 ||
        !Number.isSafeInteger(post.sequence) || post.sequence <= 0 || post.text !== sent.text) return;
    const key = this.key(id, 'sent-receipts'), version = this.version;
    try {
      const sha256 = await this.textDigest(sent.text);
      if (!this.allowed || version !== this.version || key !== this.key(id, 'sent-receipts')) return;
      const receipts = [...this.ownReceipts(id).filter(r => r.ackId !== post.ackId), { ackId: post.ackId, sequence: post.sequence, sha256 }].slice(-256);
      this.sentReceipts.set(id, receipts);
      caWrite('local', this.key(id, 'sent-receipts'), JSON.stringify(receipts));
    } catch { /* No crypto/storage capability: keep conservative provenance. */ }
  }
  async verifyOwn(id, posts) {
    const version = this.version, key = this.key(id, 'sent-receipts');
    const receipts = new Map(this.ownReceipts(id).map(r => [r.ackId, r]));
    const verified = new Set();
    await Promise.all(posts.filter(p => receipts.has(p.ackId)).slice(0, 256).map(async p => {
      try {
        const receipt = receipts.get(p.ackId);
        if (receipt.sequence === p.sequence && receipt.sha256 === await this.textDigest(p.text)) verified.add(p.ackId);
      } catch { /* Unverifiable content stays externally labelled. */ }
    }));
    if (this.allowed && version === this.version && key === this.key(id, 'sent-receipts')) this.ownVerified.set(id, verified);
  }
  renderDirectory() {
    if (this.shell.embed === 'embassies' && this.shell.els.page) {
      const page = this.shell.els.page;
      const id = page.contains(this.doc.activeElement) ? this.doc.activeElement.dataset.connection : null;
      page.replaceChildren(this.directoryEl());
      if (id) [...page.querySelectorAll('[data-connection]')].find(n => n.dataset.connection === id)?.focus();
    }
  }
  open(id) {
    if (!this.allowed || !this.availableConnections().some(c => c.id === id)) return;
    if (this.shell.app._chatSending) { this.shell.toast('Wait for the current message to finish sending', 'info'); return; }
    this.close(); this.shell.closePage();
    const app = this.shell.app, els = app._chatEls;
    // Reuse the actual local channel feed/composer. External records remain in
    // this adapter, never app._chatRoom, ChatroomStore or its agent wake path.
    this.localState = { input: els.input.value, maxLength: els.input.getAttribute('maxlength'),
      label: els.input.getAttribute('aria-label'), feedLabel: els.feed.getAttribute('aria-label'),
      feedHidden: els.feed.hidden, composerHidden: els.composer.hidden, emptyHidden: els.empty.hidden };
    els.feed.hidden = false; els.composer.hidden = false; els.empty.hidden = true;
    this.selected = id; this.version++;
    this.shell.setView('chat'); this.shell.toggleDrawer(null);
    this.panel = this.shell.els.chat; this.panel.classList.add('eg-view');
    this.feed = els.feed; this.feed.classList.add('eg-feed'); this.feed.dataset.signature = '';
    this.feed.setAttribute('aria-label', 'Embassy conversation');
    this.form = els.composer; this.form.classList.add('eg-composer'); this.form.dataset.connection = id;
    this.input = els.input; this.input.classList.add('eg-input'); this.input.maxLength = 4096;
    this.input.setAttribute('aria-label', 'Message to shared room');
    this.send = els.send;
    this.detail = this.el('section', 'eg-detail');
    this.status = this.el('p', 'eg-status'); this.status.setAttribute('role', 'status');
    this.origin = this.el('p', 'eg-origin'); this.controls = this.el('div', 'eg-controls');
    this.detail.append(this.status, this.origin, this.controls);
    this.notice = this.el('p', 'eg-notice'); this.notice.setAttribute('role', 'status');
    this.visibility = this.el('p', 'eg-visibility', 'UNTRUSTED EXTERNAL · Text and emoji shared with other companies. Files are not supported yet.');
    els.feed.before(this.detail); els.composer.before(this.notice, this.visibility);
    const pending = this.getPending(id); this.input.value = pending?.text || this.drafts.get(id) || '';
    this.shell.els.main.classList.add('eg-active');
    this.shell.cancelReplySilently?.();
    this.shell.renderHeader(); this.shell.renderMembers(); this.shell.renderChrome(); this.shell.renderSidebar();
    this.shell.renderTyping();
    this.updateControls(); this.renderPosts(); void this.loadPosts(); this.input.focus();
  }
  close() {
    if (!this.selected) return;
    if (this.input && this.form?.dataset.connection === this.selected) this.drafts.set(this.selected, this.input.value);
    this.version++; this.selected = null;
    this.detail?.remove(); this.notice?.remove(); this.visibility?.remove();
    this.panel?.classList.remove('eg-view'); this.feed?.classList.remove('eg-feed'); this.form?.classList.remove('eg-composer'); this.input?.classList.remove('eg-input');
    if (this.form) delete this.form.dataset.connection;
    if (this.localState) {
      this.input.value = this.localState.input;
      this.feed.hidden = this.localState.feedHidden; this.form.hidden = this.localState.composerHidden;
      this.shell.app._chatEls.empty.hidden = this.localState.emptyHidden;
      if (this.localState.maxLength === null) this.input.removeAttribute('maxlength'); else this.input.setAttribute('maxlength', this.localState.maxLength);
      if (this.localState.label === null) this.input.removeAttribute('aria-label'); else this.input.setAttribute('aria-label', this.localState.label);
      if (this.localState.feedLabel === null) this.feed.removeAttribute('aria-label'); else this.feed.setAttribute('aria-label', this.localState.feedLabel);
      this.localState = null;
    }
    this.input.disabled = false; this.input.readOnly = false; this.send.disabled = false; this.send.textContent = 'Send'; this.send.setAttribute('aria-label', 'Send message');
    this.panel = null; this.shell.els.main.classList.remove('eg-active');
    this.shell.renderHeader(); this.shell.renderMembers(); this.shell.renderFeed(); this.shell.renderChrome(); this.shell.syncComposer?.(); this.shell.renderTyping();
  }
  renderPosts() {
    if (!this.selected || !this.feed) return;
    const values = [...(this.posts.get(this.selected)?.values() || [])].sort((a, b) => a.sequence - b.sequence);
    const top = this.feed.scrollTop, pinned = this.feed.scrollHeight - top - this.feed.clientHeight < 40;
    this.feed.replaceChildren();
    if (!values.length) this.feed.append(this.el('p', 'ca-feed-empty', 'This is the start of the shared room. Say hello.'));
    for (const p of values) {
      const own = this.ownVerified.get(this.selected)?.has(p.ackId) === true;
      const row = this.shell.messageEl({ id: `embassy:${this.selected}:${p.ackId}`, at: Number(p.at) || Date.now(), to: 'all',
        from: { kind: own ? 'user' : 'external', name: `${p.author?.company || 'External'} · ${p.author?.identity || 'Guest'}` }, text: p.text, external: true, own }, true);
      row.classList.add('eg-post'); row.dataset.post = p.ackId; this.feed.append(row);
    }
    this.feed.scrollTop = pinned ? this.feed.scrollHeight : top;
  }
  updateControls() {
    const c = this.connection();
    if (!c || !this.panel) return;
    this.shell.renderHeader();
    this.origin.textContent = c.id === '__host__' ? `${c.origin} · Hosted room` : `${c.hostCompany} · ${c.origin} · Guest access (TLS origin; no signed identity pin)`;
    const state = this.mutationUnknown.has(c.id) ? 'State change unconfirmed' : c.status === 'disabled' ? 'Disabled here' : c.status;
    this.status.textContent = `${this.mutationUnknown.has(c.id) ? state : this.connectionState(c)}${c.lastError ? ` · ${c.lastError}` : ''}`;
    const controlFocus = this.controls.contains(this.doc.activeElement) ? this.doc.activeElement?.getAttribute('aria-label') : null;
    this.controls.replaceChildren();
    if (c.id === '__host__') {
      this.controls.append(this.button('Invite a company', () => this.pairing.open('invite')), this.button('Manage invitations', () => this.pairing.open('manage')));
    } else if (c.status !== 'left') {
      this.controls.append(this.button(c.enabled ? 'Disable' : 'Enable', () => this.setEnabled(c.id, !c.enabled)),
        this.button('Disconnect', () => this.leave(c.id)));
    }
    for (const b of this.controls.querySelectorAll('button')) b.disabled = !!this.changing;
    if (controlFocus) [...this.controls.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === controlFocus)?.focus();
    const pending = this.getPending(c.id);
    this.send.textContent = pending ? 'Retry same message' : 'Send';
    this.send.setAttribute('aria-label', pending ? 'Retry same message' : 'Send message');
    this.send.disabled = !!this.sending || this.changing === c.id || this.mutationUnknown.has(c.id) || !c.enabled || !['live', 'connecting'].includes(c.status) || c.expiresAt <= Date.now();
    this.input.disabled = this.changing === c.id || this.mutationUnknown.has(c.id) || !c.enabled || c.status === 'left' || c.status === 'expired';
    this.input.readOnly = !!pending;
    if (pending) this.notice.textContent = 'Not confirmed. Retry keeps the original message and request id; do not send it again as a new message.';
  }
  async loadPosts() {
    const id = this.selected, version = this.version;
    if (!id || this.loading === id) return;
    this.loading = id;
    try {
      const items = this.posts.get(id) || new Map();
      let after = Math.max(0, ...[...items.values()].map(p => p.sequence));
      for (let page = 0; page < 10; page++) {
        const result = await this.api(`/${encodeURIComponent(id)}/posts?after=${after}`);
        if (version !== this.version || this.selected !== id) return;
        if (!result.ok) { this.notice.textContent = this.failure(result); return; }
        const incoming = result.data?.posts || [];
        for (const p of incoming) {
          if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0 || typeof p.ackId !== 'string') continue;
          items.set(p.ackId, p);
        }
        this.posts.set(id, items);
        if (incoming.length < 200 || !(result.data.next > after)) break;
        after = result.data.next;
      }
      if (version !== this.version || this.selected !== id) return;
      await this.verifyOwn(id, [...items.values()]);
      if (version !== this.version || this.selected !== id) return;
      const sig = [...items.values()].sort((a, b) => a.sequence - b.sequence).map(p => `${p.ackId}:${this.ownVerified.get(id)?.has(p.ackId) ? 1 : 0}`).join('|');
      if (sig !== this.feed.dataset.signature) { this.feed.dataset.signature = sig; this.renderPosts(); }
      this.markRead();
    } finally { if (this.loading === id) this.loading = null; }
  }
  markRead() {
    if (!this.selected || !this.feed || this.doc.hidden || this.shell.view !== 'chat') return;
    if (this.feed.scrollHeight - this.feed.clientHeight - this.feed.scrollTop > 40) return;
    const count = this.posts.get(this.selected)?.size || 0;
    if (count > this.readCount(this.selected)) {
      caWrite('local', this.key(this.selected, 'read'), String(count));
      this.renderSidebar();
    }
  }
  getPending(id) {
    if (!this.pending.has(id)) {
      try {
        const value = JSON.parse(caRead('session', this.key(id, 'pending'), 'null'));
        if (value && typeof value.text === 'string' && typeof value.requestId === 'string') this.pending.set(id, value);
      } catch { /* no saved operation */ }
    }
    return this.pending.get(id);
  }
  async publish() {
    const c = this.connection();
    if (!c || this.send.disabled || this.sending) return;
    const id = c.id;
    let pending = this.getPending(id);
    if (!pending) {
      const text = this.input.value.trim();
      if (!text) return;
      if (new TextEncoder().encode(text).length > 4096) { this.notice.textContent = 'Message exceeds 4096 bytes'; return; }
      pending = { text, requestId: this.win.crypto.randomUUID() };
      caWrite('session', this.key(id, 'pending'), JSON.stringify(pending));
      if (caRead('session', this.key(id, 'pending'), '') !== JSON.stringify(pending)) {
        this.notice.textContent = 'Cannot save retry identity in this tab. Sending is paused until browser storage is available.';
        return;
      }
      this.pending.set(id, pending);
    }
    const version = this.version, key = this.key(id, 'pending');
    this.sending = true;
    this.updateControls();
    const result = await this.api(`/${encodeURIComponent(id)}/posts`, { method: 'POST', body: pending });
    this.sending = false;
    if (version !== this.version || key !== this.key(id, 'pending')) return;
    if (result.ok) {
      await this.rememberOwn(id, result.data?.post, pending);
      if (version !== this.version || key !== this.key(id, 'pending')) return;
      this.pending.delete(id);
      this.drafts.delete(id);
      caWrite('session', this.key(id, 'pending'), 'null');
    }
    if (this.selected === id) {
      if (result.ok) { this.input.value = ''; this.notice.textContent = 'Posted'; await this.loadPosts(); }
      else this.notice.textContent = `Not confirmed. ${this.failure(result)} Retry uses the same message id.`;
      this.updateControls();
      this.shell.fitInput?.(); this.shell.syncComposer?.();
    }
  }
  async mutateConnection(id, options) {
    if (this.changing) return;
    this.changing = id;
    this.listEpoch++;
    this.version++;
    this.updateControls();
    const result = await this.api(`/${encodeURIComponent(id)}`, options);
    // Also invalidate snapshots started while the write was still in flight.
    this.listEpoch++;
    if (result.ok && result.data?.id === id) {
      this.connections = this.connections.map(c => c.id === id ? result.data : c);
      this.mutationUnknown.delete(id);
    } else {
      this.mutationUnknown.add(id);
      if (this.selected === id) this.notice.textContent = this.failure(result);
    }
    this.changing = null;
    this.renderSidebar();
    this.updateControls();
    await this.refresh();
  }
  async setEnabled(id, enabled) {
    await this.mutateConnection(id, { method: 'PUT', body: { enabled } });
  }
  async leave(id) {
    if (!this.win.confirm('Disconnect this embassy room? Sending and syncing stop. Synced history and copies elsewhere remain.')) return;
    await this.mutateConnection(id, { method: 'DELETE' });
  }
  joinDialog(initial = null) {
    if (!this.allowed || this.dialog) return;
    const dlg = this.el('dialog', 'ca-dialog eg-dialog');
    this.dialog = dlg;
    dlg.setAttribute('aria-label', 'Add embassy channel');
    const title = this.el('h2', '', 'Add embassy channel');
    const explain = this.el('p', '', 'Paste a key, scan a QR, or paste an invite link. Confirm the host before connecting. Guest access only.');
    const label = this.el('label', '', 'Invite key');
    const input = this.el('input', 'eg-key');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 2048;
    label.append(input);
    const note = this.el('p', 'eg-join-status');
    note.setAttribute('role', 'status');
    let secret = '', origin = '', joining = false, closed = false, stream = null, scanTimer = null, cameraEpoch = 0, renderEpoch = 0, shareLink = '';
    const valid = () => !closed && this.allowed && this.dialog === dlg;
    const tools = this.el('div', 'eg-join-tools');
    const qr = this.el('section', 'eg-qr-output'); qr.hidden = true;
    const qrCanvas = this.el('canvas', 'eg-qr-canvas');
    qrCanvas.setAttribute('role', 'img'); qrCanvas.setAttribute('aria-label', 'Private embassy invite QR');
    const shareLabel = this.el('label', '', 'Invite link (private)');
    const shareInput = this.el('input', 'eg-share-link'); shareInput.type = 'password'; shareInput.readOnly = true; shareInput.autocomplete = 'off';
    shareLabel.append(shareInput);
    const scan = this.el('section', 'eg-scan'); scan.hidden = true;
    const linkLabel = this.el('label', '', 'Invite link');
    const linkInput = this.el('input', 'eg-invite-link'); linkInput.type = 'password'; linkInput.autocomplete = 'off'; linkInput.maxLength = 2048; linkInput.spellcheck = false;
    linkLabel.append(linkInput);
    const video = this.el('video', 'eg-scan-video'); video.muted = true; video.playsInline = true; video.hidden = true;
    const stopCamera = () => {
      cameraEpoch++;
      if (scanTimer !== null) this.win.clearTimeout(scanTimer);
      scanTimer = null;
      for (const track of stream?.getTracks() || []) track.stop();
      stream = null; video.srcObject = null; video.hidden = true;
    };
    const clearQR = () => {
      renderEpoch++; shareLink = ''; shareInput.value = ''; shareInput.type = 'password';
      qrCanvas.width = 0; qrCanvas.height = 0; qr.hidden = true;
    };
    const acceptInvite = (value) => {
      const invite = caEmbassyInvite(value);
      if (!valid()) return;
      stopCamera(); clearQR(); linkInput.value = ''; input.value = invite.key; scan.hidden = true;
      note.textContent = `Invite ready for ${invite.origin}. Choose Check host, then confirm.`;
      next.focus();
    };
    const showQR = this.button('Show QR', async () => {
      stopCamera(); clearQR(); scan.hidden = true; linkInput.value = '';
      const epoch = renderEpoch;
      try {
        const link = caEmbassyJoinLink(input.value);
        const encoder = await caEmbassyQrAsset(this.win, 'code');
        if (!valid() || epoch !== renderEpoch) return;
        await encoder.toCanvas(qrCanvas, link, { errorCorrectionLevel: 'M', margin: 4, width: 320 });
        if (!valid() || epoch !== renderEpoch) { qrCanvas.width = 0; return; }
        shareLink = link; shareInput.value = link; qr.hidden = false;
        note.replaceChildren('Private invite: scan or paste it in your own ', this.platformName(), ' console. Anyone with it can use its guest access.');
      } catch { if (valid()) note.textContent = 'QR unavailable or invalid key. Paste a valid key, or join using the key directly.'; }
    });
    const copy = this.button('Copy invite link', async () => {
      if (!valid() || !shareLink) return;
      try { await this.win.navigator.clipboard.writeText(shareLink); if (valid()) note.textContent = 'Invite link copied. Share it privately.'; }
      catch { if (valid()) { shareInput.type = 'text'; shareInput.focus(); shareInput.select(); note.textContent = 'Select and copy the invite link. Share it privately.'; } }
    });
    qr.append(qrCanvas, this.el('p', '', 'Scan from Embassies + → Scan/paste link in the joining company’s console.'), shareLabel, copy);
    const useLink = this.button('Use link', () => {
      const value = linkInput.value; linkInput.value = '';
      try { acceptInvite(value); } catch { note.textContent = 'Invalid invite link. No connection was made.'; }
    });
    const startCamera = this.button('Scan with camera', async () => {
      stopCamera(); const epoch = cameraEpoch;
      if (!this.win.navigator.mediaDevices?.getUserMedia) { note.textContent = 'Camera unavailable. Paste the link or choose a QR image.'; return; }
      try {
        const decoder = await caEmbassyQrAsset(this.win, 'scan');
        if (!valid() || epoch !== cameraEpoch) return;
        const camera = await this.win.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (!valid() || epoch !== cameraEpoch) { for (const track of camera.getTracks()) track.stop(); return; }
        stream = camera; video.srcObject = camera; video.hidden = false; await video.play();
        const canvas = this.el('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const deadline = Date.now() + 60000;
        const tick = () => {
          if (!valid() || epoch !== cameraEpoch || this.doc.hidden || Date.now() > deadline) { stopCamera(); return; }
          try {
            if (video.videoWidth && video.videoHeight) {
              const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
              canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = decoder(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
              if (code) { acceptInvite(code.data); canvas.width = 0; return; }
            }
          } catch { note.textContent = 'No valid embassy invite found yet. You can paste the link instead.'; }
          scanTimer = this.win.setTimeout(tick, 250);
        };
        note.textContent = 'Camera scans locally. No images are uploaded.'; tick();
      } catch { stopCamera(); if (valid()) note.textContent = 'Camera unavailable. Paste the link or choose a QR image.'; }
    });
    const stop = this.button('Stop camera', stopCamera);
    const fileLabel = this.el('label', '', 'Choose QR image');
    const file = this.el('input', 'eg-qr-file'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; fileLabel.append(file);
    file.addEventListener('change', async () => {
      stopCamera(); const epoch = cameraEpoch; const imageFile = file.files?.[0]; file.value = '';
      if (!imageFile) return;
      if (imageFile.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(imageFile.type)) { note.textContent = 'Choose a PNG, JPEG or WebP QR image up to 5 MB.'; return; }
      let bitmap = null;
      try {
        const decoder = await caEmbassyQrAsset(this.win, 'scan');
        if (!valid() || epoch !== cameraEpoch) return;
        bitmap = await this.win.createImageBitmap(imageFile);
        if (!valid() || epoch !== cameraEpoch) return;
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16000000) throw new Error('Image too large');
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = this.el('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = decoder(image.data, image.width, image.height); canvas.width = 0;
        if (!code) throw new Error('No QR');
        acceptInvite(code.data);
      } catch { if (valid()) note.textContent = 'No valid embassy QR found. Paste the invite link instead.'; }
      finally { bitmap?.close(); }
    });
    scan.append(linkLabel, useLink, startCamera, stop, fileLabel, video);
    const scanLink = this.button('Scan/paste link', () => { stopCamera(); clearQR(); scan.hidden = false; linkInput.focus(); });
    tools.append(showQR, scanLink);
    input.addEventListener('input', clearQR);
    const next = this.button('Check host', async () => {
      if (next.disabled) return;
      next.disabled = true;
      const value = input.value;
      input.value = '';
      stopCamera(); clearQR(); linkInput.value = ''; scan.hidden = true;
      const result = await this.api('/preview', { method: 'POST', body: { key: value } });
      if (!valid()) return;
      if (!result.ok) { note.textContent = 'Invalid invite key. Paste a valid key to try again.'; next.disabled = false; return; }
      secret = value;
      origin = result.data.origin;
      label.hidden = true;
      tools.hidden = true;
      note.textContent = `Connect this server to ${origin}? Room details appear only after joining.`;
      next.textContent = 'Connect';
      next.setAttribute('aria-label', 'Connect');
      next.disabled = false;
      next.replaceWith(confirm);
      confirm.focus();
    });
    const cleanup = () => {
      if (closed) return;
      closed = true; stopCamera(); clearQR(); secret = ''; input.value = ''; linkInput.value = ''; file.value = '';
      this.doc.removeEventListener('visibilitychange', visibility);
      this.win.removeEventListener('pagehide', cleanup);
      dlg.remove(); this.dialog = null;
      if (this.cancelJoin === cleanup) this.cancelJoin = null;
      this.shell.els.sideScroll.querySelector('[aria-label="Add embassy channel"]')?.focus();
    };
    const confirm = this.button('Connect', async () => {
      if (joining || !secret) return;
      joining = true; confirm.disabled = true;
      this.listEpoch++;
      const key = secret; secret = '';
      note.textContent = 'Connecting…';
      const result = await this.api('/join', { method: 'POST', body: { key, confirmedOrigin: origin } });
      this.listEpoch++;
      if (!valid()) { if (this.allowed) await this.refresh(); return; }
      if (result.ok && result.data?.id) {
        const joined = result.data;
        this.connections = [...this.connections.filter(c => c.id !== joined.id), joined];
        this.renderSidebar();
      }
      if (!dlg.isConnected) { await this.refresh(); return; }
      if (!result.ok) {
        note.textContent = 'Join not confirmed or key refused. It may already have been used. Check connected rooms before asking for a new key; no automatic retry.';
        await this.refresh(); return;
      }
      const id = result.data?.id;
      cleanup(); if (id) this.open(id); await this.refresh();
    });
    const cancel = this.button('Cancel', cleanup);
    const visibility = () => { if (this.doc.hidden) stopCamera(); };
    this.doc.addEventListener('visibilitychange', visibility);
    this.win.addEventListener('pagehide', cleanup);
    this.cancelJoin = cleanup;
    dlg.addEventListener('cancel', e => { e.preventDefault(); cleanup(); });
    dlg.addEventListener('close', cleanup);
    const heading = this.el('header', 'eg-dialog-head');
    const headingText = this.el('div'); headingText.append(title, explain);
    const close = this.button('Close', cleanup); close.textContent = '×'; close.classList.add('eg-dialog-close');
    heading.append(headingText, close);
    const content = this.el('div', 'eg-dialog-body'); content.append(label, tools, qr, scan, note);
    const actions = this.el('footer', 'eg-dialog-actions'); next.classList.add('is-primary'); confirm.classList.add('is-primary');
    actions.append(cancel, next); dlg.append(heading, content, actions);
    this.doc.body.append(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    input.focus();
    if (initial?.key) { input.value = initial.key; note.textContent = `Invite ready for ${initial.origin}. Check host before connecting.`; }
    else if (initial?.invalid) note.textContent = 'Invalid invite link. Paste a new key or link.';
  }
}

/** Owner-only two-scan UI. Credentials and operation recovery belong to the local backend. */
class ReverieEmbassyPairingView {
  constructor(view) {
    this.view = view; this.shell = view.shell; this.doc = view.doc; this.win = view.win;
    this.host = { status: 'unconfigured' }; this.handles = []; this.epoch = 0; this.owner = false; this.requests = new Set();
  }
  el(tag, cls, text) { return this.view.el(tag, cls, text); }
  button(text, run, primary = false) { const b = this.view.button(text, run); if (primary) b.classList.add('is-primary'); return b; }
  async api(path, options = {}) {
    const controller = new this.win.AbortController(); this.requests.add(controller);
    const timeout = this.win.setTimeout(() => controller.abort(), 20000);
    try {
      const result = await this.shell.app._chatApi(path, { ...options, signal: controller.signal });
      if (result.status === 403) this.deny();
      return result;
    } catch { return { ok: false }; }
    finally { this.win.clearTimeout(timeout); this.requests.delete(controller); }
  }
  error(result) {
    const code = result?.errorCode || result?.error?.code;
    return ({ OWNER_ONLY: 'Sign in as the console owner to pair companies.', FORBIDDEN: 'Sign in as the console owner to pair companies.',
      HOSTING_UNCONFIGURED: 'Hosting not set up.', EMBASSY_UNREACHABLE: 'The other company is unavailable. Try again later.',
      INVALID_INVITE: 'This invitation has been used, expired or revoked.', GUEST_LABEL: 'That name is already in use. Choose another name.',
      INVITE_LIMIT: 'Too many open invitations. Revoke an unused invitation first.', PAIR_PENDING_LIMIT: 'Too many pending connections. Try again later.',
      PAIR_NOT_FOUND: 'Confirmation not found. Check the code or scan it again.', PAIR_PENDING: 'Waiting for the host to approve.',
      PAIR_STATE: 'This request has already changed. Refresh its status.', PAIR_REJECTED: 'The host declined this request.',
      PAIR_EXPIRED: 'This request has expired. Ask for a new invitation.', PAIR_REVOKED: 'This invitation has been revoked.',
      CLAIM_LIMIT: 'Connection recovery is unavailable. Ask the host for help.', ROOM_NOT_FOUND: 'Shared room unavailable.',
      ROOM_CLOSED: 'This shared room is closed.', PAIR_WRONG_HOST: 'This confirmation belongs to another host.',
      PAIR_ROOM_MISMATCH: 'The invitation and shared room do not match.', PAIR_BAD_QR: 'This is not a valid pairing QR.' })[code] ||
      (result?.status === 403 ? 'Sign in as the console owner to pair companies.' : 'Request not confirmed. Recover its status before trying again.');
  }
  deny() {
    this.owner = false; this.host = { status: 'unconfigured' }; this.handles = []; this.view.syncHostScope(); if (this.view.selected === '__host__') this.view.close(); this.view.renderSidebar(); this.invite = null; this.record = null; this.guestQr = ''; this.guestOperation = null; this.inviteOperation = null;
    for (const request of this.requests) request.abort();
    if (!this.dlg?.isConnected) return;
    this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', 'Sign in as the console owner to pair companies.'));
    const link = this.el('a', '', 'Owner sign-in'); link.href = '/owner/login'; this.body.append(link); this.actions.append(this.button('Close', this.cleanup));
  }
  isCurrent(epoch) { return this.dlg?.isConnected && this.view.dialog === this.dlg && this.epoch === epoch && this.view.allowed; }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const epoch = this.epoch;
    try {
      const [host, pending] = await Promise.all([this.api('/api/embassy-host'), this.api('/api/embassy-pairing')]);
      if (epoch !== this.epoch || !this.view.allowed) return;
      if ([host, pending].some(r => r.status === 403)) { this.owner = false; this.host = { status: 'unconfigured' }; this.handles = []; return; }
      this.owner = !!(host.ok || pending.ok);
      if (host.ok && host.data?.status === 'ready') {
        try {
          const origin = caEmbassyInvite(`embassy-v1|${host.data.origin}|${'A'.repeat(43)}`).origin;
          const room = host.data.room;
          if (!room || typeof room.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(room.id) || typeof room.name !== 'string') throw Error();
          this.host = { status: 'ready', origin, room: { id: room.id, name: room.name.slice(0, 200) },
            ...(typeof host.data.bindingId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(host.data.bindingId) ? { bindingId: host.data.bindingId } : {}) };
        } catch { this.host = { status: 'unreachable' }; }
      } else this.host = { status: host.ok && host.data?.status === 'unconfigured' ? 'unconfigured' : 'unreachable' };
      if (pending.ok) {
        const values = Array.isArray(pending.data) ? pending.data : pending.data?.pairings;
        this.handles = (Array.isArray(values) ? values : []).slice(0, 50).map(v => typeof v === 'string' ? { handle: v } : v)
          .filter(v => v && typeof v.handle === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v.handle));
      }
    } finally { this.view.syncHostScope(); this.refreshing = false; }
  }
  stopCamera() { this.scanEpoch = (this.scanEpoch || 0) + 1; this.win.clearTimeout(this.scanTimer); for (const t of this.stream?.getTracks() || []) t.stop(); this.stream = null; this.video?.remove(); this.video = null; }
  stopPoll() { this.win.clearTimeout(this.pollTimer); this.pollTimer = null; }
  clearBody() { this.win.clearTimeout(this.expiryTimer); this.epoch++; this.stopCamera(); this.stopPoll(); for (const c of this.body.querySelectorAll('canvas')) { c.width = 0; c.height = 0; } for (const i of this.body.querySelectorAll('input')) i.value = ''; this.invite = null; this.body.replaceChildren(); this.actions.replaceChildren(); this.qr = null; this.review = null; }
  close() {
    this.win.clearTimeout(this.expiryTimer); this.epoch++; this.stopCamera(); this.stopPoll(); for (const r of this.requests) r.abort(); this.invite = null; this.record = null; this.guestQr = ''; this.guestOperation = null; this.inviteOperation = null;
    for (const i of this.dlg?.querySelectorAll('input,textarea') || []) i.value = '';
    for (const c of this.dlg?.querySelectorAll('canvas') || []) { c.width = 0; c.height = 0; }
    this.dlg?.remove(); if (this.view.dialog === this.dlg) this.view.dialog = null;
    if (this.view.cancelJoin === this.cleanup) this.view.cancelJoin = null;
    this.doc.removeEventListener('visibilitychange', this.onVisibility); this.win.removeEventListener('pagehide', this.cleanup); this.dlg = null;
  }
  async open(intent = 'home') {
    if (!this.view.allowed || this.view.dialog) return;
    this.epoch++; const epoch = this.epoch;
    const dlg = this.el('dialog', 'ca-dialog eg-dialog eg-pair-dialog'); this.dlg = dlg; this.view.dialog = dlg;
    dlg.setAttribute('aria-label', 'Connect companies');
    this.title = this.el('h2', '', 'Connect companies'); const sub = this.el('p', '', 'Pair two companies in '); sub.append(this.view.platformName(), '.');
    const text = this.el('div'); text.append(this.title, sub); const head = this.el('header', 'eg-dialog-head');
    this.cleanup = () => this.close(); const close = this.button('Close', this.cleanup); close.textContent = '×'; close.classList.add('eg-dialog-close'); head.append(text, close);
    this.body = this.el('div', 'eg-dialog-body'); this.actions = this.el('footer', 'eg-dialog-actions');
    dlg.append(head, this.body, this.actions); this.doc.body.append(dlg);
    dlg.addEventListener('cancel', e => { e.preventDefault(); this.close(); }); dlg.addEventListener('close', this.cleanup);
    this.onVisibility = () => { if (this.doc.hidden) { this.stopCamera(); this.stopPoll(); } else if (this.record) void this.poll(); };
    this.doc.addEventListener('visibilitychange', this.onVisibility); this.win.addEventListener('pagehide', this.cleanup); this.view.cancelJoin = this.cleanup;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    this.body.append(this.el('p', 'eg-pair-status', 'Checking company access…')); this.actions.append(this.button('Cancel', this.cleanup));
    await this.refresh(); if (this.isCurrent(epoch)) { this.home(); if (intent === 'invite') await this.createInvite(); else if (intent === 'manage') await this.invites(); }
  }
  home() {
    this.clearBody(); this.record = null; this.guestOperation = null; this.inviteOperation = null; this.title.textContent = 'Connect companies';
    if (!this.owner) { this.body.append(this.el('p', 'eg-pair-status', 'Sign in as the console owner to pair companies.')); const a = this.el('a', '', 'Owner sign-in'); a.href = '/owner/login'; this.body.append(a); this.actions.append(this.button('Close', this.cleanup)); return; }
    const invite = this.button('Invite a company', () => this.createInvite(), true); invite.disabled = this.host.status !== 'ready';
    const join = this.button('Join a company', () => this.scan('invite'));
    join.disabled = this.handles.some(item => item.state === 'cancelling');
    if (join.disabled) this.body.append(this.el('p', 'ca-hint', 'Recover the cancelling request below before starting another connection.'));
    const choices = this.el('div', 'eg-pair-choices'); choices.append(invite, join); this.body.append(choices);
    this.body.append(this.el('p', 'ca-hint', this.host.status === 'ready' ? `${this.host.room.name} · ${this.host.origin}` : this.host.status === 'unconfigured' ? 'Hosting not set up. You can still join another company.' : 'Hosting is unavailable. You can still join another company.'));
    if (this.host.status === 'ready') this.body.append(this.button('Manage invitations', () => this.invites()));
    if (this.handles.length) {
      const list = this.el('section', 'eg-pair-recent'); list.append(this.el('h3', '', 'Connections in progress'));
      for (const item of this.handles) {
        list.append(this.button(item.room?.name || item.hostCompany || 'Resume connection', () => this.resume(item)));
        if (item.state === 'connected') list.append(this.button(`Reconnect ${item.room?.name || 'shared room'}`, () => this.reconnect(item)));
      }
      this.body.append(list);
    }
    const fallback = this.el('details', 'eg-pair-fallback'); fallback.append(this.el('summary', '', 'Other ways to connect'));
    fallback.append(this.button('Use an existing guest key', () => { this.close(); this.view.joinDialog(); })); this.body.append(fallback);
    this.actions.append(this.button('Cancel', this.cleanup)); invite.disabled ? join.focus() : invite.focus();
  }
  async createInvite() {
    if (this.busy || !this.owner || this.host.status !== 'ready') return;
    this.clearBody(); this.record = null; this.title.textContent = 'Invite a company'; const epoch = this.epoch;
    this.body.append(this.el('p', 'eg-pair-status', 'Creating your invitation…')); this.actions.append(this.button('Cancel', this.cleanup));
    if (!this.inviteOperation) this.inviteOperation = this.win.crypto.randomUUID();
    this.busy = true; const result = await this.api('/api/embassy-host/invites', { method: 'POST', body: { clientRequestId: this.inviteOperation } }); this.busy = false;
    if (!this.isCurrent(epoch)) return;
    if (!result.ok) { this.body.replaceChildren(this.el('p', 'eg-pair-status', this.error(result))); this.actions.prepend(this.button('Retry same invitation', () => this.createInvite())); return; }
    if (result.data?.qr === null && result.data?.qrAvailable === false && ['pending', 'approved', 'connected', 'expired', 'revoked', 'rejected'].includes(result.data?.state)) {
      this.body.replaceChildren(this.el('p', 'eg-pair-status', `Invitation ${result.data.state}. It will not be replaced automatically.`));
      this.actions.replaceChildren(this.button('Back', () => this.home()), this.button('New invitation', () => { this.inviteOperation = null; return this.createInvite(); }, true));
      if (result.data.state === 'pending') this.actions.prepend(this.button('Scan their confirmation', () => this.scan('request')));
      return;
    }
    try {
      const invite = caPairInvite(result.data?.qr);
      if (invite.origin !== this.host.origin || invite.roomId !== this.host.room.id || typeof result.data.inviteId !== 'string' || !Number.isFinite(result.data.expiresAt) || result.data.expiresAt <= Date.now() || result.data.expiresAt > Date.now() + 3600000) throw Error();
      this.invite = { ...result.data, ...invite }; this.body.replaceChildren(this.el('p', '', `${this.host.room.name} · ${this.host.origin}`));
      await this.showQR(invite.qr, 'Private company invitation QR'); if (!this.isCurrent(epoch)) return;
      const note = this.el('p', 'eg-pair-status'); note.append('Have the other company scan this QR in their ', this.view.platformName(), '. Then scan their confirmation QR to approve the connection.'); this.body.append(note);
      this.body.append(this.el('small', 'ca-hint', `Expires in ${Math.ceil((this.invite.expiresAt - Date.now()) / 60000)} min`));
      const fallback = this.el('details', 'eg-pair-fallback'); fallback.append(this.el('summary', '', 'Share without a camera'));
      fallback.append(this.button('Copy invitation', async () => {
        if (!this.isCurrent(epoch)) return;
        try { await this.win.navigator.clipboard.writeText(invite.qr); if (this.isCurrent(epoch)) note.textContent = 'Invitation copied. Send it privately to the joining company.'; }
        catch { if (this.isCurrent(epoch)) { const input = this.el('input'); input.type = 'password'; input.readOnly = true; input.value = invite.qr; input.autocomplete = 'off'; fallback.append(input); input.focus(); input.select(); note.textContent = 'Copy the selected invitation and send it privately.'; } }
      })); this.body.append(fallback);
      this.expiryTimer = this.win.setTimeout(() => {
        if (!this.isCurrent(epoch)) return; this.clearBody(); this.inviteOperation = null; this.body.append(this.el('p', 'eg-pair-status', 'Invitation expired. Create a new one to connect.')); this.actions.append(this.button('New invitation', () => this.createInvite(), true), this.button('Back', () => this.home()));
      }, Math.max(1, this.invite.expiresAt - Date.now()));
      this.actions.replaceChildren(this.button('Back', () => this.home()), this.button('Scan their confirmation', () => this.scan('request'), true));
    } catch { if (this.isCurrent(epoch)) this.body.replaceChildren(this.el('p', 'eg-pair-status', 'Invitation unavailable. Recover invitations before creating another.')); }
  }
  async showQR(value, label) {
    const epoch = this.epoch; const canvas = this.el('canvas', 'eg-pair-qr'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label); this.body.append(canvas);
    const encoder = await caEmbassyQrAsset(this.win, 'code');
    if (!this.isCurrent(epoch) || !canvas.isConnected) return;
    await encoder.toCanvas(canvas, value, { errorCorrectionLevel: 'M', margin: 4, width: 320 });
    if (!this.isCurrent(epoch) || !canvas.isConnected) { canvas.width = 0; canvas.height = 0; }
  }
  scan(mode) {
    if (mode === 'invite') {
      const cancelling = this.handles.find(item => item.state === 'cancelling');
      if (cancelling) { void this.resume(cancelling); return; }
    }
    this.clearBody(); this.record = null; this.title.textContent = mode === 'invite' ? 'Scan an invitation' : 'Scan their confirmation';
    const note = this.el('p', 'eg-pair-status', mode === 'invite' ? 'Scan the host company’s QR. This creates a pending request; the host must approve before you can read or post.' : `Approve a request for ${this.host.room?.name || 'this room'} at ${this.host.origin || 'this host'}.`); note.setAttribute('role', 'status'); this.body.append(note);
    let company, identity;
    if (mode === 'invite') {
      const labels = this.el('details', 'eg-pair-labels'); labels.append(this.el('summary', '', 'Choose company and person labels (optional)'));
      for (const name of ['Company', 'Person']) {
        const label = this.el('label', '', name), field = this.el('input'); field.type = 'text'; field.maxLength = name === 'Company' ? 120 : 80; field.autocomplete = 'off';
        label.append(field); labels.append(label); if (name === 'Company') company = field; else identity = field;
      }
      this.body.append(labels);
    }
    const camera = this.button('Scan with camera', () => this.camera(note, accept)); this.body.append(camera);
    const fileLabel = this.el('label', 'eg-pair-file', 'Or scan a QR image'); const file = this.el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; fileLabel.append(file); this.body.append(fileLabel);
    const fallback = this.el('details', 'eg-pair-fallback'); fallback.append(this.el('summary', '', mode === 'invite' ? 'Paste an invitation instead' : 'Type the confirmation code instead'));
    const label = this.el('label', '', mode === 'invite' ? 'Invitation QR text' : 'Confirmation code'); const input = this.el('input', 'eg-pair-code'); input.type = mode === 'invite' ? 'password' : 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 512; label.append(input);
    const use = this.button(mode === 'invite' ? 'Request to join' : 'Look up confirmation', () => { const value = input.value; input.value = ''; void accept(value); }); fallback.append(label, use); this.body.append(fallback);
    const epoch = this.epoch;
    const accept = async value => {
      if (!this.isCurrent(epoch) || this.busy) return; this.stopCamera(); file.value = ''; input.value = '';
      if (mode === 'invite') {
        const labels = { ...(company?.value.trim() ? { company: company.value.trim() } : {}), ...(identity?.value.trim() ? { identity: identity.value.trim() } : {}) };
        if (company) company.value = ''; if (identity) identity.value = '';
        await this.join(value, note, labels);
      } else await this.lookup(value, note);
    };
    file.addEventListener('change', async () => {
      const image = file.files?.[0]; file.value = ''; if (!image) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || image.size > 5 * 1024 * 1024) { note.textContent = 'Choose a PNG, JPEG or WebP under 5 MB.'; return; }
      let bitmap;
      try {
        const decode = await caEmbassyQrAsset(this.win, 'scan'); bitmap = await this.win.createImageBitmap(image);
        if (!this.isCurrent(epoch) || !file.isConnected) return;
        if (bitmap.width * bitmap.height > 25000000) throw Error();
        const canvas = this.el('canvas'), scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height); const qr = decode(pixels.data, canvas.width, canvas.height); canvas.width = 0;
        if (!qr) throw Error(); await accept(qr.data);
      } catch { if (this.isCurrent(epoch) && note.isConnected) note.textContent = 'QR not found. Try another image or paste the invitation/code.'; }
      finally { bitmap?.close(); }
    });
    this.actions.append(this.button('Back', () => this.home())); camera.focus();
  }
  async camera(note, accept) {
    this.stopCamera(); const scanEpoch = this.scanEpoch, epoch = this.epoch;
    if (!this.win.navigator.mediaDevices?.getUserMedia) { note.textContent = 'Camera unavailable. Use a QR image or paste the invitation/code.'; return; }
    try {
      const stream = await this.win.navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (!this.isCurrent(epoch) || scanEpoch !== this.scanEpoch || !note.isConnected || this.doc.hidden) { for (const t of stream.getTracks()) t.stop(); return; }
      this.stream = stream; const video = this.el('video', 'eg-scan-video'); this.video = video; video.muted = true; video.playsInline = true; video.srcObject = stream; note.after(video); await video.play();
      const decode = await caEmbassyQrAsset(this.win, 'scan'), end = Date.now() + 60000;
      const tick = async () => {
        if (!this.isCurrent(epoch) || scanEpoch !== this.scanEpoch || !note.isConnected || this.doc.hidden) { this.stopCamera(); return; }
        if (Date.now() >= end) { this.stopCamera(); note.textContent = 'Camera paused. Scan again or use the code fallback.'; return; }
        if (video.readyState >= 2) {
          const c = this.el('canvas'), scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight)); c.width = Math.max(1, Math.round(video.videoWidth * scale)); c.height = Math.max(1, Math.round(video.videoHeight * scale));
          const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0, c.width, c.height); const px = ctx.getImageData(0, 0, c.width, c.height), qr = decode(px.data, c.width, c.height); c.width = 0;
          if (qr) { await accept(qr.data); return; }
        }
        this.scanTimer = this.win.setTimeout(tick, 250);
      }; await tick();
    } catch { this.stopCamera(); if (this.isCurrent(epoch) && note.isConnected) note.textContent = 'Camera unavailable. Use a QR image or paste the invitation/code.'; }
  }
  async join(value, note, labels = {}) {
    if (this.busy || !this.owner) return;
    let invite; try { invite = caPairInvite(value); } catch { note.textContent = 'Invalid pairing invitation. Scan the host’s Invite QR.'; return; }
    const epoch = this.epoch; this.guestQr = invite.qr; this.busy = true; note.textContent = `Requesting approval from ${invite.origin}…`;
    const result = await this.api('/api/embassy-pairing', { method: 'POST', body: { ...labels, qr: invite.qr, clientRequestId: this.guestOperation || (this.guestOperation = this.win.crypto.randomUUID()) } }); this.busy = false;
    if (!this.isCurrent(epoch)) return;
    if (!result.ok) { this.guestQr = ''; note.textContent = this.error(result); this.actions.replaceChildren(this.button('Recover connections', async () => { await this.refresh(); if (this.isCurrent(epoch)) this.home(); })); return; }
    this.guestQr = '';
    try {
      const data = result.data;
      if (!['creating', 'pending', 'approved', 'connected', 'failed', 'cancelling', 'cancelled', 'rejected', 'expired', 'revoked'].includes(data?.state) || data?.origin !== invite.origin || data?.room?.id !== invite.roomId || !this.validHandle(data?.handle)) throw Error();
      let requestId;
      if (['pending', 'approved'].includes(data.state)) {
        const qr = caPairRequest(data.requestQr, invite.origin);
        if (caPairCode(data.code) !== qr.code) throw Error();
        requestId = qr.requestId;
      }
      this.record = { ...data, ...(requestId ? { requestId } : {}) }; await this.showRecord();
    } catch { note.textContent = 'Pairing response did not match this invitation. Recover connections to check the outcome.'; }
  }
  validHandle(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value); }
  async resume(value) { if (!this.validHandle(value?.handle)) return; this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', 'Restoring connection…')); this.record = { ...value }; await this.poll(); }
  async showRecord() {
    const record = this.record; if (!record || !this.validHandle(record.handle)) return;
    this.handles = [...this.handles.filter(item => item.handle !== record.handle), { ...record }];
    this.clearBody(); this.title.textContent = 'Connect companies';
    const label = { creating: 'Creating request', pending: 'Waiting for host approval', approved: 'Approved · connecting', connected: 'Connected', rejected: 'Request declined', expired: 'Request expired', revoked: 'Invitation revoked', cancelling: 'Cancelling… (waiting for the host embassy to confirm)', cancelled: 'Request cancelled', failed: 'Connection unavailable' }[record.state] || 'Checking connection';
    const note = this.el('p', 'eg-pair-status', label); note.setAttribute('role', 'status'); this.body.append(note);
    if (record.hostCompany) this.body.append(this.el('p', '', `Connecting to ${String(record.hostCompany).slice(0, 200)}`));
    if (record.room) this.body.append(this.el('p', 'ca-hint', `${record.room.name || 'Shared room'} · ${record.origin || ''}`));
    if (record.state === 'pending' && record.requestQr && record.origin) {
      try {
        const qr = caPairRequest(record.requestQr, record.origin); if (record.requestId && qr.requestId !== record.requestId || caPairCode(record.code) !== qr.code) throw Error();
        try { await this.showQR(qr.qr, 'Public confirmation QR'); }
        catch { if (note.isConnected) note.textContent = 'QR unavailable. Have the host enter the confirmation code instead.'; }
        if (!note.isConnected) return;
        this.body.append(this.el('strong', 'eg-pair-confirm-code', qr.code), this.el('p', '', 'Have the host scan this confirmation QR, or enter this code. You cannot read or post until they approve.'));
      } catch { if (note.isConnected) note.textContent = 'Confirmation unavailable. Recover the request status.'; }
    }
    if (!note.isConnected) return;
    if (record.state === 'failed' && record.error === 'GUEST_LABEL') {
      note.textContent = 'That name is already in use. Cancel this request before starting over with another name.';
      this.actions.append(this.button('Cancel and start over', () => this.restartAfterLabelConflict()), this.button('Back', () => this.home()));
      return;
    }
    if (record.state === 'cancelling') {
      this.actions.append(this.button('Check status', () => this.poll()), this.button('Close', this.cleanup));
      this.schedulePoll();
    } else if (record.state === 'cancelled') {
      this.actions.append(this.button('Start over', () => {
        if (this.record?.handle !== record.handle || this.record.state !== 'cancelled') return;
        this.record = null; this.guestOperation = null; this.guestQr = ''; this.scan('invite');
      }), this.button('Back', () => this.home()));
    } else if (record.state === 'failed') {
      this.actions.append(this.button('Cancel request', () => this.cancel()), this.button('Check status', () => this.poll()));
    } else if (record.state === 'connected' && record.connectionId) this.actions.append(this.button('Open shared room', () => this.openConnected(record), true));
    else if (['creating', 'pending', 'approved'].includes(record.state)) {
      this.actions.append(this.button('Cancel request', () => this.cancel()), this.button('Check status', () => this.poll()));
      this.schedulePoll();
    } else this.actions.append(this.button('Back', () => this.home()));
  }
  schedulePoll() { this.stopPoll(); if (!this.doc.hidden && this.dlg) this.pollTimer = this.win.setTimeout(() => this.poll(), 3000); }
  async poll() {
    if (!this.record || this.doc.hidden) return;
    if (this.polling) { this.schedulePoll(); return; }
    const handle = this.record.handle, epoch = this.epoch; if (!this.validHandle(handle)) return;
    this.polling = true; const result = await this.api(`/api/embassy-pairing/${encodeURIComponent(handle)}`); this.polling = false;
    if (!this.isCurrent(epoch) || this.record?.handle !== handle) return;
    if (!result.ok) { this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', this.error(result))); this.actions.append(this.button('Check status', () => this.poll()), this.button('Close', this.cleanup)); return; }
    const states = ['creating', 'pending', 'approved', 'connected', 'rejected', 'expired', 'revoked', 'cancelling', 'cancelled', 'failed'];
    if (!states.includes(result.data?.state) || result.data?.handle !== handle) { this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', 'Pairing status unavailable. Recover the original request.')); this.actions.append(this.button('Check status', () => this.poll()), this.button('Close', this.cleanup)); return; }
    if (this.record.state === 'cancelling' && !['cancelling', 'cancelled'].includes(result.data.state)) {
      this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', 'Cancellation is not confirmed. Recover the original request status.'));
      this.actions.append(this.button('Check status', () => this.poll()), this.button('Close', this.cleanup)); return;
    }
    this.record = { ...this.record, ...result.data, handle };
    if (!['pending', 'approved'].includes(this.record.state)) { delete this.record.requestQr; delete this.record.code; }
    if (this.record.state !== 'connected') delete this.record.connectionId;
    const record = this.record; await this.showRecord();
    if (this.record === record && this.dlg?.isConnected && this.record?.state === 'connected') await this.openConnected(record);
  }
  async restartAfterLabelConflict() {
    if (this.busy || !this.owner || this.record?.state !== 'failed' || this.record.error !== 'GUEST_LABEL' || !this.validHandle(this.record.handle)) return;
    const handle = this.record.handle;
    this.clearBody();
    this.body.append(this.el('p', 'eg-pair-status', 'Cancelling the previous request…'));
    const epoch = this.epoch;
    this.busy = true;
    const result = await this.api(`/api/embassy-pairing/${encodeURIComponent(handle)}`, { method: 'DELETE' });
    this.busy = false;
    if (!this.isCurrent(epoch) || this.record?.handle !== handle) return;
    if (!result.ok || result.data?.handle !== handle || result.data?.state !== 'cancelled' || result.data?.cancelPending === true) {
      this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', result.ok ? 'Cancellation is not confirmed. Recover the request before starting over.' : this.error(result)));
      this.actions.append(this.button('Check status', () => this.poll()), this.button('Back', () => this.home())); return;
    }
    this.handles = this.handles.map(item => item.handle === handle ? { ...result.data } : item);
    this.record = null; this.guestOperation = null; this.guestQr = '';
    this.scan('invite');
  }
  async reconnect(record) {
    if (this.busy || !this.owner || record?.state !== 'connected' || !this.validHandle(record.handle)) return;
    if (!this.win.confirm('Recover this connection after losing local access? This replaces the previous session.')) return;
    this.clearBody(); this.record = { ...record }; const epoch = this.epoch;
    this.body.append(this.el('p', 'eg-pair-status', 'Recovering connection…'));
    this.busy = true;
    const result = await this.api(`/api/embassy-pairing/${encodeURIComponent(record.handle)}/reconnect`, { method: 'POST' });
    this.busy = false;
    if (!this.isCurrent(epoch) || this.record?.handle !== record.handle) return;
    if (!result.ok) {
      this.body.replaceChildren(this.el('p', 'eg-pair-status', this.error(result)));
      this.actions.append(this.button('Check status', () => this.poll()), this.button('Back', () => this.home()));
      return;
    }
    if (result.data?.handle !== record.handle || !['connected', 'expired', 'revoked', 'cancelling', 'cancelled', 'rejected', 'failed'].includes(result.data?.state)) {
      this.body.replaceChildren(this.el('p', 'eg-pair-status', 'Recovery status unavailable. Check the connection before trying again.'));
      this.actions.append(this.button('Check status', () => this.poll())); return;
    }
    this.record = { ...result.data }; await this.showRecord();
  }
  async openConnected(record) {
    if (record?.state !== 'connected' || typeof record.connectionId !== 'string') return;
    const epoch = this.epoch; await this.view.refresh();
    if (!this.isCurrent(epoch) || !this.view.connections.some(c => c.id === record.connectionId)) return;
    this.close(); this.view.open(record.connectionId);
  }
  async cancel() {
    if (this.busy || !this.record || !this.owner) return;
    const handle = this.record.handle; this.clearBody(); const epoch = this.epoch; this.busy = true;
    this.body.append(this.el('p', 'eg-pair-status', 'Requesting cancellation…'));
    const result = await this.api(`/api/embassy-pairing/${encodeURIComponent(handle)}`, { method: 'DELETE' }); this.busy = false;
    if (!this.isCurrent(epoch) || this.record?.handle !== handle) return;
    const data = result.data;
    const states = ['creating', 'pending', 'approved', 'connected', 'rejected', 'expired', 'revoked', 'cancelling', 'cancelled', 'failed'];
    if (result.ok && data?.handle === handle && states.includes(data.state) && !(data.state === 'cancelled' && data.cancelPending === true)) {
      this.record = { ...this.record, ...data };
      if (['rejected', 'expired', 'revoked', 'cancelling', 'cancelled', 'failed'].includes(data.state)) { delete this.record.requestQr; delete this.record.code; delete this.record.connectionId; }
      await this.showRecord();
    } else {
      this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', result.ok ? 'Cancellation is not confirmed. Recover the original request status.' : this.error(result)));
      this.actions.append(this.button('Check status', () => this.poll()), this.button('Close', this.cleanup));
    }
  }
  async lookup(value, note) {
    if (this.busy || !this.owner || this.host.status !== 'ready') return;
    let body, code, requestId;
    try { if (String(value).startsWith('embassy-pair-v1|')) { const qr = caPairRequest(value, this.host.origin); body = { qr: qr.qr }; code = qr.code; requestId = qr.requestId; } else { code = caPairCode(value); body = { code }; } }
    catch { note.textContent = 'Invalid confirmation or wrong host. Scan this company’s request QR, or enter its code.'; return; }
    const epoch = this.epoch; this.busy = true; const result = await this.api('/api/embassy-host/lookup', { method: 'POST', body }); this.busy = false;
    if (!this.isCurrent(epoch)) return; if (!result.ok) { note.textContent = this.error(result); return; }
    const data = result.data;
    if (!data || !/^[0-9a-f-]{36}$/.test(data.requestId) || requestId && data.requestId !== requestId || !data.guest || typeof data.guest.company !== 'string' || typeof data.guest.identity !== 'string') { note.textContent = 'Confirmation response did not match the request.'; return; }
    this.clearBody(); this.review = { requestId: data.requestId, code }; this.title.textContent = 'Approve connection?';
    this.body.append(this.el('p', 'eg-pair-guest', `${data.guest.identity.slice(0, 200)} from ${data.guest.company.slice(0, 200)}`), this.el('p', 'ca-hint', `${this.host.room.name} · ${this.host.origin}`), this.el('p', 'ca-hint', 'Company and person names are labels, not verified identity.'));
    if (data.state === 'pending' && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now()) this.actions.append(this.button('Decline', () => this.decide('reject')), this.button('Approve connection', () => this.decide('approve'), true));
    else { this.body.append(this.el('p', 'eg-pair-status', data.state === 'approved' || data.state === 'claimed' ? 'This connection is already approved.' : 'This request is no longer available.')); this.actions.append(this.button('Back', () => this.home())); }
  }
  async decide(kind) {
    if (this.busy || !this.owner || !this.review || this.host.status !== 'ready' || !['approve', 'reject'].includes(kind)) return;
    const epoch = this.epoch, review = this.review; this.busy = true; for (const b of this.actions.querySelectorAll('button')) b.disabled = true;
    const result = await this.api(`/api/embassy-host/${kind}`, { method: 'POST', body: review }); this.busy = false;
    if (!this.isCurrent(epoch) || this.review !== review) return;
    this.clearBody(); this.body.append(this.el('p', 'eg-pair-status', result.ok ? kind === 'approve' ? 'Approved. The other company can now finish connecting.' : 'Request declined.' : this.error(result)));
    if (!result.ok) { this.review = review; this.actions.append(this.button('Retry same decision', () => this.decide(kind))); }
    this.actions.append(this.button('Done', () => this.home()));
  }
  async invites() {
    if (this.busy || !this.owner || this.host.status !== 'ready') return;
    this.clearBody(); this.title.textContent = 'Invitations'; const epoch = this.epoch;
    this.body.append(this.el('p', 'eg-pair-status', 'Loading invitations…')); const result = await this.api('/api/embassy-host/invites');
    if (!this.isCurrent(epoch)) return; this.body.replaceChildren();
    if (!result.ok) this.body.append(this.el('p', 'eg-pair-status', this.error(result)));
    else {
      const rows = Array.isArray(result.data) ? result.data : result.data?.invites;
      for (const row of (Array.isArray(rows) ? rows : []).slice(0, 100)) {
        if (typeof row.inviteId !== 'string') continue;
        const item = this.el('section', 'eg-pair-invite'); item.append(this.el('span', '', row.guest ? `${row.guest.identity || 'Guest'} · ${row.guest.company || 'Company'}` : 'Company invitation'), this.el('small', '', ['open', 'pending', 'approved', 'connected', 'expired', 'revoked', 'rejected'].includes(row.state) ? row.state : 'Unavailable'));
        if (Number.isFinite(row.expiresAt)) item.append(this.el('small', '', row.expiresAt > Date.now() ? `Expires in ${Math.ceil((row.expiresAt - Date.now()) / 60000)} min` : 'Expired'));
        if (['open', 'pending', 'approved', 'connected'].includes(row.state)) item.append(this.button('Revoke', async () => {
          if (this.busy || !this.win.confirm('Revoke this invitation and stop its guest access?')) return;
          this.busy = true; const answer = await this.api(`/api/embassy-host/invites/${encodeURIComponent(row.inviteId)}`, { method: 'DELETE' }); this.busy = false;
          if (!this.isCurrent(epoch)) return; if (answer.ok) await this.invites(); else item.append(this.el('p', 'eg-pair-status', this.error(answer)));
        })); this.body.append(item);
      }
      if (!this.body.childElementCount) this.body.append(this.el('p', 'eg-pair-status', 'No invitations yet.'));
    }
    this.actions.append(this.button('Back', () => this.home()));
  }
}

function caBoot() {
  const proto = typeof ReverieApp !== 'undefined' ? ReverieApp.prototype : null;
  if (!proto || proto._caInstalled) return;
  proto._caInstalled = true;
  caInstall(proto);
  let tries = 0;
  const go = () => {
    const app = window.app;
    if (!app) {
      // The page's own code never produced the app: stop waiting and leave the terminal UI visible.
      if (++tries > 200) {
        console.error('[chat-app] the application did not start; showing the terminal view');
        document.documentElement.setAttribute('data-reverie-view', 'debug');
        return undefined;
      }
      return setTimeout(go, 30);
    }
    const chatApp = new ReverieChatApp(app, document);
    window.reverieChat = chatApp;
    chatApp.start().catch((err) => {
      console.error('[chat-app] failed to start', err);
      document.documentElement.setAttribute('data-reverie-view', 'debug');
    });
    // Connection presence in the profile bar follows the page's own SSE status.
    const set = app.setConnectionStatus?.bind(app);
    if (set) {
      app.setConnectionStatus = (status) => {
        set(status);
        chatApp.renderConnection();
      };
    }
  };
  go();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof ReverieApp !== 'undefined') {
  caBoot();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    chatBadgeFor,
    caChannelItems,
    caByPosition,
    caMoveWithin,
    caMoveBeside,
    caDmItems,
    caEmployeeBySession,
    caProfilePronouns,
    caPronounsProposal,
    caPronounsProblem,
    caFoldedUnreadIds,
    caWorkspaceItems,
    caWorkspaceOf,
    caTotals,
    chatCountsAfterMessage,
    chatStaleRoomIds,
    caFeedItems,
    caMemberSections,
    caSwitcherResults,
    caInitialView,
    caRoomLabel,
    caRoomGlyph,
    caMentionQuery,
    caIsVoice,
    caSpeaks,
    caStatsView,
    caIconImage,
    caProfileIcons,
    caProfileAvatars,
    caPollView,
    caMemberState,
    caClosedDms,
    caNotifyPrefs,
    caIsMuted,
    caViewRooms,
    caSnippet,
    caProfile,
    caOrgTree,
    caAgentFacts,
    caAgentProfile,
    caCount,
    caMentionCandidates,
    ReverieEmbassyView,
    ReverieEmbassyPairingView,
    caPairInvite,
    caPairCode,
    caPairRequest,
    caEmbassyInvite,
    caEmbassyJoinLink,
    caEmbassyTakeFragment,
  };
}
