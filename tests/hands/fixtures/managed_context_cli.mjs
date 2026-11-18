import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, scope, command, ...args] = process.argv.slice(2);
const event = value => appendFileSync(join(directory, 'context-events.jsonl'), JSON.stringify(value) + '\n');
if (scope !== 'agent') process.exit(2);
const fixture = JSON.parse(readFileSync(join(directory, 'context-response.json'), 'utf8'));
if (command === 'context' && JSON.stringify(args) === '["--json"]') {
  event(['fetch']);
  if (fixture.holdFetchMs) await new Promise(resolve => setTimeout(resolve, fixture.holdFetchMs));
  if (!fixture.response) process.exit(1);
  console.log(JSON.stringify(fixture.response));
} else if (command === 'receipt' && args.length === 5 && args[0] === '--digest' &&
    args[2] === '--stage' && args[4] === '--json') {
  event(['receipt', args[1], args[3]]);
  if (fixture.refuseReceipt) process.exit(1);
  console.log('{}');
} else {
  process.exit(2);
}
