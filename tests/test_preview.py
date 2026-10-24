"""Real HTTP tests of the separate-origin proxy, with synthetic upstream only."""
import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, DummyCookieJar, web
from aiohttp.test_utils import TestClient, TestServer
from reverie.preview import (ACCESS_TTL, COOKIE, MAX_RESPONSE, Grant, LaptopResolver,
                             Preview, applications, config_from_file, safe_path)

SID = '11111111-2222-3333-4444-555555555555'


class PreviewHTTP(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.task = tempfile.TemporaryDirectory()
        self.now = 10.0
        self.seen = []
        self.hold = asyncio.Event()
        self.entered = asyncio.Event()
        async def upstream(request):
            self.seen.append((request.raw_path, dict(request.headers)))
            if request.path == '/redirect':
                raise web.HTTPFound('http://169.254.169.254/latest/meta-data')
            if request.path == '/local':
                raise web.HTTPFound('/page?part=2')
            if request.path == '/large':
                return web.Response(headers={'Content-Length': str(MAX_RESPONSE + 1)})
            if request.path == '/hold':
                self.entered.set()
                await self.hold.wait()
            return web.Response(body=b'\x00\x61\x73\x6d\x01\x00\x00\x00', content_type='application/wasm',
                                headers={'Set-Cookie': 'reverie_owner=stolen; Domain=example.test',
                                         'Access-Control-Allow-Origin': '*', 'X-Secret': 'hidden'})
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', upstream)
        self.upstream = TestServer(app)
        await self.upstream.start_server()
        self.target = ('container-a', 'network-a', '127.0.0.1')
        self.resolve = AsyncMock(side_effect=lambda _: self.target)
        self.config = {'deployment': 'fixture', 'domain': 'preview.example.test', 'port': 9443,
                       'auditFile': self.task.name + '/audit.jsonl'}
        self.proxy = Preview(self.config, self.resolve, now=lambda: self.now)
        self.proxy.client = ClientSession(cookie_jar=DummyCookieJar(), auto_decompress=False)
        public, private = applications(self.proxy)
        self.public = TestClient(TestServer(public), cookie_jar=DummyCookieJar())
        self.private = TestClient(TestServer(private))
        await self.public.start_server()
        await self.private.start_server()
        response = await self.private.post('/previews', json={'sessionId': SID, 'port': self.upstream.port, 'path': '/page?x=1'})
        self.assertEqual(response.status, 201)
        self.created = await response.json()
        self.grant = self.proxy.grants[self.created['preview']['id']]
        self.host = self.proxy.origin(self.grant)[8:]

    async def asyncTearDown(self):
        self.hold.set()
        await self.public.close()
        await self.private.close()
        await self.proxy.client.close()
        await self.upstream.close()
        self.task.cleanup()

    async def exchange(self, url=None, host=None):
        from urllib.parse import urlsplit
        url = urlsplit(url or self.created['url'])
        return await self.public.get(url.path + '?' + url.query, headers={'Host': host or self.host}, allow_redirects=False)

    async def authorize(self):
        response = await self.exchange()
        self.assertEqual(response.status, 303)
        self.assertEqual(response.headers['Location'], '/page?x=1')
        cookie = response.cookies[COOKIE]
        for key in ('secure', 'httponly'):
            self.assertTrue(cookie[key])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['path'], '/')
        self.assertFalse(cookie['domain'])
        return cookie.value

    async def get(self, path='/', cookie=None, **kwargs):
        return await self.public.get(path, headers={'Host': self.host, 'Cookie': f'{COOKIE}={cookie or ""}; reverie_owner=owner-secret',
                                                   'Authorization': 'Bearer site-secret', 'X-Reverie-Service-Token': 'secret'},
                                     allow_redirects=False, **kwargs)

    async def test_unknown_host_and_no_cookie_do_not_proxy(self):
        for host in ('office.example.test', 'missing.preview.example.test', self.host + '.evil.test'):
            response = await self.exchange(host=host)
            self.assertEqual(response.status, 404)
        response = await self.get()
        self.assertEqual(response.status, 403)
        self.assertEqual(self.seen, [])
        self.assertEqual(self.resolve.await_count, 1)

    async def test_one_use_link_host_scoping_expiry_and_revocation(self):
        cookie = await self.authorize()
        self.assertEqual((await self.exchange()).status, 403)
        response = await self.get('/assets/module.wasm', cookie)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), b'\x00asm\x01\x00\x00\x00')
        self.now += ACCESS_TTL + 1
        self.assertEqual((await self.get('/', cookie)).status, 404)

    async def test_strip_credentials_cookie_cors_and_keep_wasm(self):
        cookie = await self.authorize()
        response = await self.get('/module.wasm?binary=1', cookie)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Content-Type'], 'application/wasm')
        self.assertNotIn('Set-Cookie', response.headers)
        self.assertNotIn('Access-Control-Allow-Origin', response.headers)
        self.assertNotIn('X-Secret', response.headers)
        for forbidden in ('cookie', 'authorization', 'x-reverie-service-token', 'referer', 'origin'):
            self.assertNotIn(forbidden, {key.lower() for key in self.seen[-1][1]})
        self.assertIn("connect-src 'self'", response.headers['Content-Security-Policy'])
        self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'require-corp')
        self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
        audit = Path(self.config['auditFile']).read_text()
        self.assertIn('preview_expose', audit)
        self.assertIn('preview_open', audit)
        self.assertNotIn(cookie, audit)
        self.assertNotIn(self.created['url'], audit)
        self.assertNotIn('/module.wasm', audit)

    async def test_no_redirect_ssrf_or_oversize(self):
        cookie = await self.authorize()
        self.assertEqual((await self.get('/redirect', cookie)).status, 502)
        response = await self.get('/local', cookie)
        self.assertEqual(response.status, 302)
        self.assertEqual(response.headers['Location'], '/page?part=2')
        self.assertEqual((await self.get('/large', cookie)).status, 502)

    async def test_no_mutations_websocket_or_public_management(self):
        cookie = await self.authorize()
        for method in ('POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS'):
            response = await self.public.request(method, '/', headers={'Host': self.host, 'Cookie': COOKIE + '=' + cookie})
            self.assertIn(response.status, (404, 405))  # CONNECT can be rejected by the router first.
        response = await self.public.get('/', headers={'Host': self.host, 'Upgrade': 'websocket'})
        self.assertEqual(response.status, 405)
        self.assertEqual(self.seen, [])
        self.assertEqual((await self.public.post('/previews', json={})).status, 404)

    async def test_bounded_concurrency_rate_and_revoke_active(self):
        cookie = await self.authorize()
        tasks = [asyncio.create_task(self.get('/hold', cookie)) for _ in range(4)]
        await self.entered.wait()
        for _ in range(100):
            if self.grant.active == 4:
                break
            await asyncio.sleep(0.001)
        self.assertEqual((await self.get('/', cookie)).status, 429)
        self.hold.set()
        responses = await asyncio.gather(*tasks)
        for response in responses:
            await response.read()
        self.grant.requests.extend([self.now] * 600)
        self.assertEqual((await self.get('/', cookie)).status, 429)
        self.assertEqual((await self.private.delete('/previews/' + self.grant.id)).status, 200)
        self.assertEqual((await self.get('/', cookie)).status, 404)

    async def test_recreated_container_does_not_inherit_origin(self):
        cookie = await self.authorize()
        self.target = ('container-b', 'network-a', '127.0.0.1')
        self.assertEqual((await self.get('/', cookie)).status, 410)
        self.assertEqual(self.seen, [])
        self.assertNotIn(self.grant.id, self.proxy.grants)

    async def test_registration_rejects_raw_hosts_reserved_port_and_paths(self):
        for change in ({'host': '169.254.169.254'}, {'port': 8092}, {'port': 8093}, {'port': True}, {'sessionId': '127.0.0.1'},
                       {'path': '//evil.test/'}, {'path': '/\\evil.test'}, {'path': '/__reverie_preview_open'}):
            body = {'sessionId': SID, 'port': 8734, 'path': '/'} | change
            response = await self.private.post('/previews', json=body)
            self.assertEqual(response.status, 400, change)

    async def test_link_expires_and_does_not_authenticate_another_host(self):
        body = {'sessionId': SID, 'port': self.upstream.port, 'path': '/'}
        other = await (await self.private.post('/previews', json=body)).json()
        host = self.proxy.origin(self.proxy.grants[other['preview']['id']])[8:]
        self.assertEqual((await self.exchange(host=host)).status, 403)
        self.now += 61
        self.assertEqual((await self.exchange()).status, 403)


class ResolverPolicy(unittest.IsolatedAsyncioTestCase):
    async def test_only_exact_labelled_private_bridge_laptop(self):
        resolver = LaptopResolver('fixture')
        name = 'fixture-agent-' + SID
        meta = {'running': True, 'labels': {'reverie.worker': 'fixture', 'reverie.session': SID},
                'networks': {name + '-lan': {'IPAddress': '172.30.0.2', 'NetworkID': 'network-a'}}}
        net = {'labels': {'reverie.worker': 'fixture', 'reverie.session': SID}, 'driver': 'bridge'}
        with patch('reverie.preview.engine', AsyncMock(side_effect=['container-a', meta, net])):
            self.assertEqual(await resolver(SID), ('container-a', 'network-a', '172.30.0.2'))
        for address in ('127.0.0.1', '169.254.169.254', '8.8.8.8', '0.0.0.0'):
            meta['networks'][name + '-lan']['IPAddress'] = address
            with patch('reverie.preview.engine', AsyncMock(side_effect=['container-a', meta])):
                with self.assertRaises(ValueError):
                    await resolver(SID)
