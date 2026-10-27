# Optional chat math

Open **Chat plugins** and enable **LaTeX math** on this device. It is disabled
initially. Enabling loads the bundled KaTeX renderer from Reverie; no CDN,
external service or TeX process is used.

Write `$x^2$` for inline math or `$$…$$` for display math. **Inline math** and
**Display math** wrap selected composer text, or insert an editable `x`.
**Preview math** shows the result; **Edit source** returns to the same textarea.
Sending always uses the original textarea value, including its delimiters.

Messages with math have **Show source** / **Show rendered** controls. The source
view keeps the exact original message, including markdown. **Use in composer**
adds that source after any existing draft so you can discuss or change it without
changing the received message. Your own message's normal Edit action also has
the source/preview controls.

Fenced code and inline code stay literal. Invalid formulas, unsupported commands,
URLs, images and oversized formulas remain visible as source. KaTeX supports
mathematical LaTeX; this is not a full document or PDF editor. Math uses dollar
delimiters, with at most 32 formulas and 4,096 characters per formula in a text run.
Disabling the plugin restores ordinary chat and keeps unsent text unchanged.

The parser, renderer safety settings and generated HTML sanitizer reuse Mira's
reviewed `chat-rendering-final-operator-composition-r1` packet. This plugin adds
an opt-in lifecycle and source/edit/preview controls without enabling that packet's
unrelated formatting changes. Renderer settings follow the primary
[KaTeX options](https://katex.org/docs/options.html) and
[security guidance](https://katex.org/docs/security.html): untrusted commands,
bounded expansion and sizes, fresh macro state and a dedicated DOMPurify policy.
