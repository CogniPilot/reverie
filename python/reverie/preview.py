"""Isolated HTTPS laptop previews. Host-owned control socket; no agent engine access.

All grants are ephemeral: restarting this service revokes URLs, cookies and registrations.
The public listener has no management routes. See docs/laptop-previews.md.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import deque
from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import ssl
import time
from urllib.parse import urlencode, urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, DummyCookieJar, TCPConnector, web

UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
DOMAIN = re.compile(r"(?=.{1,200}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
COOKIE = "__Host-reverie_preview"
MAX_RESPONSE = 64 * 1024 * 1024
MAX_GRANTS = 32
MAX_ACTIVE = 16
PER_PREVIEW = 4
TIMEOUT = 30
ACCESS_TTL = 1800
LINK_TTL = 60
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; "
       "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'")
HEADERS = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000",
    "Content-Security-Policy": CSP,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
    "Origin-Agent-Cluster": "?1",
}
# Allow lists, rather than trying to enumerate every credential/header extension.
REQUEST_HEADERS = {"accept", "accept-language", "range", "if-range", "if-none-match", "if-modified-since"}
RESPONSE_HEADERS = {"content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"}


def safe_path(value):
    if (not isinstance(value, str) or len(value) > 4096 or not value.startswith("/") or
            value.startswith("//") or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError("A local absolute page path is required")
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.fragment or parsed.path.startswith("/__reverie_preview"):
        raise ValueError("Invalid preview page path")
    return value


def config_from_file(path):
    raw = json.loads(Path(path).read_text())
    required = {"version", "domain", "officeOrigin", "listenAddress", "port", "certificate", "privateKey",
                "controlSocket", "deployment", "auditFile"}
    if set(raw) != required or raw["version"] != 1:
        raise ValueError("Invalid preview configuration keys/version")
    if not DOMAIN.fullmatch(raw["domain"]) or raw["domain"].endswith(".ts.net"):
        raise ValueError("A dedicated wildcard preview DNS domain is required")
    office = urlsplit(raw["officeOrigin"])
    if (office.scheme != "https" or not office.hostname or office.username or office.password or
            office.path not in ("", "/") or office.query or office.fragment):
        raise ValueError("officeOrigin must be the HTTPS console origin")
    # A parent/same preview host could share host-only cookies. Child/sibling domains
    # are safe only with the console's existing host-only cookies (documented).
    if office.hostname == raw["domain"] or office.hostname.endswith("." + raw["domain"]):
        raise ValueError("Console and preview hostname namespaces must be disjoint")
    ipaddress.ip_address(raw["listenAddress"])
    if type(raw["port"]) is not int or not 1024 <= raw["port"] <= 65535:
        raise ValueError("Use an unprivileged preview listener port")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", raw["deployment"]):
        raise ValueError("Invalid deployment")
    for name in ("certificate", "privateKey", "controlSocket", "auditFile"):
        if not Path(raw[name]).is_absolute():
            raise ValueError(name + " must be an absolute owner-selected path")
    return raw


async def engine(*args):
    """Narrow read-only metadata projection: never read container Env or mounts."""
    child = await asyncio.create_subprocess_exec("docker", *args, stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.DEVNULL,
                                                  env={**os.environ, "GOMAXPROCS": "2"})
    try:
        out, _ = await asyncio.wait_for(child.communicate(), 3)
        if child.returncode or len(out) > 32768:
            raise ValueError("Laptop unavailable")
        return json.loads(out)
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()


class LaptopResolver:
    def __init__(self, deployment):
        self.deployment = deployment
        self.slots = asyncio.Semaphore(2)

    async def __call__(self, sid):
        async with self.slots:
            return await self.lookup(sid)

    async def lookup(self, sid):
        if not UUID.fullmatch(sid):
            raise ValueError("Invalid laptop session")
        name = self.deployment + "-agent-" + sid
        data = await engine("inspect", "--format", '{{json .Id}}', name)
        meta = await engine("inspect", "--format",
                            '{"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}}}', data)
        labels = meta["labels"] or {}
        network = meta["networks"].get(name + "-lan", {})
        address = ipaddress.ip_address(network.get("IPAddress", ""))
        # The broker creates exactly this per-laptop network; refuse shared/host mode.
        if (meta["running"] is not True or labels.get("reverie.worker") != self.deployment or
                labels.get("reverie.session") != sid or len(meta["networks"]) != 1 or
                address.version != 4 or not address.is_private or address.is_loopback or
                address.is_link_local or address.is_unspecified or
                not any(address in ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))):
            raise ValueError("Laptop ownership/network mismatch")
        net = await engine("network", "inspect", "--format",
                           '{"labels":{{json .Labels}},"driver":{{json .Driver}}}', network["NetworkID"])
        # Network identity is pinned as well as the container, preventing stale-IP reuse.
        if ((net["labels"] or {}).get("reverie.worker") != self.deployment or net["driver"] != "bridge" or
                (net["labels"] or {}).get("reverie.session") != sid):
            raise ValueError("Unregistered laptop network")
        return data, network["NetworkID"], str(address)


@dataclass
class Grant:
    id: str
    session: str
    port: int
    target: tuple
    expires: float
    active: int = 0
    requests: deque = field(default_factory=deque)
    links: dict = field(default_factory=dict)
    cookies: dict = field(default_factory=dict)


class Preview:
    def __init__(self, config, resolve=None, now=time.monotonic):
        self.config = config
        self.resolve = resolve or LaptopResolver(config["deployment"])
        self.now = now
        self.grants = {}
        self.active = 0
        self.management_active = 0
        self.client = None

    def audit(self, action, grant, **detail):
        # Existing owner audit JSONL; never log URLs, paths, query strings or tokens.
        entry = {"ts": int(time.time() * 1000), "admin": "owner", "action": action,
                 "target": grant.session, "detail": {"previewId": grant.id, "port": grant.port, **detail}}
        with open(self.config["auditFile"], "a", encoding="utf-8") as stream:
            os.chmod(self.config["auditFile"], 0o600)
            stream.write(json.dumps(entry) + "\n")

    def prune(self):
        now = self.now()
        for key, grant in list(self.grants.items()):
            if grant.expires <= now:
                del self.grants[key]
            else:
                grant.links = {k: v for k, v in grant.links.items() if v[0] > now}
                grant.cookies = {k: v for k, v in grant.cookies.items() if v > now}

    def origin(self, grant):
        port = self.config["port"]
        return "https://" + grant.id + "." + self.config["domain"] + (":" + str(port) if port != 443 else "")

    def summary(self, grant):
        return {"id": grant.id, "sessionId": grant.session, "port": grant.port,
                "origin": self.origin(grant), "expiresIn": max(0, int(grant.expires - self.now()))}

    async def control(self, request):
        # Only reachable through a 0600 UNIX socket, never the preview TCP listener.
        self.prune()
        if self.management_active >= 2:
            raise web.HTTPServiceUnavailable()
        self.management_active += 1
        try:
            if request.method == "GET" and request.path == "/previews":
                return web.json_response({"previews": [self.summary(g) for g in self.grants.values()]})
            if request.method == "POST" and request.path == "/previews":
                raw = await request.json()
                if set(raw) != {"sessionId", "port", "path"}:
                    raise ValueError("Select a session, port and local page path")
                sid, port = raw["sessionId"], raw["port"]
                if (not isinstance(sid, str) or not UUID.fullmatch(sid) or type(port) is not int or
                        not 1024 <= port <= 65535 or port in (8092, 8093)):
                    raise ValueError("Invalid laptop session/port")
                page = safe_path(raw["path"])
                if len(self.grants) >= MAX_GRANTS:
                    raise web.HTTPTooManyRequests()
                target = await self.resolve(sid)
                grant = Grant(secrets.token_hex(16), sid, port, target, self.now() + ACCESS_TTL)
                self.audit("preview_expose", grant)
                self.grants[grant.id] = grant
                return web.json_response({"preview": self.summary(grant), "url": self.open_link(grant, page)}, status=201)
            match = re.fullmatch(r"/previews/([0-9a-f]{32})(/open)?", request.path)
            grant = self.grants.get(match[1]) if match else None
            if grant and request.method == "DELETE" and not match[2]:
                self.audit("preview_unexpose", grant)
                del self.grants[grant.id]
                return web.json_response({"success": True})
            if grant and request.method == "POST" and match[2]:
                raw = await request.json()
                if set(raw) != {"path"}:
                    raise ValueError("Only a local page path is accepted")
                return web.json_response({"url": self.open_link(grant, safe_path(raw["path"]))})
            raise web.HTTPNotFound()
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            raise web.HTTPBadRequest(text="Invalid or unavailable laptop preview") from None
        finally:
            self.management_active -= 1

    def open_link(self, grant, page):
        if len(grant.links) >= 8:
            raise web.HTTPTooManyRequests()
        token = secrets.token_urlsafe(32)
        grant.links[hashlib.sha256(token.encode()).hexdigest()] = (self.now() + LINK_TTL, page)
        return self.origin(grant) + "/__reverie_preview_open?" + urlencode({"token": token})

    async def handle(self, request):
        self.prune()
        host = request.headers.get("Host", "")
        grant = next((g for g in self.grants.values() if self.origin(g)[8:] == host), None)
        if not grant:
            raise web.HTTPNotFound()
        if request.method not in ("GET", "HEAD") or request.headers.get("Upgrade"):
            raise web.HTTPMethodNotAllowed(request.method, ["GET", "HEAD"])
        if request.content_length or request.headers.get("Transfer-Encoding"):
            raise web.HTTPBadRequest()
        # Don't accept proxy identity headers or main-site credentials. A host-only
        # preview cookie is the sole authority, independent from the office login.
        if request.path == "/__reverie_preview_open":
            if request.method != "GET" or set(request.query) != {"token"}:
                raise web.HTTPBadRequest()
            token = request.query["token"]
            entry = grant.links.pop(hashlib.sha256(token.encode()).hexdigest(), None)
            if not entry or entry[0] <= self.now():
                raise web.HTTPForbidden()
            if len(grant.cookies) >= 8:
                raise web.HTTPTooManyRequests()
            cookie = secrets.token_urlsafe(32)
            self.audit("preview_open", grant)
            grant.cookies[hashlib.sha256(cookie.encode()).hexdigest()] = grant.expires
            response = web.Response(status=303, headers={**HEADERS, "Location": entry[1]})
            response.set_cookie(COOKIE, cookie, max_age=int(grant.expires - self.now()),
                                httponly=True, secure=True, samesite="Lax", path="/")
            return response
        cookie = request.cookies.get(COOKIE, "")
        if grant.cookies.get(hashlib.sha256(cookie.encode()).hexdigest(), 0) <= self.now():
            raise web.HTTPForbidden()
        if request.path.startswith("/__reverie_preview"):
            raise web.HTTPNotFound()
        now = self.now()
        while grant.requests and grant.requests[0] < now - 60:
            grant.requests.popleft()
        if len(grant.requests) >= 600 or grant.active >= PER_PREVIEW or self.active >= MAX_ACTIVE:
            raise web.HTTPTooManyRequests(headers={"Retry-After": "5"})
        grant.requests.append(now)
        grant.active += 1
        self.active += 1
        try:
            async with asyncio.timeout(TIMEOUT):
                # A new container or network invalidates the registration instead
                # of silently retargeting an already trusted preview hostname.
                target = await self.resolve(grant.session)
                if target != grant.target:
                    self.grants.pop(grant.id, None)
                    raise web.HTTPGone()
                raw_path = safe_path(request.raw_path)
                headers = {k: v for k, v in request.headers.items() if k.lower() in REQUEST_HEADERS}
                headers["Accept-Encoding"] = "identity"
                url = f"http://{target[2]}:{grant.port}" + raw_path
                async with self.client.request(request.method, url, headers=headers, allow_redirects=False) as upstream:
                    if upstream.status < 200:
                        raise web.HTTPBadGateway(text="Preview protocol upgrade refused")
                    # No arbitrary redirect hops; local root paths stay on this origin.
                    location = upstream.headers.get("Location")
                    out = {k: v for k, v in upstream.headers.items() if k.lower() in RESPONSE_HEADERS}
                    if upstream.headers.get("Content-Encoding", "identity").lower() != "identity":
                        raise web.HTTPBadGateway()
                    if location:
                        try:
                            out["Location"] = safe_path(location)
                        except ValueError:
                            raise web.HTTPBadGateway(text="External preview redirect refused") from None
                    if upstream.content_length is not None and upstream.content_length > MAX_RESPONSE:
                        raise web.HTTPBadGateway(text="Preview response exceeds 64 MiB")
                    response = web.StreamResponse(status=upstream.status, headers={**out, **HEADERS})
                    await response.prepare(request)
                    size = 0
                    async for chunk in upstream.content.iter_chunked(65536):
                        size += len(chunk)
                        if size > MAX_RESPONSE or grant.id not in self.grants or grant.expires <= self.now():
                            response.force_close()
                            if request.transport:
                                request.transport.close()
                            return response
                        await response.write(chunk)
                    await response.write_eof()
                    return response
        except (TimeoutError, OSError, ValueError, ClientError):
            # If headers have already streamed, close instead of appending an error page.
            if 'response' in locals() and response.prepared:
                if request.transport:
                    request.transport.close()
                return response
            raise web.HTTPBadGateway(text="Laptop preview unavailable") from None
        finally:
            grant.active -= 1
            self.active -= 1


@web.middleware
async def security_headers(request, handler):
    try:
        response = await handler(request)
    except web.HTTPException as error:
        error.headers.update(HEADERS)
        raise
    response.headers.update(HEADERS)
    return response


def applications(proxy):
    public = web.Application(client_max_size=1024, middlewares=[security_headers])
    public.router.add_route("*", "/{path:.*}", proxy.handle)
    private = web.Application(client_max_size=4096, middlewares=[security_headers])
    private.router.add_route("*", "/{path:.*}", proxy.control)
    return public, private


async def serve(config):
    os.umask(0o077)
    control = Path(config["controlSocket"])
    control.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if control.parent.stat().st_uid != os.getuid() or control.parent.stat().st_mode & 0o077 or control.is_symlink():
        raise ValueError("Control socket requires an owner-only private directory")
    if control.exists() or control.is_socket():
        if not control.is_socket() or control.stat().st_uid != os.getuid():
            raise ValueError("Refusing an unexpected control socket path")
        try:
            _reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(control)), 1)
        except ConnectionRefusedError:
            control.unlink()
        else:
            writer.close()
            await writer.wait_closed()
            raise ValueError("Preview control socket is already in use")
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(config["certificate"], config["privateKey"])
    # Handshakes must finish before aiohttp sees Host. Reject foreign SNI too.
    pattern = re.compile(r"[0-9a-f]{32}\." + re.escape(config["domain"]) + r"\Z")
    def sni(_connection, name, _context):
        if not isinstance(name, str) or not pattern.fullmatch(name):
            return ssl.ALERT_DESCRIPTION_UNRECOGNIZED_NAME
        return None
    tls.set_servername_callback(sni)
    proxy = Preview(config)
    stopping = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, stopping.set)
    connector = TCPConnector(limit=MAX_ACTIVE, limit_per_host=PER_PREVIEW, family=socket.AF_INET)
    async with ClientSession(connector=connector, cookie_jar=DummyCookieJar(), auto_decompress=False,
                             trust_env=False, timeout=ClientTimeout(total=TIMEOUT, connect=3, sock_read=10)) as client:
        proxy.client = client
        public, private = applications(proxy)
        runners = [web.AppRunner(app, access_log=None, keepalive_timeout=5, max_line_size=8192,
                                 max_field_size=8192, lingering_time=0) for app in (public, private)]
        try:
            for runner in runners:
                await runner.setup()
            await web.UnixSite(runners[1], str(control)).start()
            os.chmod(control, 0o600)
            await web.TCPSite(runners[0], config["listenAddress"], config["port"], ssl_context=tls,
                              backlog=32).start()
            await stopping.wait()
        finally:
            for runner in reversed(runners):
                await runner.cleanup()
            control.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(serve(config_from_file(args.config)))


if __name__ == "__main__":
    main()
