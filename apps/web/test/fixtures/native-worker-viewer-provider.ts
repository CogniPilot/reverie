/** Deterministic provider driven through a real terminal in the viewer acceptance test. */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2]!;
const input = process.stdin;
input.setRawMode(true);
input.setEncoding('utf8');

let text = '';
let escape = '';
let sequence = 0;
let state: 'working' | 'unready' | 'idle' = 'working';

function paint(): void {
  const screen =
    state === 'idle'
      ? `› ${text}\r\nGPT-6.1-Sol high · /fixture\r\n? for shortcuts`
      : state === 'unready'
        ? 'Connecting…'
        : '• Working (esc to interrupt)';
  process.stdout.write('\x1b[2J\x1b[H' + screen);
}

function submit(): void {
  const receipt = {
    seq: ++sequence,
    pid: process.pid,
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
  const output = openSync(join(root, 'provider-input.jsonl'), 'a', 0o600);
  try {
    appendFileSync(output, JSON.stringify(receipt) + '\n');
    fsyncSync(output);
  } finally {
    closeSync(output);
  }
  text = '';
  state = 'idle';
  paint();
}

function handleCharacter(character: string): void {
  if (escape) {
    escape += character;
    if (escape === '\x1b[200~' || escape === '\x1b[201~' || escape.length > 8) escape = '';
  } else if (character === '\x1b') {
    escape = character;
  } else if (character === '\r' || character === '\n') {
    submit();
  } else if (character === '\x7f' || character === '\b') {
    text = [...text].slice(0, -1).join('');
    paint();
  } else if (character >= ' ') {
    text += character;
    paint();
  }
}

paint();
const controls = setInterval(() => {
  if (state === 'idle') return;
  if (existsSync(join(root, 'idle-control'))) {
    state = 'idle';
    paint();
  } else if (state === 'working' && existsSync(join(root, 'unready-control'))) {
    state = 'unready';
    paint();
  }
}, 40);
input.on('data', (bytes: string) => {
  for (const character of bytes) handleCharacter(character);
});
input.once('end', () => clearInterval(controls));
