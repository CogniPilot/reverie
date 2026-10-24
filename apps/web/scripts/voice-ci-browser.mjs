import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './voice-ci-launch.mjs';
import { settleVoiceRequests } from './voice-ci-requests.mjs';

const root = resolve(process.env.REVERIE_VOICE_CI_ARTIFACTS);
await mkdir(root, { recursive: true });
const base = (await readFile(resolve(root, 'console-url.txt'), 'utf8')).trim();
assert.equal(new URL(base).hostname, '127.0.0.1');
const browser = await chromium.launch({
  ...chromiumLaunchOptions(),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const timings = [];
const inFlight = new Map();
const playback = [];
const phases = [];
const runStartedMs = performance.now();
const record = (event, detail = {}) => {
  const entry = { event, elapsedMs: performance.now() - runStartedMs, ...detail };
  phases.push(entry);
  console.log(JSON.stringify(entry));
};
const deadline = setTimeout(() => {
  record('browser-deadline', { budgetMs: 300000 });
  void browser.close();
}, 300000);
const captures = [],
  clips = [],
  captureFailures = [];
let clipIndex = 0;
page.on('request', (request) => {
  if (request.url().includes('/api/voice/')) {
    const item = { url: request.url(), method: request.method(), startMs: performance.now() };
    inFlight.set(request, item);
    timings.push(item);
  }
});
page.on('response', (response) => {
  const item = inFlight.get(response.request());
  if (item) Object.assign(item, { headersMs: performance.now(), status: response.status() });
  if (
    response.status() === 200 &&
    response.request().method() === 'POST' &&
    /\/api\/voice\/(speak|turn)(?:\?|$)/.test(response.url())
  ) {
    const index = clipIndex++;
    captures.push(
      (async () => {
        const result = await response.json();
        assert.ok(result.data.audioUrl, 'Every acceptance synth response needs audio');
        const request = response.request();
        const turn = response.url().includes('/turn');
        const expected = turn ? result.data.reply : request.postDataJSON().text;
        const audio = await context.request.get(new URL(result.data.audioUrl, base).href);
        assert.equal(audio.status(), 200);
        assert.match(audio.headers()['content-type'], /^audio\/wav/);
        const file = `clip-${String(index).padStart(3, '0')}.wav`;
        await writeFile(resolve(root, file), await audio.body());
        clips.push({ file, expected, endpoint: turn ? 'turn' : 'speak', voice: result.data.voice ?? null });
      })().catch((error) => captureFailures.push(error))
    );
  }
});
page.on('requestfinished', (request) => {
  const item = inFlight.get(request);
  if (item) item.endMs = performance.now();
});
page.on('requestfailed', (request) => {
  const item = inFlight.get(request);
  if (item) Object.assign(item, { endMs: performance.now(), failure: request.failure()?.errorText });
});
page.on('console', (message) => record('browser-console', { level: message.type(), text: message.text() }));
page.on('pageerror', (error) => record('browser-error', { error: error.message }));
page.on('requestfailed', (request) =>
  record('request-failed', { url: request.url(), error: request.failure()?.errorText })
);
const heartbeat = setInterval(
  () =>
    console.log(
      JSON.stringify({
        stage: 'voice-ci',
        elapsedMs: performance.now(),
        requests: timings.length,
        last: timings.at(-1)?.url,
      })
    ),
  5000
);

async function capture(url, name) {
  // Fetch in the browser, not a mock or a direct read from the synthesizer cache.
  const clip = await page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Audio HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(bytes.buffer.slice(0));
      return { base64: btoa(binary), duration: decoded.duration, sampleRate: decoded.sampleRate };
    } finally {
      await context.close();
    }
  }, url);
  await writeFile(resolve(root, `${name}.wav`), Buffer.from(clip.base64, 'base64'));
  await writeFile(
    resolve(root, `${name}.browser.json`),
    JSON.stringify({ duration: clip.duration, sampleRate: clip.sampleRate })
  );
  return clip;
}

try {
  record('navigation-start');
  await page.addInitScript(() => {
    const started = performance.now();
    setInterval(
      () => console.log(JSON.stringify({ event: 'document-heartbeat', documentMs: performance.now() - started })),
      5000
    );
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  record('navigation-complete');
  const fixture = await page.evaluate(async () => (await fetch('/fixture')).json());
  const requestBudget = (item) =>
    item.method === 'POST'
      ? item.url.includes('/turn')
        ? fixture.budgetsMs.turn
        : fixture.budgetsMs.speak
      : fixture.budgetsMs.audioFetch;
  const drainRequests = async (phase) => {
    record('request-drain-start', { phase });
    await settleVoiceRequests(timings, requestBudget);
    await Promise.all(captures);
    record('request-drain-complete', { phase });
  };
  // A full, long route response is validated separately from sentence-batched car playback.
  record('speak-start');
  const speak = await page.evaluate(async (f) => {
    const response = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: f.room, member: f.member, text: f.reply }),
    });
    if (!response.ok) throw new Error(`Speak HTTP ${response.status}`);
    return response.json();
  }, fixture);
  assert.equal(speak.data.voice.id, fixture.voice);
  await capture(speak.data.audioUrl, 'speak');
  record('speak-complete');

  record('turn-start');
  const input = await page.evaluate(async (f) => {
    const response = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: f.room, member: f.member, text: f.input }),
    });
    if (!response.ok) throw new Error(`Input speech HTTP ${response.status}`);
    const result = await response.json();
    const audio = await fetch(result.data.audioUrl);
    const turn = await fetch(`/api/voice/turn?room=${f.room}&member=${f.member}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: await audio.arrayBuffer(),
    });
    if (!turn.ok) throw new Error(`Turn HTTP ${turn.status}: ${await turn.text()}`);
    return turn.json();
  }, fixture);
  assert.equal(input.data.reply, fixture.reply);
  assert.ok(input.data.audioUrl, 'Turn must return playable audio');
  await writeFile(resolve(root, 'turn.json'), JSON.stringify(input.data, null, 2));
  const full = await capture(input.data.audioUrl, 'turn');
  record('turn-complete', { clipSeconds: full.duration });

  // Exercise the production audio element/watchdog on a real >10s clip. A transient
  // waiting/playing cycle must not leave the old 10s timer armed against resumed audio.
  record('long-playback-start');
  const longPlayback = await page.evaluate(
    async ({ url, expected }) => {
      const app = Object.create(ReverieApp.prototype);
      const audio = document.querySelector('audio');
      app._chatAudio = audio;
      app._chatAudioEl = () => audio;
      app._chatUrl = (value) => value;
      const events = [];
      const link = { turnId: crypto.randomUUID(), messageId: crypto.randomUUID(), utteranceIndex: 0 };
      for (const name of ['playing', 'waiting', 'pause', 'timeupdate', 'ended', 'error'])
        audio.addEventListener(name, () => events.push({ name, atMs: performance.now(), position: audio.currentTime }));
      const synth = app._carTeamSynth({ speaking: false, pending: false }, (event, info) =>
        events.push({ event, info, atMs: performance.now() })
      );
      audio.addEventListener(
        'playing',
        () => {
          audio.dispatchEvent(new Event('waiting'));
          audio.dispatchEvent(new Event('playing'));
        },
        { once: true }
      );
      const start = performance.now();
      await synth.deps.play(url, link);
      if (audio.currentTime < expected - 0.5) throw new Error('Long reply stopped early');
      return { duration: audio.duration, played: audio.currentTime, elapsedMs: performance.now() - start, events, link };
    },
    { url: input.data.audioUrl, expected: full.duration }
  );
  assert.ok(longPlayback.elapsedMs <= full.duration * 1000 + fixture.budgetsMs.playbackOverhead);
  const longRequests = longPlayback.events.filter((event) => event.event === 'team:play-request');
  const longOnsets = longPlayback.events.filter((event) => event.event === 'team:playing');
  assert.equal(longRequests.length, 1, 'Long reply needs one playback request');
  assert.equal(longOnsets.length, 1, 'Resume must not duplicate the first playback onset');
  assert.ok(longPlayback.events.filter((event) => event.name === 'playing').length >= 2,
    'The long-reply fixture must exercise its waiting/playing resume cycle');
  for (const event of [...longRequests, ...longOnsets])
    for (const key of ['turnId', 'messageId', 'utteranceIndex'])
      assert.equal(event.info[key], longPlayback.link[key], `Long reply lost ${key}`);
  assert.ok(Number.isFinite(longOnsets[0].info.elapsedMs) && longOnsets[0].info.elapsedMs >= 0);
  assert.ok(longOnsets[0].atMs >= longRequests[0].atMs, 'Playback onset precedes its request');
  playback.push({ name: 'long-reply', ...longPlayback });
  record('long-playback-complete', { phaseDurationMs: longPlayback.elapsedMs });

  // Fallback is a voice-selection test only. Synthetic native voices/utterances are
  // deliberate: browser/phone speechSynthesis audio is not observable in this harness.
  await page.evaluate((f) => {
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    const app = Object.create(ReverieApp.prototype);
    const audio = document.querySelector('audio');
    Object.assign(app, {
      _chatAudio: audio,
      _chatAudioEl: () => audio,
      _chatUrl: (value) => value,
      _chatRoomId: f.room,
      _carScreen: document.querySelector('#car'),
      _carSavedVoice: () => null,
      _carVoiceMember: () => ({ sessionId: f.member }),
    });
    window.nativeSelections = [];
    window.voiceDiagnostics = [];
    const native = {
      speaking: false,
      pending: false,
      cancel() {},
      getVoices: () => [
        { name: 'India default', lang: 'en-IN', default: true },
        { name: 'US default', lang: 'en-US', default: true },
      ],
      speak(u) {
        window.nativeSelections.push({ text: u.text, voice: u.voice.name, language: u.voice.lang });
        queueMicrotask(() => u.onend());
      },
    };
    app._chatApi = async (url, options) => {
      const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.body),
      });
      const body = await response.json();
      return { ok: response.ok, data: body.data };
    };
    window.runBatch = async (text, failure = '') => {
      const link = { turnId: crypto.randomUUID(), messageId: crypto.randomUUID() };
      const start = performance.now(),
        diagnostics = [],
        completed = [];
      const synth = app._carTeamSynth(native, (event, info) =>
        diagnostics.push({ event, info, atMs: performance.now() })
      );
      const fetchAudio = synth.deps.fetchAudio;
      let index = 0;
      synth.deps.fetchAudio = async (...args) => {
        const i = index++;
        const result = await fetchAudio(...args);
        if (i === 1 && failure === 'fetch') return null;
        if (i === 1 && failure === 'voice') return { ...result, voice: { provider: 'kokoro', id: 'af_heart' } };
        return result;
      };
      const pieces = carModeUtterances(text);
      const tasks = pieces.map(
        (text) => new Promise((resolve, reject) => completed.push({
          text, turnId: link.turnId, replyMessageId: link.messageId, onend: resolve, onerror: reject,
        }))
      );
      synth.speakReply(completed);
      await Promise.all(tasks);
      return {
        pieces,
        link,
        diagnostics,
        elapsedMs: performance.now() - start,
        selections: window.nativeSelections.splice(0),
        notice: document.querySelector('.car-voice-notice').textContent,
      };
    };
  }, fixture);
  record('batch-start');
  const healthy = await page.evaluate((text) => window.runBatch(text), fixture.reply);
  assert.ok(healthy.pieces.length > 1, 'Fixture must exercise multiple utterances');
  assert.equal(healthy.selections.length, 0, 'Healthy server audio must not silently use device fallback');
  for (const event of healthy.diagnostics.filter((event) => event.event === 'team:speak'))
    assert.equal(event.info.voice, fixture.voice);
  const synthesis = healthy.diagnostics.filter((event) => event.event === 'team:synthesis').map((event) => event.info);
  const playRequests = healthy.diagnostics.filter((event) => event.event === 'team:play-request');
  const firstOnsets = healthy.diagnostics.filter((event) => event.event === 'team:playing');
  assert.equal(synthesis.length, healthy.pieces.length, 'Every healthy utterance needs scheduling telemetry');
  assert.equal(playRequests.length, healthy.pieces.length, 'Every healthy utterance needs a playback request');
  assert.equal(firstOnsets.length, healthy.pieces.length, 'Every healthy utterance needs exactly one playback onset');
  for (let i = 0; i < synthesis.length; i++) {
    const item = synthesis[i];
    assert.equal(item.status, 'completed');
    for (const entry of [item, playRequests[i].info, firstOnsets[i].info]) {
      assert.equal(entry.turnId, healthy.link.turnId, 'Wrong turn in timing evidence');
      assert.equal(entry.messageId, healthy.link.messageId, 'Wrong reply in timing evidence');
      assert.equal(entry.utteranceIndex, i, 'Wrong utterance in timing evidence');
    }
    assert.ok(Number.isFinite(firstOnsets[i].info.elapsedMs) && firstOnsets[i].info.elapsedMs >= 0);
    assert.ok(firstOnsets[i].atMs >= playRequests[i].atMs, 'Playback onset precedes its request');
    for (const key of ['queueMs', 'requestMs', 'requestStartMs', 'requestEndMs'])
      assert.ok(Number.isFinite(item[key]) && item[key] >= 0, `Missing synthesis ${key}`);
    assert.ok(item.queueMs + item.requestMs <= 25_000, 'Synthesis exceeded its existing client deadline');
    if (i) assert.ok(item.requestStartMs >= synthesis[i - 1].requestEndMs, 'Overlapping synthesis requests');
  }
  playback.push({ name: 'batch', ...healthy });
  record('batch-complete');
  await drainRequests('batch');
  for (const failure of ['voice', 'fetch']) {
    record('fallback-start', { failure });
    const replay = await page.evaluate(({ text, failure }) => window.runBatch(text, failure), {
      text: fixture.reply,
      failure,
    });
    assert.equal(replay.selections.length, replay.pieces.length, 'Fallback must replay the WHOLE reply');
    assert.ok(
      replay.selections.every(
        (u, i) => u.voice === 'US default' && u.language === 'en-US' && u.text === replay.pieces[i]
      )
    );
    assert.match(replay.notice, /Replaying this reply from the start/);
    assert.ok(
      replay.diagnostics.some(
        (event) =>
          event.event === 'team:voice' &&
          event.info.reason === (failure === 'voice' ? 'server-voice-changed' : 'audio-unavailable')
      ),
      'Expected the injected fallback reason'
    );
    playback.push({ name: `fallback-${failure}`, ...replay });
    record('fallback-complete', { failure });
    await drainRequests(`fallback-${failure}`);
  }
  for (const item of timings) {
    assert.ok(Number.isFinite(item.endMs), 'Missing request completion timestamp');
    const budget =
      item.method === 'POST'
        ? item.url.includes('/turn')
          ? fixture.budgetsMs.turn
          : fixture.budgetsMs.speak
        : fixture.budgetsMs.audioFetch;
    assert.ok(item.endMs - item.startMs <= budget, `Request exceeded ${budget}ms: ${item.url}`);
  }
  await Promise.all(captures);
  assert.equal(captureFailures.length, 0, captureFailures.map((error) => error.message).join('\n'));
  assert.ok(clips.length >= 6, 'Missing per-utterance route audio captures');
  assert.equal(phases.filter((phase) => phase.event === 'browser-error').length, 0, 'Unexpected browser page error');
} finally {
  clearTimeout(deadline);
  clearInterval(heartbeat);
  await Promise.all(captures);
  await writeFile(resolve(root, 'clips.json'), JSON.stringify(clips, null, 2));
  await writeFile(resolve(root, 'browser-phases.json'), JSON.stringify(phases, null, 2));
  await writeFile(resolve(root, 'browser-timings.json'), JSON.stringify({ timings, playback }, null, 2));
  await context.tracing.stop({ path: resolve(root, 'trace.zip') });
  await browser.close();
}
