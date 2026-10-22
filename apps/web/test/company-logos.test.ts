import { describe, expect, it } from 'vitest';
import { createHarness, room } from './helpers/chat-app-harness.mjs';

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';
const UPLOAD = 'data:image/png;base64,dXBsb2Fk';
const LOGO = { id: 'company-01', name: 'Folded Crescent', src: '/assets/company-logos/company-01.png' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function harness(initialRevision: unknown = 'pack-one') {
  const h = await createHarness({ rooms: [room('r1', 'General', [], { workspace: 'Acme' })] });
  const originalFetch = h.window.fetch;
  const fetched: string[] = [];
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let revision = initialRevision;
  h.window.fetch = async (path: string, init?: RequestInit) => {
    fetched.push(String(path));
    requests.push({ path: String(path), init });
    if (path === '/assets/company-logos/pack-manifest.json')
      return {
        ok: true,
        json: async () => ({
          version: 1,
          revision,
          logos: [
            LOGO,
            { ...LOGO, id: 'company-02', src: 'https://untrusted.invalid/logo.png' },
            { ...LOGO, id: '../private', src: '/assets/company-logos/../private.png' },
          ],
        }),
      };
    if (String(path).startsWith(LOGO.src + '?rev=')) return { ok: true, blob: async () => new h.window.Blob(['png'], { type: 'image/png' }) };
    return originalFetch(path, init);
  };
  h.shell.imageToIcon = async (blob: Blob) => {
    expect(blob.type).toBe('image/png');
    return PIXEL;
  };
  return { ...h, fetched, requests, setRevision: (value: unknown) => { revision = value; } };
}

describe('optional company logos', () => {
  it('persists a selected mark through the workspace-picture API and still allows upload replacement and removal', async () => {
    const h = await harness();
    h.shell.openWorkspaceSettings('Acme');
    await settle();
    const settings = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    (settings.querySelector('[aria-label="Use Folded Crescent logo"]') as HTMLButtonElement).click();
    await settle();
    const save = [...settings.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save changes'
    ) as HTMLButtonElement;
    save.click();
    await settle();
    expect(h.server.wsIconCalls).toEqual([{ kind: 'put', name: 'Acme', type: 'image/png', size: 8 }]);
    expect(h.document.querySelector('[data-key="ws:Acme"] .ca-rail-img')?.getAttribute('src')).toMatch(
      /^\/api\/workspace-icons\//
    );
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta') || '{}').Acme?.image).toBeUndefined();

    h.shell.imageToIcon = async () => UPLOAD;
    const input = settings.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new h.window.File(['own'], 'own.png', { type: 'image/png' })] });
    input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle();
    save.click();
    await settle();
    expect(h.server.wsIconCalls.at(-1)).toEqual({ kind: 'put', name: 'Acme', type: 'image/png', size: 6 });
    (
      [...settings.querySelectorAll('.ca-picture button')].find(
        (button) => button.textContent === 'Remove'
      ) as HTMLButtonElement
    ).click();
    save.click();
    await settle();
    expect(h.server.wsIconCalls.at(-1)).toEqual({ kind: 'delete', name: 'Acme' });
    expect(h.document.querySelector('[data-key="ws:Acme"] .ca-rail-letter')?.textContent).toBe('A');
  });

  it('rejects invalid manifest source URLs before rendering or fetching them', async () => {
    const h = await harness();
    h.shell.openWorkspaceSettings('Acme');
    await settle();
    expect(h.document.querySelectorAll('.ca-company-logos button')).toHaveLength(1);
    expect(h.document.querySelectorAll('.ca-company-logos img')[0]?.getAttribute('src')).toBe(LOGO.src + '?rev=pack-one');
    expect(h.fetched.some((url) => url.includes('untrusted') || url.includes('../private'))).toBe(false);
  });

  it('revalidates the manifest and applies a changed revision to both preview and selected image requests', async () => {
    const h = await harness('before-edit');
    const first = h.shell.workspaceLogoField('', () => {});
    h.document.body.append(first.wrap);
    await settle();
    expect(first.wrap.querySelector('img')?.getAttribute('src')).toBe(LOGO.src + '?rev=before-edit');
    h.setRevision('after-edit');
    const second = h.shell.workspaceLogoField('', () => {});
    h.document.body.append(second.wrap);
    await settle();
    expect(second.wrap.querySelector('img')?.getAttribute('src')).toBe(LOGO.src + '?rev=after-edit');
    (second.wrap.querySelector('[aria-label="Use Folded Crescent logo"]') as HTMLButtonElement).click();
    await settle();
    expect(h.fetched).toContain(LOGO.src + '?rev=after-edit');
    expect(h.fetched).not.toContain(LOGO.src);
    const manifests = h.requests.filter(r => r.path.endsWith('pack-manifest.json'));
    expect(manifests).toHaveLength(2);
    expect(manifests.every(r => r.init?.cache === 'no-cache')).toBe(true);
  });

  it.each(['../private', 'x'.repeat(81), 123])('rejects an invalid revision without image requests: %s', async revision => {
    const h = await harness(revision);
    h.shell.openWorkspaceSettings('Acme');
    await settle();
    expect(h.document.querySelectorAll('.ca-company-logos img')).toHaveLength(0);
    expect(h.fetched).toEqual(['/assets/company-logos/pack-manifest.json']);
  });

  it('saves the optional logo on workspace creation before opening its first-channel dialog', async () => {
    const h = await harness();
    h.shell.openWorkspaceDialog();
    await settle();
    const dialog = h.document.querySelector('.ca-workspace') as HTMLDialogElement;
    (dialog.querySelector('input') as HTMLInputElement).value = 'New Company';
    (dialog.querySelector('[aria-label="Use Folded Crescent logo"]') as HTMLButtonElement).click();
    await settle();
    (dialog.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle();
    expect(h.server.wsIconCalls).toContainEqual({ kind: 'put', name: 'New Company', type: 'image/png', size: 8 });
    expect(h.document.querySelector('.ca-workspace')).toBeNull();
    expect(h.document.querySelector('.ca-create .ca-dialog-note')?.textContent).toContain('New Company');
  });
});
