/** Real Chromium shipping shell/boot guard + real reader; synthetic APIs and files only. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { it } from 'vitest';
const source = resolve(import.meta.dirname, '..'), require = createRequire(source + '/package.json');
const { chromium } = require('playwright');
const { createServer, member, room, message } = await import('./helpers/chat-app-harness.mjs');
const root = pathToFileURL(source + '/src/web/public/');
const read = n => fs.readFileSync(new URL(n, root), 'utf8');
const stub = fs.readFileSync(source + '/test/helpers/chat-app-harness.mjs', 'utf8').match(/window\.eval\(`([\s\S]*?)`\);/)[1];
const packagePublic = source + '/src/web/public';
function pdf() { let b = '%PDF-1.4\n', offset = [0]; const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>', '<< /Length 3 >>\nstream\nq Q\nendstream']; for (let i = 0; i < objects.length; i++) {
    offset.push(Buffer.byteLength(b));
    b += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
} const x = Buffer.byteLength(b); b += 'xref\n0 5\n0000000000 65535 f \n' + offset.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF'; return Buffer.from(b); }
const bodies = { md: Buffer.from('# Synthetic preview\n\nHarmless local fixture.'), png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==', 'base64'), pdf: pdf() };
it('keeps the real shell viewer visible, interactive and scoped across file types and view modes', async () => {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const results = [];
    const artifacts = process.env.VIEWER_SHELL_ARTIFACTS;
    if (artifacts)
        fs.mkdirSync(artifacts, { recursive: true });
    try {
        for (const [label, width, height] of [['desktop', 1280, 800], ['phone', 393, 852]]) {
            const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 768, isMobile: width < 768, serviceWorkers: 'block' }), errors = [];
            page.on('pageerror', e => { errors.push(e.message); console.log('OWNED_PAGE_ERROR', e.message); });
            await page.route('**/*', r => { const u = new URL(r.request().url()); if (u.origin !== 'https://owned-viewer.test')
                return r.abort(); const hit = /^\/api\/chatrooms\/fixture-room\/files\/fixture-(md|png|pdf)$/.exec(u.pathname); if (hit)
                return r.fulfill({ body: bodies[hit[1]], contentType: hit[1] === 'md' ? 'text/markdown' : hit[1] === 'png' ? 'image/png' : 'application/pdf' }); if (u.pathname.startsWith('/vendor/pdfjs-6.4.299/') || u.pathname === '/file-preview-pdf.mjs') {
                try {
                    const file = packagePublic + u.pathname;
                    return r.fulfill({ body: fs.readFileSync(file), contentType: u.pathname.endsWith('.mjs') ? 'application/javascript' : 'application/octet-stream' });
                }
                catch {
                    return r.abort();
                }
            } if (u.pathname === '/')
                return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }); return r.abort(); });
            await page.goto('https://owned-viewer.test/');
            const markup = read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
            await page.setContent(markup);
            for (const n of ['styles.css', 'chat-app.css', ...(width < 1024 ? ['mobile.css'] : [])])
                await page.addStyleTag({ content: read(n) });
            await page.addScriptTag({ content: `window.MobileDetection={};window.ReverieBase={url:p=>p};window.__nativeFetch=window.fetch.bind(window);` });
            for (const n of ['vendor/marked.min.js', 'vendor/dompurify.min.js'])
                await page.addScriptTag({ content: fs.readFileSync(packagePublic + '/' + n, 'utf8') });
            await page.addScriptTag({ content: read('sanitize-html.js') });
            await page.addScriptTag({ content: `(()=>{${read('constants.js')}\n${read('app.js')}\n${read('panels-ui.js')}\nwindow.ReaderApp=ReverieApp;})();` });
            await page.addScriptTag({ content: `${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()} const user={kind:'user',name:'Owner'};window.ReverieUrlSession={sessionIdFromFragment:()=>null};window.__server=createServer([room('general','General',[])]);window.fetch=(url,options)=>String(url).includes('/api/chatrooms/fixture-room/files/')?window.__nativeFetch(url,options):Promise.resolve({ok:true,json:async()=>({avatars:[]})});${stub}` });
            for (const n of ['chatroom-ui.js', 'chat-media.js'])
                await page.addScriptTag({ content: read(n) });
            await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
            await page.addScriptTag({ content: read('chat-app.js') });
            await page.waitForSelector('.ca-root', { state: 'attached' });
            await page.waitForTimeout(150);
            assert.equal(await page.locator('.app > .main').evaluate(el => getComputedStyle(el).display), 'none');
            await page.evaluate(() => { window.reader = Object.create(window.ReaderApp.prototype); window.reader._elemCache = {}; window.reader.sessions = new Map(); window.reader._copyText = async () => true; window.app.closeFilePreview = () => window.reader.closeFilePreview(); const b = document.createElement('button'); b.id = 'fixture-trigger'; b.textContent = 'Open synthetic file'; window.reverieChat.els.root.append(b); b.style.cssText = 'position:fixed;left:10px;top:10px;z-index:10'; window.__open = type => { b.focus(); return window.__opened = window.reader.openReadOnlyFilePreview({ kind: 'room-attachment', roomId: 'fixture-room', attachmentId: 'fixture-' + type, name: 'sample.' + type }, b); }; });
            for (const type of ['md', 'png', 'pdf']) {
                await page.evaluate(t => window.__open(t), type);
                await page.evaluate(() => window.__opened);
                await page.evaluate(() => { if (!document.getElementById('filePreviewOverlay').contains(document.activeElement))
                    throw Error('Initial focus escaped'); });
                await page.keyboard.press('Shift+Tab');
                await page.keyboard.press('Tab');
                assert.equal(await page.evaluate(() => document.getElementById('filePreviewOverlay').contains(document.activeElement)), true);
                if (type === 'md') assert.equal(await page.locator('#filePreviewBody h1').textContent(), 'Synthetic preview');
                if (type === 'png') await page.locator('#filePreviewBody img').evaluate(el => el.decode());
                if (type === 'png') assert.equal(await page.locator('#filePreviewBody img').evaluate(el => el.naturalWidth), 1);
                if (type === 'pdf') await page.waitForFunction(() => !!document.querySelector('#filePreviewBody canvas')?.width);
                const state = await page.evaluate(() => { const o = document.getElementById('filePreviewOverlay'), close = o.querySelector('[title="Close"]'), c = document.querySelector('.ca-root'); return { overlayVisibleClass: o.classList.contains('visible'), overlayDisplay: getComputedStyle(o).display, overlayParent: o.parentElement.className, overlayZ: getComputedStyle(o).zIndex, chatInert: c.inert, chatZ: getComputedStyle(c).zIndex, closeRects: close.getClientRects().length, bodyText: document.getElementById('filePreviewBody').textContent.slice(0, 100), activeId: document.activeElement.id, guardHidesOverlay: document.getElementById('reverie-view-guard').textContent.includes(':not(.notification-drawer) { display: none') }; });
                const close = page.locator('#filePreviewOverlay [title="Close"]');
                if (width < 768) await close.tap(); else await close.click();
                const closeClickable = true;
                const after = await page.evaluate(() => ({ overlayVisible: document.getElementById('filePreviewOverlay').classList.contains('visible'), chatInert: document.querySelector('.ca-root').inert, focusReturned: document.activeElement.id === 'fixture-trigger' }));
                assert.equal(state.overlayDisplay, 'flex');
                assert.equal(state.chatInert, true);
                assert.equal(closeClickable, true);
                assert.deepEqual(after, { overlayVisible: false, chatInert: false, focusReturned: true });
                results.push({ label, type, input: width < 768 ? 'touch' : 'mouse', ...state, closeClickable, afterClose: after });
                for (const action of ['back', 'escape', 'backdrop']) {
                    await page.evaluate(t => window.__open(t), type);
                    await page.evaluate(() => window.__opened);
                    const bounds = await page.locator('.file-preview-window').boundingBox();
                    const backdropPoint = await page.evaluate(() => { const o = document.getElementById('filePreviewOverlay'); return [[1,1],[innerWidth-1,1],[1,innerHeight-1],[innerWidth-1,innerHeight-1]].find(([x,y]) => document.elementFromPoint(x,y) === o) || null; });
                    if (action === 'back')
                        width < 768 ? await page.locator('.file-preview-source-back').tap() : await page.locator('.file-preview-source-back').click();
                    else if (action === 'escape')
                        await page.keyboard.press('Escape');
                    else
                        width < 768 ? await page.touchscreen.tap(...(backdropPoint || [width / 2, height / 2])) : await page.mouse.click(...(backdropPoint || [width / 2, height / 2]));
                    const closed = await page.evaluate(() => ({ closed: !document.getElementById('filePreviewOverlay').classList.contains('visible'), chatInert: document.querySelector('.ca-root').inert, focusReturned: document.activeElement.id === 'fixture-trigger' }));
                    if (action !== 'backdrop' || backdropPoint)
                        assert.deepEqual(closed, { closed: true, chatInert: false, focusReturned: true });
                    else
                        assert.equal(closed.closed, false);
                    results.push({ label, type, input: width < 768 ? 'touch' : 'mouse', action, bounds, ...closed, physicalBackdropPoint: action === 'backdrop' ? backdropPoint : null, phoneNoPhysicalBackdrop: action === 'backdrop' && width < 768 && !backdropPoint });
                    if (!closed.closed) {
                        await page.evaluate(() => document.getElementById('filePreviewOverlay').dispatchEvent(new MouseEvent('click', { bubbles: true })));
                        assert.equal(await page.evaluate(() => document.getElementById('filePreviewOverlay').classList.contains('visible')), false);
                    }
                }
            }
            for (const legacy of [false, true]) {
                await page.evaluate(legacy => { window.reverieChat.setView('debug', {initial:true}); document.documentElement.toggleAttribute('data-reverie-legacy', legacy); const trigger = document.createElement('button'); trigger.id = 'debug-trigger'; trigger.textContent = 'Open synthetic file'; document.querySelector('.app #terminalContainer').append(trigger); window.__debugOpen = () => window.reader.openReadOnlyFilePreview({ kind: 'room-attachment', roomId: 'fixture-room', attachmentId: 'fixture-md', name: 'sample.md' }, trigger); }, legacy);
                await page.evaluate(() => window.__debugOpen());
                assert.equal(await page.locator('#filePreviewOverlay').evaluate(el => getComputedStyle(el).display), 'flex');
                width < 768 ? await page.locator('.file-preview-source-back').tap() : await page.locator('.file-preview-source-back').click();
                assert.equal(await page.evaluate(() => document.activeElement.id), 'debug-trigger');
                await page.evaluate(() => document.getElementById('debug-trigger').remove());
            }
            assert.deepEqual(errors, []);
            if (artifacts)
                await page.screenshot({ path: artifacts + '/' + label + '-closed.png' });
            await page.close();
        }
    }
    finally {
        await browser.close();
        if (artifacts)
            fs.writeFileSync(artifacts + '/RESULT.json', JSON.stringify({ scope: 'shipping full shell/boot CSS/reader with controlled app and file responses; not installed owner acceptance', results }, null, 2) + '\n');
    }
});
