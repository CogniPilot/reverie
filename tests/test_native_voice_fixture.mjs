import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const fixture = JSON.parse(await readFile(new URL('../scripts/voice-ci/fixtures.json', import.meta.url)));
const digest = text => createHash('sha256').update(text).digest('hex');
const poll = async (read, child) => {
  for (let i = 0; i < 600; i += 1) {
    assert.equal(child.exitCode, null, 'Speech fixture exited early');
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  assert.fail('Timed out waiting for speech fixture evidence');
};

async function launch(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reverie-native-voice-fixture-'));
  const extra = await overrides.configure?.(root);
  const child = spawn('reverie-voice-ci-serve', ['--artifacts', root], {
    env: { ...process.env, ...extra }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try {
      await closed;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, child, closed };
}

async function records(root, filename) {
  const text = await readFile(join(root, filename), 'utf8');
  return text.split('\n').slice(0, -1).map(line => JSON.parse(line));
}

const synthesize = (url, payload, signal) => fetch(url + '/tts', {
  method: 'POST', body: JSON.stringify(payload), signal,
});

test('real Kokoro and Whisper preserve voice protocols, busy refusal, and timing', { timeout: 90_000 }, async t => {
  const { root, child } = await launch(t);
  const url = await poll(() => readFile(join(root, 'speech-url.txt'), 'utf8').catch(() => ''), child);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.deepEqual(await (await fetch(url + '/health')).json(), { status: 'ok', stt: 'ready', tts: 'ready' });

  const long = synthesize(url, { text: fixture.reply, voice: fixture.voice });
  const started = await poll(async () =>
    (await records(root, 'speech-requests.jsonl')).find(event => event.phase === 'inference-start'), child);
  assert.equal(started.textSha256, digest(fixture.reply));
  assert.equal(started.textCharacters, fixture.reply.length);
  assert.equal(started.text, undefined);
  assert.equal(started.timing.inferenceEndNs, undefined);
  assert.ok(started.timing.acquiredNs <= started.timing.inferenceStartNs);
  assert.deepEqual(await records(root, 'synth-events.jsonl'), []);

  const busy = await synthesize(url, { text: 'A second request.', voice: fixture.voice });
  assert.equal(busy.status, 503);
  assert.match((await busy.json()).error, /busy/);
  const wav = await long;
  assert.equal(wav.status, 200);
  assert.equal(wav.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await wav.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');

  const events = await records(root, 'synth-events.jsonl');
  assert.deepEqual(events.map(event => event.status), ['busy', 'completed']);
  const done = events[1].timing;
  assert.ok(done.lockAttemptNs <= done.acquiredNs && done.acquiredNs <= done.inferenceStartNs);
  assert.ok(done.inferenceStartNs < done.inferenceEndNs && done.inferenceEndNs <= done.finishedNs);
  const requests = await records(root, 'speech-requests.jsonl');
  assert.deepEqual(requests.map(event => event.phase),
    ['synthesis-start', 'inference-start', 'synthesis-start', 'synthesis-raised',
      'inference-end', 'synthesis-return']);
  assert.equal(requests[0].requestId, requests[5].requestId);
  assert.ok(requests[0].processCpuNs <= requests[5].processCpuNs);

  const turn = await synthesize(url, { text: fixture.input });
  assert.equal(turn.status, 200);
  const { audio_url: audioUrl } = await turn.json();
  assert.match(audioUrl, /^\/audio\/[0-9a-f]{32}$/);
  const played = await fetch(url + audioUrl);
  assert.equal(played.headers.get('content-type'), 'audio/wav');
  const asr = await fetch(url + '/stt', { method: 'POST', body: await played.arrayBuffer() });
  assert.equal(asr.status, 200);
  assert.match((await asr.json()).transcript.toLowerCase(), /complete travel checklist/);

  const cancel = new AbortController();
  const aborted = synthesize(url, { text: fixture.reply, voice: fixture.voice }, cancel.signal).catch(error => error);
  const current = await poll(async () =>
    (await records(root, 'speech-requests.jsonl'))
      .find(event => event.phase === 'inference-start' && event.textSha256 === digest(fixture.reply) && event.requestId !== started.requestId), child);
  cancel.abort();
  assert.equal((await aborted).name, 'AbortError');
  await poll(async () => (await records(root, 'speech-requests.jsonl'))
    .find(event => event.requestId === current.requestId && event.phase === 'synthesis-return'), child);
  assert.equal((await records(root, 'speech-requests.jsonl')).filter(event =>
    event.textSha256 === digest(fixture.reply) && event.phase === 'inference-start').length, 2);
});

test('a corrupt Whisper checkpoint cannot publish a ready service', { timeout: 10_000 }, async t => {
  const { root, closed } = await launch(t, { configure: async dir => {
    const path = join(dir, 'corrupt.ggml');
    await writeFile(path, 'not a model');
    return { REVERIE_VOICE_CI_WHISPER_MODEL: path };
  } });
  const [code] = await closed;
  assert.equal(code, 1);
  await assert.rejects(readFile(join(root, 'speech-url.txt')), { code: 'ENOENT' });
});
