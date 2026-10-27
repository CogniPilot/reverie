/** Explicit operator check: requires installed binaries; never installs tools or runs snippets. */
import assert from 'node:assert/strict';
import { ChatLanguageService } from '../src/chat-language-service.js';

// This explicit operator diagnostic intentionally enables its synthetic snippets.
const service = new ChatLanguageService({ enabled: () => true });
try {
  assert.deepEqual(
    await service.available(),
    { python: true, modelica: true },
    'Configure both installed language servers first'
  );
  const cases = [
    { language: 'python', source: 'answer: int = "wrong"\nanswer', position: { line: 1, character: 3 } },
    {
      language: 'modelica',
      source: 'model Example\n Real value;\nequation\n value = ;\nend Example;',
      position: { line: 1, character: 8 },
    },
  ];
  for (const item of cases) {
    const diagnostics = await service.assist({ ...item, enabled: true, action: 'diagnostics' });
    assert.equal(diagnostics.diagnosticsReceived, true);
    assert.ok(diagnostics.diagnostics.length > 0, `${item.language}: malformed snippet must produce a diagnostic`);
    console.log(JSON.stringify({ language: item.language, action: 'diagnostics', result: diagnostics }));
  }
  for (const language of ['python', 'modelica'] as const) {
    const source =
      language === 'python'
        ? 'answer: int = 42\nanswer'
        : 'model Example\n Real value;\nequation\n value = 1;\nend Example;';
    const position = language === 'python' ? { line: 1, character: 3 } : { line: 3, character: 3 };
    for (const action of ['completion', 'hover'] as const) {
      const result = await service.assist({ enabled: true, language, source, action, position });
      assert.ok(action === 'completion' ? Array.isArray(result.completions) : typeof result.hover === 'string');
      console.log(JSON.stringify({ language, action, result }));
    }
  }
} finally {
  service.stop();
}
