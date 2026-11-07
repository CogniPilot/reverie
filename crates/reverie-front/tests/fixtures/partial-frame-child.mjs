import { writeSync } from 'node:fs';
writeSync(3, Buffer.from([0, 0, 0, 18, 2]));
if (process.argv[2] === 'signal') process.kill(process.pid, 'SIGKILL');
else process.exit(process.argv[2] === 'success' ? 0 : 17);
