# Channel message search

In the owner console, use **Search messages** at the top right. Enter words or
word beginnings and choose all accessible channels or one channel. Results appear
beside the current conversation, newest first, with safe highlighted excerpts,
channel names, senders and company-timezone timestamps. **Load older results**
continues the exclusive cursor; the displayed count is the page accumulation,
not a claim about the total number of matches.

**View context** retrieves the exact original source and up to five neighboring
messages on each side, including sources that have left the recent 1000-message
window. It keeps the current chat and draft mounted. **Open channel** explicitly
switches to that conversation; older sources remain selected in the context
pane when they are outside its live feed. Escape or Close search restores focus
to the header control. On narrow screens the rail overlays the conversation and
can be closed to return to it.

Search uses the existing SQLite text index. It never posts a message or advances
read, agent delivery, seen, acknowledgement or handled state. Queries contain
1–12 literal words, at most 160 characters. Each page has at most 30 excerpts;
context has at most 11 records and a 1 MiB source-byte budget. No raw FTS syntax
or client-selected filesystem paths are accepted. Without the database, an
explicit unavailable response replaces search rather than a misleading empty
history result. Up to 500 currently authorized channels can be searched at once;
larger installations must select a channel.

Current authorization is rechecked on every search page and context open.
Deleted sources and removed rooms are excluded. This owner-console feature adds
no agent, service or limited-account grant; their existing access stays separate.
Company timezone is read from current server settings with an explicit UTC
fallback. Stored timestamps and existing reset/schedule instants are unchanged.

The source implementation and component tests do not establish real browser
layout, final combined-head packaging or installed owner acceptance. Those checks
belong to the existing review/composition/deployment lane before delivery.
