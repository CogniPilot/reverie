"""Synthetic TLS upstream/proxy fixture; no Docker, instance data or credentials."""
import asyncio
import json
from pathlib import Path
import signal
import ssl
import sys

from aiohttp import ClientSession, DummyCookieJar, web
from reverie.preview import Preview, applications


async def main():
    task = Path(sys.argv[1])
    received = []
    async def page(request):
        received.append(dict(request.headers))
        if request.path == '/seen':
            return web.json_response(received)
        if request.path == '/app.js':
            return web.Response(text="document.getElementById('app').textContent = 'Agent page ready';", content_type='application/javascript')
        if request.path == '/module.wasm':
            return web.Response(body=b'\x00asm\x01\x00\x00\x00', content_type='application/wasm')
        return web.Response(text='<!doctype html><title>Agent preview</title><p id="app"></p><script src="/app.js"></script>', content_type='text/html')
    upstream = web.Application()
    upstream.router.add_get('/{path:.*}', page)
    up_runner = web.AppRunner(upstream, access_log=None)
    await up_runner.setup()
    up_site = web.TCPSite(up_runner, '127.0.0.1', 0)
    await up_site.start()
    up_port = up_site._server.sockets[0].getsockname()[1]
    async def resolve(_sid):
        return 'fixture-container', 'fixture-network', '127.0.0.1'
    config = {'deployment': 'fixture', 'domain': 'preview.test', 'port': 0, 'auditFile': str(task/'audit.jsonl')}
    proxy = Preview(config, resolve)
    client = ClientSession(cookie_jar=DummyCookieJar(), auto_decompress=False)
    proxy.client = client
    public, private = applications(proxy)
    runners = [web.AppRunner(app, access_log=None) for app in (public, private)]
    for runner in runners:
        await runner.setup()
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(task/'cert.pem', task/'key.pem')
    site = web.TCPSite(runners[0], '127.0.0.1', 0, ssl_context=tls)
    await site.start()
    config['port'] = site._server.sockets[0].getsockname()[1]
    await web.UnixSite(runners[1], str(task/'preview.sock')).start()
    print(json.dumps({'ready': True, 'upstreamPort': up_port}), flush=True)
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    try:
        await stop.wait()
    finally:
        for runner in runners:
            await runner.cleanup()
        await client.close()
        await up_runner.cleanup()


asyncio.run(main())
