/** Offline highlighting for labelled code; original source remains the Copy payload. */
(function (root) {
  'use strict';
  function highlight(code, language, doc = root.document) {
    const node = doc.createElement('code');
    node.textContent = code;
    const name = String(language || '').toLowerCase();
    if (
      code.length > 50000 ||
      !/^[a-z0-9_+-]{1,32}$/.test(name) ||
      !root.hljs?.getLanguage(name) ||
      !root.sanitizeMarkdownHtml
    )
      return node;
    try {
      node.innerHTML = root.sanitizeMarkdownHtml(
        root.hljs.highlight(code, { language: name, ignoreIllegals: true }).value
      );
      // A display transform must never silently change the snippet or its language-service input.
      if (node.textContent !== code) node.textContent = code;
      else node.classList.add('hljs');
    } catch {
      node.textContent = code;
    }
    return node;
  }
  root.ReverieChatCode = { highlight };
})(globalThis);
