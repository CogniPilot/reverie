/** Sanitizer policy restricted to generated math markup. */
(function (root) {
  'use strict';
  function createChatMathSanitizer(DOMPurify) {
    var CONFIG = {
      ALLOWED_TAGS: ['span', 'svg', 'path', 'line'],
      ALLOWED_ATTR: [
        'class',
        'style',
        'aria-hidden',
        'xmlns',
        'width',
        'height',
        'viewBox',
        'preserveAspectRatio',
        'd',
        'x1',
        'x2',
        'y1',
        'y2',
        'stroke-width',
      ],
      FORBID_TAGS: [
        'script',
        'style',
        'math',
        'foreignObject',
        'a',
        'image',
        'img',
        'use',
        'animate',
        'set',
        'iframe',
        'object',
        'embed',
        'form',
      ],
      FORBID_ATTR: ['href', 'xlink:href', 'src', 'id', 'name'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    };
    var NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|%)?$/;
    var LAYOUT = new Set([
      'height',
      'width',
      'min-height',
      'max-height',
      'min-width',
      'max-width',
      'top',
      'bottom',
      'left',
      'right',
      'margin-left',
      'margin-right',
      'margin-top',
      'margin-bottom',
      'padding-left',
      'padding-right',
      'padding-top',
      'padding-bottom',
      'vertical-align',
      'font-size',
      'border-width',
      'border-bottom-width',
      'border-top-width',
      'border-left-width',
      'border-right-width',
    ]);
    var COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\))$/i;
    return function sanitizeChatMathHtml(html) {
      var fragment = DOMPurify.sanitize(String(html), CONFIG);
      for (var node of fragment.querySelectorAll('*')) {
        // DOMPurify cleans namespace transitions first; then only remove/narrow surviving attributes.
        if (node.hasAttribute('style')) {
          var safe = [];
          for (var property of Array.from(node.style)) {
            var value = node.style.getPropertyValue(property).trim();
            if (LAYOUT.has(property) && NUMBER.test(value) && Math.abs(parseFloat(value)) <= 10000)
              safe.push([property, value]);
            else if (
              (property === 'margin' || property === 'padding') &&
              value.split(/\s+/).length <= 4 &&
              value.split(/\s+/).every((v) => NUMBER.test(v) && Math.abs(parseFloat(v)) <= 10000)
            )
              safe.push([property, value]);
            else if (['color', 'background-color', 'border-color'].includes(property) && COLOR.test(value))
              safe.push([property, value]);
            else if (/^border(?:-(?:left|right|top|bottom))?-style$/.test(property) && value === 'solid')
              safe.push([property, value]);
          }
          node.removeAttribute('style');
          for (var pair of safe) node.style.setProperty(pair[0], pair[1]);
        }
        for (var attribute of Array.from(node.attributes)) {
          var key = attribute.name.toLowerCase(),
            value = attribute.value;
          if (key === 'xmlns' && value !== 'http://www.w3.org/2000/svg') node.removeAttribute(attribute.name);
          else if (['width', 'height', 'x1', 'x2', 'y1', 'y2', 'stroke-width'].includes(key) && !NUMBER.test(value))
            node.removeAttribute(attribute.name);
          else if (key === 'viewbox' && !/^[\d.eE+\-\s]+$/.test(value)) node.removeAttribute(attribute.name);
          else if (key === 'd' && !/^[MmLlHhVvCcSsQqTtAaZz\d.eE,+\-\s]+$/.test(value))
            node.removeAttribute(attribute.name);
          else if (key === 'aria-hidden' && value !== 'true' && value !== 'false') node.removeAttribute(attribute.name);
        }
      }
      return fragment;
    };
  }

  root.createChatMathSanitizer = createChatMathSanitizer;
  if (root.DOMPurify) root.sanitizeChatMathHtml = createChatMathSanitizer(root.DOMPurify);
})(globalThis);
