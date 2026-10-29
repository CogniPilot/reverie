/** A small, case-sensitive Modelica grammar: display only, no parser or evaluator. */
(function (root) {
  function modelica(hljs) {
    return {
      name: 'Modelica',
      aliases: ['mo'],
      keywords: {
        keyword:
          'algorithm and annotation assert block break class connect connector constant constrainedby der discrete each else elseif elsewhen encapsulated end enumeration equation expandable extends external final flow for function if import impure in initial inner input loop model not operator or outer output package parameter partial protected public pure record redeclare replaceable return stream then type when while within',
        type: 'Real Integer Boolean String',
        literal: 'true false',
        built_in:
          'time abs sign sqrt min max div mod rem ceil floor integer sin cos tan asin acos atan atan2 sinh cosh tanh exp log log10 homotopy noEvent smooth pre edge change reinit sample initial terminal size ndims sum product transpose symmetric diagonal identity zeros ones fill cat linspace',
      },
      contains: [
        hljs.C_LINE_COMMENT_MODE,
        hljs.C_BLOCK_COMMENT_MODE,
        { scope: 'string', begin: /"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE] },
        // Quoted identifiers can contain spaces and punctuation; they are not strings/keywords.
        { scope: 'symbol', begin: /'/, end: /'/, contains: [hljs.BACKSLASH_ESCAPE] },
        { scope: 'number', match: /(?:\b\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/ },
      ],
    };
  }
  if (root.hljs) root.hljs.registerLanguage('modelica', modelica);
  if (typeof module !== 'undefined' && module.exports) module.exports = modelica;
})(typeof globalThis !== 'undefined' ? globalThis : window);
