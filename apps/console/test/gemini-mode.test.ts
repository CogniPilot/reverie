import { describe, expect, it } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';

describe('Gemini mode schemas', () => {
  it('accepts Gemini session creation config', () => {
    const parsed = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'gemini',
      geminiConfig: {
        model: 'gemini-2.5-pro',
        approvalMode: 'yolo',
      },
    });

    expect(parsed.mode).toBe('gemini');
    expect(parsed.geminiConfig).toEqual({
      model: 'gemini-2.5-pro',
      approvalMode: 'yolo',
    });
  });

  it('accepts Gemini quick-start config', () => {
    const parsed = QuickStartSchema.parse({
      caseName: 'gemini-case',
      mode: 'gemini',
      geminiConfig: {
        model: 'gemini-2.5-flash',
        approvalMode: 'auto_edit',
      },
    });

    expect(parsed.mode).toBe('gemini');
    expect(parsed.geminiConfig?.model).toBe('gemini-2.5-flash');
  });

  it('rejects unsafe Gemini model strings', () => {
    expect(() =>
      CreateSessionSchema.parse({
        workingDir: '/tmp',
        mode: 'gemini',
        geminiConfig: { model: 'gemini; rm -rf /' },
      })
    ).toThrow();
  });
});
