// Drives the actual settings mixin and HTML escaping without a browser or server.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadSettingsUi(data: Record<string, unknown>) {
  const elements = Object.fromEntries(
    [
      'updateResult',
      'updateCheckBtn',
      'updateActionRow',
      'updateNotes',
      'updateCurrentVersion',
      'updateActionLabel',
      'updateNowBtn',
    ].map((id) => [id, { innerHTML: '', textContent: '', disabled: false, style: { display: 'flex' } }])
  );
  class App {
    declare checkForUpdate: () => Promise<void>;
    _apiJson = vi.fn(async () => data);
    $(id: string) {
      return elements[id] ?? null;
    }
  }
  const context = vm.createContext({ ReverieApp: App, window: {}, document: {} });
  for (const file of ['constants.js', 'settings-ui.js']) {
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8'), context, {
      filename: file,
    });
  }
  return { app: new App(), elements };
}

describe('manual update policy visibility', () => {
  it.each([
    { installKind: 'npm', supervisor: 'none' },
    { installKind: 'unknown', supervisor: 'docker-compose' },
    { installKind: 'docker-compose', supervisor: 'docker-compose' },
    { installKind: 'git', supervisor: 'none' },
  ])('shows the escaped disabled policy before install hints for $installKind/$supervisor', async (install) => {
    const error = 'Reverie rebuild required: <img src=x onerror="alert(1)"> & review';
    const { app, elements } = loadSettingsUi({
      ...install,
      selfUpdateEnabled: false,
      currentVersion: '1.41.1',
      updateAvailable: true,
      latestVersion: '99.0.0',
      notes: 'Untrusted upstream release notes',
      error,
    });

    await app.checkForUpdate();

    expect(app._apiJson).toHaveBeenCalledExactlyOnceWith('/api/system/update/check');
    expect(elements.updateResult.innerHTML).toBe(
      'Reverie rebuild required: &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; review'
    );
    expect(elements.updateActionRow.style.display).toBe('none');
    expect(elements.updateNotes.style.display).toBe('none');
    expect(elements.updateCheckBtn.disabled).toBe(false);
    expect(elements.updateCurrentVersion.textContent).toBe('v1.41.1');
  });

  it('explains the monorepo rebuild when the disabled policy has no error detail', async () => {
    const { app, elements } = loadSettingsUi({ installKind: 'npm', selfUpdateEnabled: false });

    await app.checkForUpdate();

    expect(elements.updateResult.innerHTML).toBe(
      'Reverie is maintained in this monorepo. Rebuild its container image to update.'
    );
    expect(elements.updateResult.innerHTML).not.toContain('REVERIE_DISABLE_SELF_UPDATE');
    expect(elements.updateResult.innerHTML).not.toContain('aireverie');
  });

  it('preserves the enabled git update flow', async () => {
    const { app, elements } = loadSettingsUi({
      installKind: 'git',
      selfUpdateEnabled: true,
      updateAvailable: true,
      currentVersion: '1.41.1',
      latestVersion: '1.41.2',
      notes: 'Reviewed release notes',
    });

    await app.checkForUpdate();

    expect(elements.updateResult.innerHTML).toContain('Update available:');
    expect(elements.updateActionRow.style.display).toBe('flex');
    expect(elements.updateActionLabel.textContent).toBe('Update to v1.41.2');
    expect(elements.updateNotes.textContent).toBe('Reviewed release notes');
  });
});
