/** Bounded math parser/renderer. Offline, display-only. */
(function (root) {
  'use strict';
  const MAX_MATH = 4096,
    MAX_EXPAND = 1000;
  const escaped = (text, at) => {
    let slashes = 0;
    while (at > 0 && text[--at] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  function mathSegments(value, protectedRanges = []) {
    const text = String(value ?? ''),
      out = [];
    let plain = 0,
      count = 0,
      attempts = 0,
      protectedAt = 0;
    for (let i = 0; i < text.length && count < 32 && attempts < 128; i++) {
      while (protectedAt < protectedRanges.length && protectedRanges[protectedAt][1] <= i) protectedAt++;
      if (protectedRanges[protectedAt]?.[0] <= i) {
        i = protectedRanges[protectedAt][1] - 1;
        continue;
      }
      if (text[i] === '`') {
        const end = text.indexOf('`', i + 1),
          line = text.indexOf('\n', i + 1);
        if (end > i + 1 && (line < 0 || end < line)) {
          i = end;
          continue;
        }
      }
      if (text[i] !== '$' || escaped(text, i)) continue;
      attempts++;
      const display = text[i + 1] === '$',
        width = display ? 2 : 1,
        start = i + width;
      if (!display && (!text[start] || /\s|\$/.test(text[start]))) continue;
      let end = start;
      for (; end < text.length && end - start <= MAX_MATH; end++) {
        if (!display && text[end] === '\n') break;
        if (text[end] !== '$' || escaped(text, end)) continue;
        if (
          display
            ? text[end + 1] !== '$'
            : text[end + 1] === '$' || /\d/.test(text[end + 1] || '') || /\s/.test(text[end - 1] || '')
        )
          continue;
        break;
      }
      if (
        end === start ||
        end >= text.length ||
        end - start > MAX_MATH ||
        text[end] !== '$' ||
        (display && text[end + 1] !== '$')
      )
        continue;
      if (i > plain) out.push({ text: text.slice(plain, i) });
      out.push({ math: text.slice(start, end), display, raw: text.slice(i, end + width) });
      count++;
      i = end + width - 1;
      plain = i + 1;
    }
    if (plain < text.length) out.push({ text: text.slice(plain) });
    return out;
  }
  function mathNode(part, doc = root.document) {
    const span = doc.createElement('span');
    span.className = `chatroom-math is-math-source${part.display ? ' chatroom-math--display' : ''}`;
    span.textContent = part.raw;
    // Even aliases/macros cannot produce links/resources: trust is false and the output policy has no URL attributes.
    if (!root.katex || !root.sanitizeChatMathHtml || /\\(?:href|url|includegraphics)\b/.test(part.math)) return span;
    try {
      const html = root.katex.renderToString(part.math, {
        displayMode: !!part.display,
        output: 'html',
        trust: false,
        strict: 'error',
        throwOnError: true,
        maxExpand: MAX_EXPAND,
        maxSize: 10,
        macros: {},
        globalGroup: false,
      });
      span.replaceChildren(root.sanitizeChatMathHtml(html));
      span.classList.remove('is-math-source');
      span.setAttribute('role', 'img');
      span.setAttribute('aria-label', part.math);
    } catch {
      // Error strings may contain unescaped source. Keep the exact source as text, never as error HTML.
      span.textContent = part.raw;
    }
    return span;
  }
  root.ReverieChatMath = { mathSegments, mathNode };
})(typeof globalThis !== 'undefined' ? globalThis : window);
