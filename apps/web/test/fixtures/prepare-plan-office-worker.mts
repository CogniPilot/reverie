/** Baked CI-only metadata preparer. No arbitrary path, model, Engine or account material. */
import fs from 'node:fs';
import process from 'node:process';
import { preparePlanOfficeWorkerHome } from '../helpers/boxed-plan-provider-files.js';
if (process.argv.length !== 2 || process.env.HOME !== '/home/agent' || !process.getuid?.())
  throw Error('Fixed positive-UID CI worker required');
fs.accessSync('/.dockerenv');
const timeout = setTimeout(() => {
  process.stdin.destroy(Error('Synthetic HOME input deadline'));
}, 2000);
const chunks: Buffer[] = [];
let total = 0;
try {
  for await (const part of process.stdin) {
    const bytes = Buffer.from(part);
    total += bytes.length;
    if (total > 65536) throw Error('Synthetic HOME input bound');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks),
    text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw Error('Synthetic HOME UTF8 refused');
  const report = preparePlanOfficeWorkerHome('/home/agent', JSON.parse(text));
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  clearTimeout(timeout);
}
