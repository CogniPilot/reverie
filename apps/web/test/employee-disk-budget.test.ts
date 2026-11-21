import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMPLOYEE_DISK_BUDGET_BYTES,
  DISK_BUDGET_NOTICE_INTERVAL_MS,
  classifyDiskBudget,
  diskBudgetNotice,
  formatGiB,
  shouldNotifyDiskBudget,
} from '../src/employee-disk-budget.js';

const GIB = 1024 ** 3;
const budgetBytes = DEFAULT_EMPLOYEE_DISK_BUDGET_BYTES;

describe('employee disk budget rules', () => {
  it('defaults to 20 GiB', () => {
    expect(budgetBytes).toBe(20 * GIB);
  });

  it('classifies a measurement against the budget', () => {
    expect(classifyDiskBudget({ usedBytes: 0, budgetBytes })).toBe('ok');
    expect(classifyDiskBudget({ usedBytes: budgetBytes, budgetBytes })).toBe('ok');
    expect(classifyDiskBudget({ usedBytes: budgetBytes + 1, budgetBytes })).toBe('over');
  });

  it('notifies a new crossing at once and then at most every six hours', () => {
    const now = 1_000_000_000;
    const over = { state: 'over' as const, now };
    expect(shouldNotifyDiskBudget({ ...over, notifiedSinceOver: false, lastNotifiedAt: null })).toBe(true);
    // Told an hour ago, went back under, crossed again: a fresh notice.
    expect(shouldNotifyDiskBudget({ ...over, notifiedSinceOver: false, lastNotifiedAt: now - 3_600_000 })).toBe(true);
    expect(shouldNotifyDiskBudget({ ...over, notifiedSinceOver: true, lastNotifiedAt: now - 3_600_000 })).toBe(false);
    expect(
      shouldNotifyDiskBudget({
        ...over,
        notifiedSinceOver: true,
        lastNotifiedAt: now - DISK_BUDGET_NOTICE_INTERVAL_MS + 1,
      })
    ).toBe(false);
    expect(
      shouldNotifyDiskBudget({ ...over, notifiedSinceOver: true, lastNotifiedAt: now - DISK_BUDGET_NOTICE_INTERVAL_MS })
    ).toBe(true);
    expect(shouldNotifyDiskBudget({ state: 'ok', now, notifiedSinceOver: false, lastNotifiedAt: null })).toBe(false);
  });

  it('formats GiB without a trailing .0', () => {
    expect(formatGiB(20 * GIB)).toBe('20');
    expect(formatGiB(37.2 * GIB)).toBe('37.2');
    expect(formatGiB(0)).toBe('0');
  });

  it('renders one plain ASCII line', () => {
    const text = diskBudgetNotice({ usedBytes: 37.2 * GIB, budgetBytes });
    expect(text).toBe(
      'Disk budget notice from the office: your case folder uses 37.2 GiB of your 20 GiB budget. Clean up now: ' +
        'delete build outputs and old run/work folders, keep only git clones, push useful work to GitHub, and ask ' +
        'the owner for approval before keeping anything permanently (approved items go on the shared company ' +
        'drive). The shared Nix store does not count.'
    );
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });

  it('never shows usage just over the budget as the budget itself', () => {
    expect(diskBudgetNotice({ usedBytes: budgetBytes + 1, budgetBytes })).toContain('uses 20.1 GiB of your 20 GiB');
  });
});
