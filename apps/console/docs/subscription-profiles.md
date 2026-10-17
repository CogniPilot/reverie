# Subscription accounts

Open the Run menu and choose an **Account** before starting an agent. **Agent default**
keeps the existing login behavior. **Add account** gives another subscription a name
and its own login folders; **Sign-in help** shows the commands to connect it. Start a
new session when changing accounts. Existing sessions keep their selected account.

Claude and Codex can use separate accounts side by side. A Claude subscription is for
Claude Code only and cannot be selected for OpenCode; OpenCode can use an OpenAI
account here, or its own Anthropic API key or a local model outside the picker.
Choosing an OpenAI account selects a usable model; use OpenCode's `/models` command
to change it afterward. OpenCode's OpenAI login is separate from Codex CLI's: sign
both clients into the same account named by the profile.

The Plan Usage header shows one compact summary: the account selected for the
current run mode (or, without a selection, the account with the highest 5-hour usage),
followed by a `+N` badge and a caret when other accounts exist. Click it, or press
Enter or Space, to open a dropdown listing every account with its 5-hour and weekly
limits when supplied by the provider and reset times. Each row can switch the account
used for new sessions in the current mode, **Sign in** (see below) or open its sign-in
help, and the footer adds an account. Escape or a click outside closes it. A missing login says **sign in**; a
failed or unsupported quota query says **unavailable**, rather than showing 0%.
Readings are cached for five minutes and credential-file changes invalidate the
cache, so completing a login is picked up promptly. Claude statusline reports update
their own profile directly; a Claude row with no report yet says **unknown**. Nothing
queries Anthropic on Claude's behalf. Codex polling invokes its own app-server under
the profile's `CODEX_HOME`.

Profiles store only names, provider IDs, and local directories in
`~/.codeman/subscription-profiles.json` (or the instance's data directory). They never
store tokens. Credentials stay in the CLI/OpenCode authentication files. Session
state preserves the account label and login directories across dashboard restarts;
it never persists arbitrary OpenCode configuration blobs or API keys.

The existing Claude and Codex accounts appear as default profiles automatically.
Additional directories live under the instance's `accounts/` directory. The two
default profiles share OpenCode's existing data directory; new profiles each get an
isolated OpenCode data directory.

This is supported for local cases. Remote SSH and Docker launches refuse named
local profiles. In multi-user mode, profile management and quota listings are
admin-only, and selecting a profile requires the existing privileged-launch grant.

API endpoints use the normal `{success,data}` envelope:

- `GET /api/subscription-profiles`: profile metadata and compatible agent modes.
- `POST /api/subscription-profiles`: `{label,provider,configDir?}`; provider is
  `anthropic` or `openai`. Omit `configDir` for a new isolated login, or supply an
  absolute directory to register an existing login. Existing files are preserved.
- `GET /api/subscription-profiles/usage`: cached, independent usage readings.
- `POST /api/sessions` and `POST /api/quick-start`: optional `subscriptionProfileId`.
  Unknown or incompatible selections are refused; they never fall back silently.

Profiles cannot be combined with custom model endpoints or explicit login-directory
environment overrides. The custom endpoint selector remains available independently.

## Plans: which accounts have room

Open the header usage chip and choose **Plans...**. Each account gets a card:

- the **week** bar (grey) is how far through its weekly window the account is, and the
  **used** bar is how much of the week it has used, with the 5-hour window below;
- **pace** is used minus elapsed: negative means headroom;
- **burn** is weekly points per hour over the last 6 hours, and **at reset** the usage it
  is heading for at that rate (or **runs out** with the time it hits 100 % first);
- the chip says what to do: **Push** (pace below -15: give its agents more work),
  **Steady**, **Ease off** (pace above +15), **Stop** (5-hour window at 95 % or the week
  at 100 %), or **Sign in**;
- the sessions running on the account are listed under it (tap one to open it), and the
  orchestrator's account is marked. A card for the local GPU shows utilization, memory,
  the model loaded and the last holder of the GPU lock.

The cards cover both Reverie's account profiles and the accounts made with `acct`
(`~/.claude-accounts/<name>`, `~/.codex-accounts/<name>`); two that use the same login
folder are one account, named by its `acct` name. A session's account is shown next to its
CLI in the sessions dropdown and on chat member cards.

`GET /api/plans` returns the same data, and `POST /api/plans/suggest {"provider":
"anthropic"|"openai"}` names the account a new session should use (signed in, not told
to stop, most headroom) together with how to start on it: the `subscriptionProfileId`
and/or `envOverrides` (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) that `POST /api/sessions`
already accepts, which is what the Run menu and `acct spawn` send. Both are admin-only
in multi-user mode.

### Several accounts on one machine

No containers are needed: each login lives in its own folder (`CLAUDE_CONFIG_DIR` for
Claude Code, `CODEX_HOME` for Codex), so any number of Claude and Codex logins stay
signed in side by side and each session uses the one it was started with. What still
needs a person is signing in, because logins are interactive and browser based. Usage
and pace are read from each account's own login; credentials never leave their folders.

### Signing in from the dashboard

Press **Sign in** on a Plans card (or **Sign in again** on a signed-in one, to replace a
login made with the wrong account), or on an account row in the header dropdown:

1. Reverie starts the provider's own login in a hidden helper pinned to that account's
   folder: `claude auth login --claudeai` with its `CLAUDE_CONFIG_DIR`, or
   `codex login --device-auth` with its `CODEX_HOME`. No browser opens on the server.
2. A dialog shows **Open the sign-in page** (on this device), **Copy link**, and a QR code
   under "On another device?" for signing in on a phone.
3. Claude: after signing in, the page shows a code; paste it into the dialog and press
   **Sign in**. Codex: the dialog shows a one-time code to type on the page (it expires in
   15 minutes); nothing comes back.
4. When the account's credential file appears or changes and the CLI's own status
   command reports a login, the dialog says **Signed in as** the account (Claude names
   the email), usage refreshes, and the helper is closed.

A refused or expired code, a declined login, or 15 minutes without finishing ends in a
plain message and **Try again**. Closing the dialog or pressing Escape cancels the
helper. The server never opens or logs the credential files: it only checks their
modification time and logs each state change. The routes behind it are
`POST /api/plans/accounts/:id/login`, `GET /api/plans/logins/:loginId`,
`POST /api/plans/logins/:loginId/code {"code"}` and `DELETE /api/plans/logins/:loginId`
(admin-only in multi-user mode). In a terminal the same login is still
`acct claude <name>` then `/login`, or `acct codex <name> login`; the Plans card shows it
under "or in a terminal".
