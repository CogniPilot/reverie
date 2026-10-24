# Laptop previews

Choose **Office → Laptop previews**, select the agent's laptop, port and page
path, then **Expose and open**. The agent must first serve the page on `0.0.0.0`
inside its laptop. Ask for the port and page path, not a private Docker IP.

Agents: start your web server and send the owner your laptop session ID, port and
page path. Find your session ID with `printenv REVERIE_SESSION_ID` in your laptop
terminal. Ports 8092 and 8093 are reserved and cannot be exposed.
You can post a prefilled owner-page link, for example
`/previews?sessionId=YOUR-SESSION-ID&port=8734&path=%2Findex.html`.
URL-encode the page path. The owner still chooses **Expose and open**; this link
itself exposes nothing and carries no preview credentials. There is no agent
exposure command in this version. Do not use third-party artifact hosting.

The preview opens in a separate HTTPS tab, so WebGPU can work where your browser
and hardware support it. Each exposure has its own address and expires after
30 minutes. Choose **Stop sharing** to revoke it sooner. A new laptop or proxy
restart requires a new exposure; restarting the website alone does not.

Only the owner can expose/open ports. Agents request this in chat. Nothing is
published by default. Links carry short-lived access: do not post them publicly.
Pages can load their local files and WASM; external CDNs, forms and live-reload
WebSockets are unavailable in this version. Use GET/HEAD previews only.

If the service is unavailable, the host needs a dedicated wildcard preview domain,
a trusted certificate and the optional Nix-built proxy service. The owner setup
guide is `docs/laptop-previews.md` in the Reverie source repository. A Tailscale
machine address alone does not provide wildcard preview hostnames. There is no
certificate installation on agent laptops or your browser.

See [Office laptops](/handbook/laptops) for package installation and host boundaries.
