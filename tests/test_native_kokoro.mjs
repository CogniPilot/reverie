import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const MODEL = 'kokoro-v1.0.onnx';
const VOICES = 'voices-v1.0.bin';

async function fixture(t, corrupt = false) {
  const root = await mkdtemp(join(tmpdir(), 'reverie-native-kokoro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.ok(process.env.REVERIE_VOICE_CI_KOKORO_MODEL, 'Use the pinned voice CI environment');
  assert.ok(process.env.REVERIE_VOICE_CI_KOKORO_VOICES, 'Use the pinned voice CI environment');
  if (corrupt) {
    await writeFile(join(root, MODEL), 'invalid cache');
  } else {
    await symlink(process.env.REVERIE_VOICE_CI_KOKORO_MODEL, join(root, MODEL));
  }
  await symlink(process.env.REVERIE_VOICE_CI_KOKORO_VOICES, join(root, VOICES));

  const child = spawn('reverie-kokoro', ['--models', root, '--port', '0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const events = createInterface({ input: child.stderr });
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const first = await Promise.race([
    once(events, 'line').then(([line]) => line),
    exited.then(() => { throw new Error('Kokoro exited before listening'); }),
    sleep(5000, '', { ref: false }),
  ]);
  const url = /^Listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(first)?.[1];
  assert.ok(url, first);
  return url;
}

async function health(url, expected) {
  for (let i = 0; i < 300; i += 1) {
    const response = await fetch(url + '/health');
    const { status } = await response.json();
    if (status === 'loading') {
      await sleep(150);
      continue;
    }
    assert.equal(status, expected);
    assert.equal(response.status, expected === 'ready' ? 200 : 503);
    return;
  }
  assert.fail('Kokoro model initialization exceeded its test timeout');
}

const speak = (url, payload) => fetch(url + '/tts', {
  method: 'POST',
  body: JSON.stringify(payload),
});

test('the packaged Kokoro API opens the existing model cache and synthesizes speech', { timeout: 90_000 }, async t => {
  const url = await fixture(t);
  await health(url, 'ready');
  const response = await fetch(url + '/voices');
  assert.equal(response.status, 200);
  const { voices } = await response.json();
  assert.equal(voices.length, 54);
  assert.deepEqual(voices.find(({ id }) => id === 'ff_siwis'),
    { id: 'ff_siwis', label: 'Siwis', language: 'fr-fr', gender: 'feminine' });
  assert.equal((await speak(url, { text: ' ' })).status, 400);
  assert.equal((await speak(url, { text: 'hello', voice: 'unknown' })).status, 400);
  assert.equal((await speak(url, ['not an object'])).status, 400);
  assert.equal((await speak(url, { text: 'x'.repeat(8192) })).status, 413);

  const spoken = await speak(url, { text: 'Please, meet me at ten.', voice: 'am_michael' });
  assert.equal(spoken.status, 200, spoken.statusText);
  assert.equal(spoken.headers.get('content-type'), 'audio/wav');
  const wav = Buffer.from(await spoken.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.ok(wav.length > 44 + 48_000);
  assert.ok(wav.subarray(44).some(value => value !== 0));

  for (const [voice, text] of [
    ['bf_emma', 'Please meet me at ten.'],
    ['ff_siwis', 'Bonjour, je suis ici.'],
    ['zf_xiaobei', '你好，今天好吗？'],
  ]) {
    const localized = await speak(url, { voice, text });
    assert.equal(localized.status, 200, voice);
    assert.equal(localized.headers.get('content-type'), 'audio/wav');
    assert.ok((await localized.arrayBuffer()).byteLength > 44);
  }
});

test('the packaged service refuses a corrupt cache without downloading over it', { timeout: 20_000 }, async t => {
  const url = await fixture(t, true);
  await health(url, 'error');
  const voices = await fetch(url + '/voices');
  assert.equal(voices.status, 503);
  assert.deepEqual(await voices.json(), { voices: [] });
  assert.equal((await speak(url, { text: 'Unavailable' })).status, 503);
});
