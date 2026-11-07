import { fstatSync, readdirSync } from 'node:fs';

const expected = process.argv[2];
const inherited = readdirSync('/proc/self/fd').some((fd) => {
  try {
    const { dev, ino } = fstatSync(Number(fd), { bigint: true });
    return `${dev}:${ino}` === expected;
  } catch {
    return false;
  }
});
console.log(inherited);
