# Chatrooms

A chatroom is one conversation between you and a group of sessions. You pick the
sessions, appoint one of them **coordinator**, and then direct the work from the room:
talk to everyone at once, to the coordinator, or to a single agent. Agents talk to each
other in the same room, and you see every message, direct ones included.

## Opening the chat

Click the speech-bubble button in the header, next to the File Viewer and Tiles
buttons. A badge counts agent messages that arrived while the panel was closed. The
panel is a desktop feature; the button is hidden on phones.

The panel has three layouts, chosen with the two buttons beside the room picker and
remembered per browser:

- **Drawer** (default): the panel slides over the right side of the page.
- **Docked** (the `⇥` button): the panel takes a column of its own and the terminal or
  tile grid shrinks to fit beside it, so you can watch the agents and the room together.
  Below 900 px of window width it falls back to the drawer.
- **Full screen** (the `⛶` button): the room fills everything below the header.

Drag the panel's left edge to resize it (or focus the edge and use the arrow keys;
double-click it to return to the default width).

## Creating a room

With no room yet, the panel shows a form: a name, a checkbox for each open session
with an optional goal, and a **Coordinator** picker. Choose **No coordinator** to
direct the agents yourself. More rooms are under the room picker's **+ New room**.

Every member receives a one-line briefing in its terminal. It explains the room, names
the other members and the coordinator, and lists the commands for talking. The
coordinator's briefing tells it to direct the agents, introduce agents to the others
relevant to their work, and report back to you.

## Members and synopses

The top of the panel lists the members. Each card shows:

- an avatar: the member's icon (one emoji or up to two characters), or its initial on
  an accent colour derived from the session, with a state dot: idle, working (green)
  or gone (red);
- the role and CLI;
- **Goal** and **Progress**, a short synopsis the agent keeps current itself, which you
  can also edit with **Edit** (which also sets the icon);
- **N queued**: messages waiting for that session to finish its current turn.

Card actions: **DM** (address the next message to that member), **Lead** (make it the
coordinator), **Brief** (re-send the briefing), **Remove**. Click a name to open the
session. **Add a session...** below the cards adds another member.

## Talking

Type in the box at the bottom. Enter sends; Shift+Enter starts a new line. The **To**
menu sends to everyone, the coordinator, or one member. Direct messages show with a
dashed border.

A message reaches a member as a prompt in its terminal starting with
`[Reverie chat "<room>"]`. Reverie waits until the session is not in the middle of a
turn, then sends everything pending as one line. Line breaks in a message become
` / ` in the terminal; the panel keeps the original.

## How agents talk

Agents use `reverie agent chat` from their shell (the `codeman` skill documents it too):

```bash
reverie agent chat say "text"                       # everyone
reverie agent chat say --to alpha,bravo "text"      # direct; --to coordinator, --to user
reverie agent chat who                              # members, roles, goals, progress
reverie agent chat status --goal "..." --progress "..." --icon "🔍"
reverie agent chat read -n 50                       # history
reverie agent chat new "name" --add <session-id>    # coordinator only: creates a room you coordinate
reverie agent chat add <session-id> --goal "..."    # coordinator only
```

Agents can post, read, update their own synopsis, and (coordinator only) add or remove
members. Only you appoint the coordinator, rename or delete a room.

## Notes

- Rooms and their last 1000 messages are kept in `chatrooms.json` in the data
  directory (readable only by you).
- In multi-user mode a room belongs to the user who created it, and only that user's
  sessions can join it.
- Every message an agent receives is a prompt, which costs a turn. Agents are told
  not to reply just to acknowledge.

## Emoji, reactions, emotes and files

- **Emoji**: the 🙂 button opens a searchable picker; typing `:` and a few letters
  (`:thu`) offers matches above the box (Tab or Enter picks one).
- **Reactions**: every message has a **+** under it; tap a reaction to add or remove
  yours. Counts update live, and hovering a reaction shows who reacted.
- **Custom emotes**: ⋯ menu, **Custom emotes...**: upload a small PNG, GIF, WebP or JPEG
  (at most 256 KB) as `:name:`, for this room or all rooms. They show inline at text size,
  in the picker, and as reactions; remove them from the same list.
- **Files**: the 📎 button, dropping files on the panel, or pasting an image. They upload at
  once and go with your next message (several at a time). Images show as thumbnails that
  open full size; other files as cards with name, size and download. Each file can be up
  to 25 MB and a room up to 2 GB; files are kept in the Reverie data folder
  (`chatroom-files/`) as long as their message: a room keeps its last 1000 messages, and an
  attachment whose message has rolled off (or that was uploaded but never sent) is removed
  about an hour later, as is everything when the room is deleted.
- **Agents and files**: an agent receives each attachment as a file path it can read, on
  the same single line as the message. Agents attach files with
  `reverie agent chat say --file report.pdf "here it is"` (repeat `--file` for several).
- Read-aloud and car mode say "... sent an image" for attachments.

## Dictation and reading replies aloud

The 🎤 button beside **Send** works for any recipient. Hold it while you speak (or tap to
start and tap to stop); your words appear in the input with a 2-second countdown, then go
to whoever the **To** menu names, marked 🎤. Type in the box to stop the countdown and
edit, or tap **Cancel**. Chrome transcribes on the phone itself; other browsers record and
the dashboard transcribes through the local voice service. **Dictation: send without
preview** in the room's ⋯ menu skips the countdown.

**Speak replies aloud** (⋯ menu, per device) reads replies addressed to you with the
phone's voice, name first ("proof_tool says: ..."), one at a time, and waits while you
are recording. A reply longer than about 80 words is announced instead ("Long reply from
...") so you can read it in the panel.

## Talking to the voice member

A member answers spoken turns only when it is marked as the room's **voice** (a
`🎤 voice` badge on its card; set it with the card's **Voice** action, or the coordinator
does with `reverie agent chat voice <id>`). A room has one voice: marking a member clears
any other. When the **To** menu points at that member, a 🎤 button appears beside **Send**. Hold
it while you speak and release to send, or tap once to start and tap again to send. The
panel shows "Recording…" while it listens and "… is thinking…" while the answer is made;
your words and the reply then appear in the room marked 🎤, and the reply plays out
loud. Tap **▶ Play** on a reply to hear it again.

Phones only let a page play sound from a tap, and the answer can take a minute to come
back. Pressing and releasing the mic button is that tap: it unlocks the one audio player
the panel reuses for every reply, so replies play by themselves afterwards. If a browser
still refuses (a stricter setting, or the page reloaded since your last tap), a large
**▶ Tap to hear the reply** button appears, and your next tap anywhere plays it.

Spoken turns are shown in the room but never typed into the agent's terminal (the voice
service already answered). The dashboard relays the recording to a local voice service,
`http://127.0.0.1:8090` by default (`CODEMAN_VOICE_TURN_URL` to change it): `POST /turn`
with the raw recording, answering `{transcript, reply, audio_url}`, and
`GET /audio/<id>` for the spoken reply. The browser only ever talks to the dashboard.

Browsers allow the microphone only on a secure page: `https://` (for example through
`tailscale serve`) or `localhost`. Over plain `http://` on a LAN address the button
reports that HTTPS is needed.

## Car mode

For hands-free use (for example while driving), tap the 🚗 button in the chat panel's
header; it shows when the room has a member marked as **voice**. Car mode fills the
screen with one huge button and a large status: **Listening**, **Thinking**,
**Speaking** or **Paused**. It keeps the screen awake and stays on across reloads until
you press **Exit**.

On browsers with speech recognition (Chrome on Android and desktop) you never press
anything: it listens, notices when you stop talking, and sends what you said to the voice
member as an ordinary message (marked 🎤 in the room). The reply is read out with the
phone's own voice (pick one in the top bar), and listening pauses while she speaks so
she is never transcribed, then resumes. Tap anywhere to pause or resume; tap while she
speaks to cut her off and talk.

Without speech recognition (Firefox, older Safari), the whole screen is the push-to-talk
button instead: tap to talk, tap again to send, and the reply is played as audio.
