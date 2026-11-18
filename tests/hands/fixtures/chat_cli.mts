import { appendFileSync, readFileSync } from 'node:fs';

const [settings, ...args] = process.argv.slice(2);
const { stdout, status, calls } = JSON.parse(readFileSync(settings, 'utf8')) as {
  stdout: string;
  status: number;
  calls: string;
};
appendFileSync(calls, JSON.stringify(args) + '\n');
process.stdout.write(stdout);
process.exitCode = status;
