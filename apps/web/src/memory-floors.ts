/**
 * @fileoverview The hard floors a memory save must pass before it reaches the office journal: the in-process successor of
 * the python `floors.violates` check that `memory_remember` used to spawn through `reverie.memory_cli`.
 *
 * The patterns keep Python's `re` semantics for str: `\w` is any letter, number or underscore, `\d` any decimal digit,
 * `\s` the characters `str.isspace` accepts, `\b` a boundary between those word characters and anything else, and the
 * case-insensitive abuse terms also match the characters Python folds onto ASCII letters (İ and ı for i, ſ for s, the
 * Kelvin sign for k). JavaScript's own classes are ASCII-only or slightly different, so each is spelled out here.
 *
 * The configured output-policy floor never ran on this path: the bridge received only PATH, HOME, PYTHONPATH and three
 * REVERIE_* settings, so REVERIE_OUTPUT_POLICY always read as empty. It stays inert here rather than becoming a new check.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Every character python's `str.isspace` accepts. */
const PY_SPACE_CLASS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const S = `[${PY_SPACE_CLASS}]`;
const W = '[\\p{L}\\p{N}_]';
const D = '\\p{Nd}';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const PY_SPACE = new RegExp(`^${S}$`, 'u');
/** Python's `str.splitlines` boundaries; `\r\n` counts once. */
// eslint-disable-next-line no-control-regex -- the file, group and record separators are line breaks to python.
const PY_LINE_BREAK = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/u;

/** One ASCII letter as python's case-insensitive match sees it, including the non-ASCII characters that fold onto it. */
function folded(letter: string): string {
  const extra: Record<string, string> = { i: '\u0130\u0131', s: '\u017f', k: '\u212a' };
  return `[${letter.toLowerCase()}${letter.toUpperCase()}${extra[letter.toLowerCase()] ?? ''}]`;
}
const ignoreCase = (word: string): string => word.replace(/[a-z]/gi, folded);

const ABUSE_TERMS = [
  'harass\\w*',
  'stalk\\w*',
  'dox+\\w*',
  'expose\\w*',
  'threat\\w*',
  'address',
  'phone',
  'lives at',
  'works at',
];
const ABUSE = new RegExp(
  `${B}(?:${ABUSE_TERMS.map((term) => ignoreCase(term.replace('\\w', '\u0000')).replace('\u0000', W)).join('|')})${B}`,
  'u'
);
const STREET = '(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct)';
const CONTACT = new RegExp(
  `(?:\\+?${D}(?:${D}|${S}|[().-]){7,}${D})` +
    `|(?:${B}${D}{1,5}${S}+[A-Z][a-z]+(?:${S}+[A-Z][a-z]+)*${S}+${STREET}${B})` +
    `|(?:(?:${W}|[.+-])+@(?:${W}|-)+\\.(?:${W}|[.-])+)`,
  'gu'
);
const NAME = new RegExp(`${B}[A-Z][a-z]+${S}+[A-Z][a-z]+${B}`, 'u');
const OCTET = `(?:25[0-5]|2[0-4]${D}|1${D}${D}|[1-9]?${D})`;
const NOT_PHONE = new RegExp(
  `^(?:${OCTET}(?:\\.${OCTET}){3}(?:/${D}{1,2}|:${D}{1,5})?` +
    `|${OCTET}(?:\\.${OCTET}){1,2}(?:\\.[xX*]){1,2}` +
    `|[vV]${D}+(?:\\.${D}+){1,3}` +
    `|${D}{4}-${D}{2}-${D}{2})$`,
  'u'
);
const SENTENCE = new RegExp(`(?<=[.!?])${S}+`, 'u');
const TOKEN_EDGE = new Set(',;()[]<>"\'`*_');

/** Python's `str.strip()` with no argument. */
export function pyStrip(text: string): string {
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && PY_SPACE.test(chars[start])) start++;
  while (end > start && PY_SPACE.test(chars[end - 1])) end--;
  return chars.slice(start, end).join('');
}

/** The whole whitespace-delimited token around a phone-pattern match, without edge punctuation. */
function contactToken(sentence: string, start: number, end: number): string {
  const space = (index: number) => PY_SPACE.test(String.fromCodePoint(sentence.codePointAt(index)!));
  while (start > 0 && !space(start - 1)) start--;
  while (end < sentence.length && !space(end)) end++;
  let token = sentence.slice(start, end);
  let a = 0;
  let z = token.length;
  while (a < z && TOKEN_EDGE.has(token[a])) a++;
  while (z > a && TOKEN_EDGE.has(token[z - 1])) z--;
  token = token.slice(a, z);
  while (token.endsWith('.') || token.endsWith(':')) token = token.slice(0, -1);
  return token;
}

/** True when a protected name is paired with abuse or exposure, or a name is paired with contact details. */
export function targetsPrivatePerson(text: string, names: readonly string[]): boolean {
  for (const sentence of text.split(SENTENCE)) {
    const low = sentence.toLowerCase();
    if (names.some((name) => low.includes(name.toLowerCase())) && ABUSE.test(sentence)) return true;
    if (NAME.test(sentence)) {
      for (const match of sentence.matchAll(CONTACT)) {
        if (!NOT_PHONE.test(contactToken(sentence, match.index, match.index + match[0].length))) return true;
      }
    }
  }
  return false;
}

/** The name of the floor crossed, or an empty string when the text passes. */
export function violates(text: string, names: readonly string[]): string {
  return targetsPrivatePerson(text, names) ? 'targeting a real private person' : '';
}

/** The protected-people list the bridge read: `<home>/reverie/companies/default/data/protected-people.txt`. */
export function protectedPeoplePath(home: string): string {
  return path.join(home, 'reverie', 'companies', 'default', 'data', 'protected-people.txt');
}

export const PROTECTED_PEOPLE_MAX_BYTES = 1024 * 1024;

/**
 * The protected names, parsed as python did: UTF-8 (invalid bytes refuse), one name per line, blank lines and lines
 * starting with '#' skipped. A missing or non-regular file holds no names. A file over the size bound refuses.
 */
export function readProtectedNames(file: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    if (stat.size > PROTECTED_PEOPLE_MAX_BYTES) throw new Error('the protected-people list is too large to check');
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, read));
    return text
      .replace(/\r\n?/g, '\n')
      .split(PY_LINE_BREAK)
      .filter((line) => !line.startsWith('#'))
      .map(pyStrip)
      .filter((line) => line !== '');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Screen one memory text: '' when it passes, else the floor crossed. Throws when the check cannot run (text missing or
 * blank, names unreadable), which the caller treats as "did not run" and refuses the save.
 */
export function screenMemoryText(text: unknown, home: string): string {
  if (typeof text !== 'string' || !pyStrip(text)) throw new Error('screen needs text');
  return violates(text, readProtectedNames(protectedPeoplePath(home)));
}
