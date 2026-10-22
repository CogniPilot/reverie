import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { processIdentity, survivingPlanProcesses } from '../src/plan-move-processes.js';

const stat = (state: string, start: string) =>
  `123 (name with ) spaces) ${[state, ...Array(18).fill('0'), start, '0'].join(' ')}`;

describe('plan cleanup checks process identity without killing or trusting reused pids', () => {
  it('parses parenthesized names and treats zombies as exited', () => {
    expect(processIdentity(123, stat('S', '456'))).toEqual({ pid: 123, start: '456' });
    expect(processIdentity(123, stat('Z', '456'))).toBeUndefined();
    expect(() => processIdentity(123, 'invalid')).toThrow();
  });

  it('reports only the original live process, not a replacement sharing its pid', async () => {
    const read = vi
      .spyOn(fs, 'readFile')
      .mockImplementation(async (path) => stat('S', String(path).includes('/123/') ? '456' : 'new-start'));
    try {
      read.mockImplementation(async (path) => stat('S', String(path).includes('/123/') ? '456' : '999'));
      expect(
        await survivingPlanProcesses(
          [
            { pid: 123, start: '456' },
            { pid: 124, start: '789' },
          ],
          0
        )
      ).toEqual([123]);
    } finally {
      read.mockRestore();
    }
  });

  it('fails closed on an unreadable process instead of claiming no orphans', async () => {
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      await expect(survivingPlanProcesses([{ pid: 123, start: '456' }], 0)).rejects.toThrow('denied');
    } finally {
      read.mockRestore();
    }
  });
});
