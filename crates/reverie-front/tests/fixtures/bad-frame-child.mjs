import { writeSync } from 'node:fs';
writeSync(3, Buffer.from([255, 255, 255, 255]));
process.exit(0);
