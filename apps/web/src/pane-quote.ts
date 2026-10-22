/**
 * @fileoverview Quoting for text that reaches an agent's pane or terminal from somewhere else (a message body,
 * a name, a goal): it is written as one JSON string, so nothing inside it can close the quote, start a new line or
 * pass itself off as a speaker label. Characters that look like punctuation, are invisible or act as keystrokes
 * (DEL is Backspace in a terminal input box) are shown as `\uXXXX` escapes, astral ones as surrogate pairs. Used by
 * chat delivery, the briefings and `reverie agent chat read`.
 */

/**
 * What is escaped: control and format characters (C0, DEL, C1, zero-width, bidi marks and isolates, soft hyphen, BOM,
 * Unicode tag characters), line and paragraph separators, every space except the plain one, default-ignorable fillers
 * (Hangul, braille blank, CGJ, Mongolian and Khmer vowel separators), variation selectors, and the double-quote
 * lookalikes (curly, low, fullwidth, double prime, CJK). Written with escapes only so no hidden character sits in this file.
 */
const ESCAPED = new RegExp(
  '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\u00a0\\u034f\\u1680\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u2000-\\u200a\\u202f\\u205f\\u2800\\u3000\\u3164\\uffa0' +
    '\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}\\u201c-\\u201f\\uff02\\u2033\\u301d-\\u301f]',
  'u'
);
/** Characters named by code so that no invisible character sits in this file. */
const ZWJ = String.fromCharCode(0x200d);
const VS16 = String.fromCharCode(0xfe0f);
const ELLIPSIS = String.fromCharCode(0x2026);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function escapeChar(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  const u4 = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`;
  if (cp > 0xffff) {
    const v = cp - 0x10000;
    return u4(0xd800 + (v >> 10)) + u4(0xdc00 + (v & 0x3ff));
  }
  return u4(cp);
}

/** `text` as a JSON string, cut to `max` characters (whole code points) with an ellipsis. */
export function quoteForPane(text: unknown, max = 2400): string {
  const chars = Array.from(String(text ?? ''));
  const cut = chars.length > max ? `${chars.slice(0, max).join('')}${ELLIPSIS}` : chars.join('');
  // JSON.stringify escapes quotes, backslashes and C0 controls; everything else is checked here, one code point at a time.
  const out = Array.from(JSON.stringify(cut));
  let result = '';
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (!ESCAPED.test(c)) {
      result += c;
      continue;
    }
    // Keep the joiner and the emoji presentation selector that glue an emoji sequence together (a family, a heart), nothing else.
    const prev = out[i - 1] ?? '';
    const next = out[i + 1] ?? '';
    const glue = (c === ZWJ && PICTOGRAPHIC.test(prev) && PICTOGRAPHIC.test(next)) || (c === VS16 && PICTOGRAPHIC.test(prev));
    result += glue ? c : escapeChar(c);
  }
  return result;
}

/** A fragment cut to `max` characters on whole code points, never inside an escape, with an open quote closed again. */
export function cutQuoted(fragment: string, max: number): string {
  const chars = Array.from(fragment);
  if (chars.length <= max) return fragment;
  let cut = chars.slice(0, max).join('');
  // Drop a half-written escape (`\u20`, a lone backslash) at the end.
  cut = cut.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
  // An odd number of unescaped quotes means the cut is inside a string: close it.
  const quotes = (cut.replace(/\\./g, '').match(/"/g) || []).length;
  return quotes % 2 === 1 ? `${cut}${ELLIPSIS}"` : cut;
}
