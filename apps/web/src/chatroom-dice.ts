/**
 * The `/roll` chat command: the server rolls, so a typed roll is real and nobody can edit the number.
 * `/roll d20`, `/roll 2d6`, `/roll 1d20+3 adv`, `/roll 1d20 dis for picking the lock`.
 * Dice come from the OS cryptographic source (crypto.randomInt).
 */
import { randomInt } from 'node:crypto';

const ROLL_COMMAND = /^\/roll(?:\s+(.*))?$/is;
const SPEC = /^(\d*)d(\d+)([+-]\d+)?$/i;

/** Is this message a `/roll` command? */
export function isRollCommand(text: string): boolean {
  return ROLL_COMMAND.test(text.trim());
}

/** Roll one command; throws an Error with a plain message the user can act on. */
export function rollCommand(text: string, who: string, die: (sides: number) => number = (s) => randomInt(1, s + 1)): string {
  const rest = (ROLL_COMMAND.exec(text.trim())?.[1] ?? '').trim();
  const words = rest.split(/\s+/).filter(Boolean);
  if (/^\d*d\d*[+-]?\d*$/i.test(words[0] ?? '') && !SPEC.test(words[0])) throw new Error('Roll like /roll d20, /roll 2d6 or /roll 1d20+3 adv');
  const spec = SPEC.test((words[0] ?? '').replace(/\s/g, '')) ? words.shift()! : 'd20';
  let adv = false;
  let dis = false;
  while (words[0] && /^(adv|advantage|dis|disadvantage)$/i.test(words[0])) {
    if (/^a/i.test(words.shift()!)) adv = true;
    else dis = true;
  }
  if (words[0]?.toLowerCase() === 'for') words.shift();
  const why = words.join(' ').slice(0, 200);

  const m = SPEC.exec(spec)!;
  const n = Number(m[1] || 1);
  const sides = Number(m[2]);
  const mod = Number(m[3] || 0);
  if (n < 1 || n > 100 || sides < 2 || sides > 1000) throw new Error('Roll between 1 and 100 dice of 2 to 1000 sides');
  if ((adv || dis) && !(n === 1 && sides === 20)) throw new Error('Advantage and disadvantage apply to a single d20');
  if (adv && dis) adv = dis = false; // they cancel, as in the rules

  let rolls: number[];
  let detail: string;
  if (adv || dis) {
    const pair = [die(20), die(20)];
    const kept = adv ? Math.max(...pair) : Math.min(...pair);
    rolls = [kept];
    detail = `${pair[0]}, ${pair[1]} → keep ${kept} (${adv ? 'adv' : 'dis'})`;
  } else {
    rolls = Array.from({ length: n }, () => die(sides));
    detail = rolls.join(' + ');
  }
  if (mod) detail += ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}`;
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const nat = n === 1 && sides === 20 ? (rolls[0] === 20 ? ' ✨ NAT 20' : rolls[0] === 1 ? ' 💀 NAT 1' : '') : '';
  return `🎲 ${who} rolls ${spec}${adv ? ' adv' : ''}${dis ? ' dis' : ''}${why ? ` for ${why}` : ''}: **${total}** (${detail})${nat}`;
}
