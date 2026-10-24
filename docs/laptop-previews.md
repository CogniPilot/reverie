# HTTPS laptop previews

Use **Office → Laptop previews** to choose a laptop, its web port and a page path,
then **Expose and open**. Ask the agent to bind its server to `0.0.0.0` inside its
laptop. It must serve the files itself; the proxy does not install or start it.
Each exposure gets a fresh HTTPS hostname. Root-relative assets and WebAssembly
work without URL rewriting. Your browser can use WebGPU when its GPU/driver supports it.

Previews last 30 minutes. **Stop sharing** revokes the hostname and all its access
links/cookies immediately; in-flight responses stop at their next chunk or timeout.
Closing the browser does not revoke it. A laptop replacement or proxy restart
invalidates the registration; expose the new laptop explicitly. Website restarts
leave the independent proxy running. No port is exposed automatically.

Only the instance owner can manage/open previews. This first version requires a
single-owner instance; multi-user mode fails closed. The owner explicitly opts in
to each port. Agents can request a preview in chat; agent/service headers do not
grant proxy management. GET/HEAD only: POST, WebSocket and live reload are not
supported. Reserved runtime ports 8092 and 8093 cannot be exposed.

## Host setup

A separate preview **domain with wildcard DNS and a matching trusted certificate**
is required, for example `*.preview.example.com`. Point the wildcard DNS record to
the host address reachable by your browsers (a Tailscale IP works for tailnet-only
access). The proxy does not publish anything through an external hosting service.
DNS/certificate issuance may use your existing provider, but page bytes stay local.

Tailscale Serve's ordinary machine certificate does not provision arbitrary preview
subdomains. A VPN alone also does not make an HTTP page a secure browser context.
Do not substitute a same-origin `/previews/...` HTML proxy or bypass certificate
verification. Keep any other public services on their own origins.

Build both artifacts from this repository:

```sh
nix build .#previewProxy .#previewService --no-link
```

Create a private JSON config outside the source checkout. All path values below
must be expanded to absolute host paths; JSON does not expand `~` or `$HOME`.
The domain and office origin are examples to replace, not production defaults.

```json
{
  "version": 1,
  "domain": "preview.example.com",
  "officeOrigin": "https://office.example.com",
  "listenAddress": "100.64.0.10",
  "port": 9443,
  "certificate": "/absolute/private/tls/fullchain.pem",
  "privateKey": "/absolute/private/tls/key.pem",
  "controlSocket": "/absolute/private/control/preview.sock",
  "deployment": "reverie",
  "auditFile": "/absolute/company/data/console/admin-audit.jsonl"
}
```

Use the deployment name from the broker config. The private control directory must
be host-owned and writable only by the owner, never shared with laptops or scratch.
Bind-mount it into **the website only**, at `/run/reverie-control` (or configure
`REVERIE_PREVIEW_SOCKET` to its mounted socket path). Existing deployments can reuse
their website-only control directory. Do not mount the Docker socket into the
website/laptops. The host proxy uses only read-only Docker inspection to resolve
labelled laptop containers and their dedicated networks; it cannot create workers.

Put `REVERIE_PREVIEW_CONFIG=/absolute/private/preview.json` in
`~/.config/reverie/preview-proxy.env` (mode 0600). Install the built
`share/systemd/user/reverie-preview-proxy.service` into the owner's user service
configuration, then enable/start it with `systemctl --user`. NixOS deployments may
manage the equivalent user unit declaratively; retain the unit's resource limits.
For a foreground smoke check:

```sh
nix run .#preview-proxy -- --config /absolute/private/preview.json
```

Allow only the intended client network to reach the configured TLS port. Do not
Funnel or publish it globally by default. The service terminates TLS itself; there
are no forwarded-identity/trusted-proxy headers. Certificate renewal must refresh
the owner-managed files and restart this separate service (revoking previews).
Keys stay on the host. There are no laptop/browser certificate installs.

The optional service is disabled until configured. Missing configuration displays
a useful unavailable message in the owner UI. Installing it does not require a
laptop broker restart or migration.

## Security and limits

Each exposure uses a random unique hostname, a single-use link valid for 60 seconds,
and a host-only HttpOnly/Secure/SameSite=Lax cookie valid until the exposure expires.
Links are bearer capabilities: do not paste them in public chat. The landing
exchange redirects to a clean page path and uses `no-referrer` and `no-store`.
Main-site cookies are host-only too; never configure a parent-domain login cookie.
The proxy strips all cookies/authorization from requests to laptops, and discards
upstream cookies, CORS and security headers. Its own CSP permits only local assets,
WASM and workers; third-party CDNs, forms, framing and cross-origin connections are
blocked. COOP/COEP permit cross-origin isolation for WASM threads.

Only a currently running, correctly labelled container on its own labelled bridge
network can be registered. The container ID, network ID and address are pinned and
rechecked before each upstream request. Caller-selected hosts, DNS resolution,
proxy environment variables, redirects to other hosts and CONNECT are unavailable.
A recreated laptop requires a fresh exposure, so an old origin cannot gain access
to its replacement. This is a web preview capability, not host administration.

Limits: 32 exposures, 8 outstanding links and 8 browser sessions per exposure;
16 active upstream requests total, 4 per preview; 600 requests/minute per preview;
64 MiB per response; 30 seconds total per request, 3-second connection timeout and
10-second upstream read timeout. Registration operations are limited to 2 concurrent
requests; engine inspection also runs at most 2 at once. The user service has a
256 MiB memory limit, 32 tasks and 256 file descriptors. These bounds can reject a
large preview; they do not increase the shared laptop resource budget.

Expose, successful open and unexpose actions append to the existing company
`admin-audit.jsonl`. Tokens, cookies, page paths and query strings are never recorded.
Audit write failure prevents the action. Expiry is enforced at request time; service
restart intentionally clears the in-memory registry and cookies. No engine change,
new network attachment, main-site origin exception or provider session restart is
part of exposing a port.
