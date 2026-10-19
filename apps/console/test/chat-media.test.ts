/**
 * Chat media pure helpers: shortcode matching (emotes first), inline emote tokens, and
 * the spoken phrase for attachments.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const context = vm.createContext({ CodemanApp: class {}, URL });
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-media.js'), 'utf8'), context);
const get = (n: string) => vm.runInContext(n, context);
const matches = get('chatEmojiMatches') as (
  q: string,
  emotes?: Array<{ name: string }>,
  limit?: number
) => Array<{ code: string; ch?: string; emote?: string }>;
const segments = get('chatTextSegments') as (t: string, names: Set<string>) => Array<{ text?: string; emote?: string }>;
const links = get('chatLinkSegments') as (t: string) => Array<{ text: string; href?: string }>;
const plainLinks = (t: string) => JSON.parse(JSON.stringify(links(t)));
const phrase = get('chatAttachmentPhrase') as (a: Array<{ type: string }>) => string;

describe('chatEmojiMatches', () => {
  it('ranks prefix matches before contains, and includes custom emotes', () => {
    const r = matches('thu');
    expect(r[0]).toMatchObject({ code: 'thumbsup', ch: '\u{1F44D}' });
    expect(matches('parr', [{ name: 'party_parrot' }]).map((m) => m.code)).toEqual(['parrot', 'party_parrot']);
    expect(matches('zzzz')).toEqual([]);
  });
});

describe('chatTextSegments', () => {
  it('turns only known :emotes: into emote tokens', () => {
    expect(JSON.parse(JSON.stringify(segments('hi :wave: and :party_parrot: ok', new Set(['party_parrot']))))).toEqual([
      { text: 'hi :wave: and ' },
      { emote: 'party_parrot' },
      { text: ' ok' },
    ]);
    expect(JSON.parse(JSON.stringify(segments('plain', new Set())))).toEqual([{ text: 'plain' }]);
  });
});

describe('chatAttachmentPhrase', () => {
  it('describes what was attached for read-aloud and car mode', () => {
    expect(phrase([{ type: 'image/png' }])).toBe('sent an image');
    expect(phrase([{ type: 'image/png' }, { type: 'image/jpeg' }, { type: 'text/plain' }])).toBe(
      'sent 2 images and a file'
    );
    expect(phrase([])).toBe('');
  });
});

describe('chatLinkSegments', () => {
  it('links http and https addresses and keeps the words around them', () => {
    expect(plainLinks('see https://example.com/a?b=1#c now')).toEqual([
      { text: 'see ' },
      { href: 'https://example.com/a?b=1#c', text: 'https://example.com/a?b=1#c' },
      { text: ' now' },
    ]);
    expect(plainLinks('http://localhost:3000/x')).toEqual([{ href: 'http://localhost:3000/x', text: 'http://localhost:3000/x' }]);
    expect(plainLinks('no links here, www.example.com or ftp://x.y')).toEqual([{ text: 'no links here, www.example.com or ftp://x.y' }]);
  });

  it('leaves trailing punctuation and an unmatched closing bracket outside the link', () => {
    expect(plainLinks('(see https://example.com/a).')).toEqual([
      { text: '(see ' },
      { href: 'https://example.com/a', text: 'https://example.com/a' },
      { text: ').' },
    ]);
    expect(plainLinks('https://example.com/wiki/Foo_(bar), ok')).toEqual([
      { href: 'https://example.com/wiki/Foo_(bar)', text: 'https://example.com/wiki/Foo_(bar)' },
      { text: ', ok' },
    ]);
    expect(plainLinks('Is it https://example.com?!')).toEqual([
      { text: 'Is it ' },
      { href: 'https://example.com/', text: 'https://example.com' },
      { text: '?!' },
    ]);
  });

  it('never links other schemes, an address with a password, or a hostless one', () => {
    for (const t of ['javascript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'https://user:pw@example.com/', 'https://bank.example@evil.example/', 'https://']) {
      expect(plainLinks(t).some((p: { href?: string }) => p.href)).toBe(false);
    }
    // a scheme-looking word inside another word is not a link start
    expect(plainLinks('xhttps://example.com').some((p: { href?: string }) => p.href)).toBe(false);
  });

  it('ends a link at an invisible or direction-changing character', () => {
    expect(plainLinks('https://a.io/x\u202egpj.exe')).toEqual([
      { href: 'https://a.io/x', text: 'https://a.io/x' },
      { text: '\u202egpj.exe' },
    ]);
    expect(plainLinks('https://a.io\u200b.evil.io')[0]).toEqual({ href: 'https://a.io/', text: 'https://a.io' });
  });

  it('does not link a host whose opened address could differ from its text: lookalike slashes and letters, punycode, number hosts', () => {
    const none = (t: string) => plainLinks(t).every((p: { href?: string }) => !p.href);
    expect(none('http://good.com∕evil.example/x')).toBe(true); // division slash
    expect(none('http://good.com⁄evil.example/x')).toBe(true); // fraction slash
    expect(none('http://pаypal.com/')).toBe(true); // Cyrillic a
    expect(none('http://xn--pypal-4ve.com/')).toBe(true);
    expect(none('http://example.сom/')).toBe(true);
    for (const t of ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://127.1/', 'http://0x7f000001/']) expect(none(t), t).toBe(true);
    // an ordinary address written as it opens still links, with upper case, a port, a trailing dot, an IPv6 literal, and non-ASCII in the path
    for (const t of ['http://127.0.0.1:8080/a', 'HTTPS://Example.COM/Path', 'http://example.com./x', 'http://[::1]:3000/p', 'https://example.com/café']) {
      expect(plainLinks(t).some((p: { href?: string }) => p.href), t).toBe(true);
    }
  });

  it('keeps curly quotes, an ellipsis and CJK full stops outside the link', () => {
    for (const end of ['’', '”', '…', '。', '，', '！', '»']) {
      const link = plainLinks(`see https://example.com/a${end}`).find((p: { href?: string }) => p.href);
      expect(link?.text, end).toBe('https://example.com/a');
      expect(link?.href, end).toBe('https://example.com/a');
    }
  });

  it('ends a link at every invisible or filler character the pane quoting escapes', () => {
    for (const ch of ['؜', '͏', '᠋', '️', '\u{e0041}', '⠀', 'ㅤ', 'ᅟ', 'ᅠ', '­', '‍']) {
      const parts = plainLinks(`https://example.com/a${ch}b`);
      expect(parts[0], JSON.stringify(ch)).toEqual({ href: 'https://example.com/a', text: 'https://example.com/a' });
      expect(parts.map((p: { text: string }) => p.text).join('')).toBe(`https://example.com/a${ch}b`);
    }
  });

  it('is linear: a very long run of closing brackets or many links cannot freeze the page', () => {
    const t0 = Date.now();
    const big = `https://example.com/x${')'.repeat(7900)}`;
    expect(plainLinks(big).every((p: { href?: string }) => !p.href || p.text.length <= 2000)).toBe(true);
    plainLinks(`https://example.com/x${')'.repeat(1900)}`);
    plainLinks(`(${'https://example.com/x('.repeat(100)}`);
    const many = plainLinks(Array(1500).fill('http://a.io').join(' '));
    expect(many.filter((p: { href?: string }) => p.href).length).toBe(50);
    expect(many.map((p: { text: string }) => p.text).join('')).toBe(Array(1500).fill('http://a.io').join(' '));
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('keeps every character: the pieces joined are the original text', () => {
    for (const t of ['a https://x.io/y, b (https://z.io) c.', 'https://a.io https://b.io', '"https://a.io"', 'https://a.io/\u200b\u202e', '']) {
      expect(plainLinks(t).map((p: { text: string }) => p.text).join('')).toBe(t);
    }
  });
});

const codeSegs = get('chatCodeSegments') as (t: string) => Array<{ text?: string; code?: string }>;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('chatCodeSegments', () => {
  it('splits fenced blocks from the text around them and drops the language line', () => {
    expect(plain(codeSegs('run this:\n```sh\nsudo nixos-rebuild build\n```\nthen tell me'))).toEqual([
      { text: 'run this:\n' },
      { code: 'sudo nixos-rebuild build' },
      { text: '\nthen tell me' },
    ]);
  });
  it('keeps plain text whole, and an unclosed fence stays text', () => {
    expect(plain(codeSegs('no code here'))).toEqual([{ text: 'no code here' }]);
    expect(plain(codeSegs('oops ``` never closed'))).toEqual([{ text: 'oops ``` never closed' }]);
  });
  it('finds several blocks', () => {
    expect(plain(codeSegs('```\na\n``` and ```\nb\n```')).filter((x: { code?: string }) => x.code !== undefined)).toEqual([{ code: 'a' }, { code: 'b' }]);
  });
});

const inlineSegs = get('chatInlineCodeSegments') as (t: string) => Array<{ text?: string; inline?: string }>;

describe('chatInlineCodeSegments', () => {
  it('splits `spans` from the text around them', () => {
    expect(plain(inlineSegs('run `npm test` now'))).toEqual([{ text: 'run ' }, { inline: 'npm test' }, { text: ' now' }]);
  });
  it('leaves an unclosed backtick and plain text whole', () => {
    expect(plain(inlineSegs('a ` b'))).toEqual([{ text: 'a ` b' }]);
    expect(plain(inlineSegs('plain'))).toEqual([{ text: 'plain' }]);
  });
});

const boldSegs = get('chatBoldSegments') as (t: string) => Array<{ text?: string; bold?: string }>;

describe('chatBoldSegments', () => {
  it('splits **bold** spans from the text around them', () => {
    expect(plain(boldSegs('a **big** win and **two words**'))).toEqual([
      { text: 'a ' },
      { bold: 'big' },
      { text: ' win and ' },
      { bold: 'two words' },
    ]);
  });
  it('leaves stray, spaced, empty and multi-line asterisks as text', () => {
    for (const t of ['a ** b', '2 ** 3 ** 4', '****', '** x**', '**x **', '**a\nb**', 'plain', '*one*']) {
      expect(plain(boldSegs(t))).toEqual([{ text: t }]);
    }
  });
  it('keeps a link inside bold whole (the closing ** is not part of the link)', () => {
    expect(plain(boldSegs('**see https://example.com/x**'))).toEqual([{ bold: 'see https://example.com/x' }]);
    expect(plain(links('see https://example.com/x'))).toEqual([{ text: 'see ' }, { text: 'https://example.com/x', href: 'https://example.com/x' }]);
  });
});
