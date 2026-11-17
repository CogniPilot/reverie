/** Docker CI seed command only. Start the ordinary product web command after
 * this exits successfully; this command does not start workers or a server. */
import { constants, promises as fs } from 'node:fs';
import { seedPlanOffice } from '../helpers/plan-office-bootstrap.js';

if (process.argv.length !== 2) throw Error('The plan-office seed command accepts no path or command selectors');
const file = await fs.open(
  '/fixture/plan-office-bootstrap.json',
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
);
let input: unknown;
try {
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 65536
  )
    throw Error('Private bounded synthetic office contract required');
  const buffer = Buffer.alloc(65537),
    result = await file.read(buffer, 0, buffer.length, 0);
  if (result.bytesRead > 65536) throw Error('Synthetic office contract grew beyond its bound');
  input = JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8'));
} finally {
  await file.close();
}
console.log(JSON.stringify(await seedPlanOffice(input)));
