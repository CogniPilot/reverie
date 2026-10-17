# Optional Slack and Discord bot connections

External chat is optional. No connection exists by default, and a newly saved connection is disabled. Local chat works without either provider. This integration uses supported bot tokens, not personal Slack sessions or Discord self-bots. The server checks the actual bot identity before saving a connection, when enabling it, after restart before polling, and periodically during use. No real provider credentials were used during development validation.

From the owner dashboard, open External chat, choose an agent and provider, enter the installed bot's token, and save. A separate bot token per agent gives each agent its own external identity. Reverie displays the verified bot name and ID; changing the local label does not change the provider's bot identity. Personal login/OAuth authorization-code flows are not implemented; install and authorize the bot with the provider first.

Look up a channel by its provider channel ID, review the returned name, select a local ordinary room that contains the bound agent, and explicitly link them. Enable the connection when ready. DMs, archived rooms, and another owner's rooms cannot be linked. Connecting a bot alone never shares a local room. Only the bound agent's future messages addressed to everyone in a selected room are sent externally. Owner messages, directed messages, other agents' messages, attachments, and messages in unlinked rooms are excluded. Messages exceeding the provider's configured length limit fail visibly rather than being split into a flood. The bot posts as its verified provider identity.

Human messages from selected external channels are posted through the chatroom mutation service and directed to the bound agent. They retain the provider, channel, external user ID, and external message ID. Their display name is prefixed by the provider, and pane delivery marks the speaker as untrusted and external. They never acquire owner privileges. Bot, webhook, and system messages are ignored, and incoming messages are never relayed to another external channel. Thread replies, edits, deletions, reactions, and attachment transfer are outside this first integration.

Slack requires an installed `xoxb-` bot token with `chat:write`, `channels:read`, and `channels:history`; add `groups:read` and `groups:history` for private channels. Invite the bot to each selected channel. Discord requires an installed bot with View Channel, Read Message History, and Send Messages permissions. Enable the Message Content privileged intent where required; otherwise Discord can return empty message content. The channel picker accepts Slack public/private channel IDs or Discord guild text/announcement channel IDs; direct-message and thread channels are excluded.

Polling starts at the moment a channel is linked and does not import older history. Slack uses a conservative request window of at least 65 seconds per bot and 15 history messages per page; multiple selected channels rotate. Discord uses a five-second window. Pagination and high-water marks persist across restarts. Provider rate limits delay subsequent work; a rate-limited send remains queued. A disabled connection pauses work and does not queue newly posted local messages; already queued deliveries remain until enabled or disconnected. Unlinking cancels queued deliveries for that link.

Outbound delivery records are written before sending. Successful requests record the provider message ID. A dropped connection, ambiguous upstream failure, or process interruption during a send produces an `unknown` outcome; Reverie never retries it automatically. Inspect the external channel before reposting. This deliberately does not promise exactly-once delivery. A local room message may be accepted before its external queue write succeeds; inspect connection and delivery status for transport results. A queue storage failure is reported in connection status. Disconnection erases the stored token, links, and connection delivery records; revoke the bot token separately at the provider if needed.

The instance runtime file `external-chat.json` stores bot credentials and cursors server-side with mode `0600`, atomically replaced after a file sync. Its parent directory is created with mode `0700`. Credentials are not encrypted at rest; protect the runtime volume and backups as secrets. They are omitted from API responses, browser storage, errors, and external-chat route logs. Do not add runtime state to the repository or container image. Multi-user records and bindings require an exact owner match, including for administrators; a parent-session request cannot configure integrations.

## Console integration

Construct `ExternalChatService` with `{ file: dataPath('external-chat.json'), chatrooms, getSession: id => sessions.get(id) }`. After initializing chatrooms, await `externalChat.init()` and call `externalChat.start()`. Register `registerExternalChatRoutes(app, sessionPort, externalChat)` after the usual authentication boundary. On shutdown, await `externalChat.stop()` before stopping chatrooms. The service subscribes to the chatroom message boundary internally; do not forward broadcasts separately.

Load `external-chat-ui.js` and call `ExternalChatUI.open(app)` from an owner settings button, or embed it with `ExternalChatUI.mount(container, { app })`. The latter returns a disposal callback. The module uses the existing app API helpers and session map. There are no new npm dependencies.

API routes use the existing `{ success, data }` / error envelopes:

| Method | Route                                                      | Purpose                                                              |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/external-chat`                                       | Owner's redacted connections, links, delivery status                 |
| POST   | `/api/external-chat/connections`                           | Verify and save `{provider, agentSessionId, token, label?}` disabled |
| PUT    | `/api/external-chat/connections/:id`                       | Set `{enabled}`; enabling verifies the bot again                     |
| DELETE | `/api/external-chat/connections/:id`                       | Erase connection and stored token                                    |
| GET    | `/api/external-chat/connections/:id/channel?channelId=...` | Look up one explicit channel                                         |
| POST   | `/api/external-chat/connections/:id/links`                 | Link `{roomId, channelId}`                                           |
| DELETE | `/api/external-chat/links/:id`                             | Unlink and cancel queued sends                                       |

## Validation and provider references

`npm test -- test/external-chat.test.ts test/chatroom-store-dm.test.ts test/routes/chatroom-routes.test.ts` exercises real HTTP requests against injected local servers, bot verification, owner isolation, secret redaction, explicit export boundaries, pagination, rate limits, and interrupted/unknown sends. `npm run test:browser -- test/external-chat-ui.browser.test.ts` exercises the owner configuration flow in Chromium using API mocks. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if Chromium is supplied outside Playwright's browser cache. These tests do not establish live provider credentials, grants, or connectivity.

Official provider contracts checked during implementation:

- [Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/)
- [Slack conversations.info](https://docs.slack.dev/reference/methods/conversations.info/)
- [Slack conversations.history and its rate limits](https://docs.slack.dev/reference/methods/conversations.history/)
- [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Discord current user](https://docs.discord.com/developers/resources/user#get-current-user)
- [Discord channel resource](https://docs.discord.com/developers/resources/channel)
- [Discord message resource, content intent and nonce semantics](https://docs.discord.com/developers/resources/message)
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits)
