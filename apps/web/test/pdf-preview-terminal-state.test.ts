import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
const state = vi.hoisted(() => ({ options: null as any, pages: 1, loadingDestroy: vi.fn(), workerDestroy: vi.fn() }));
vi.mock('../src/web/public/vendor/pdfjs-6.4.299/pdf.mjs', () => ({
  PDFWorker: class {
    destroy = state.workerDestroy;
  },
  AnnotationMode: { DISABLE: 0 },
  getDocument: (options: any) => {
    state.options = options;
    const page = {
      cleanup: vi.fn(),
      getViewport: ({ scale }: any) => ({ width: 100 * scale, height: 100 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({ items: [] }),
    };
    return {
      destroy: state.loadingDestroy,
      promise: Promise.resolve({
        numPages: state.pages,
        getPage: async (n: number) =>
          n === 1
            ? page
            : {
                ...page,
                render: () => ({
                  promise: new options.BinaryDataFactory().fetch({
                    kind: 'standardFontDataUrl',
                    filename: 'FoxitFixed.pfb',
                  }),
                  cancel: vi.fn(),
                }),
              },
      }),
    };
  },
}));
let dom: any, live: any, destroy: any;
afterEach(() => {
  destroy?.();
  vi.unstubAllGlobals();
  dom?.window.close();
  state.pages = 1;
  vi.clearAllMocks();
});
async function setup() {
  dom = new JSDOM('<div id="pdf"></div>');
  live = { terminate: vi.fn() };
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal(
    'Worker',
    class {
      addEventListener() {}
      terminate = live.terminate;
    }
  );
  vi.stubGlobal('requestAnimationFrame', (f: any) => f());
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({}) as any;
  const module = await import('../src/web/public/file-preview-pdf.mjs');
  const container = dom.window.document.getElementById('pdf');
  return { module, container };
}

function pendingAsset() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  vi.stubGlobal('fetch', () => promise);
  return resolve;
}
function nextPage(container: any) {
  [...container.querySelectorAll('button')].find((b: any) => b.textContent === 'Next').click();
}
it('does not repaint a closed/replaced mount when an asset refusal arrives late', async () => {
  const f = await setup();
  state.pages = 2;
  const resolve = pendingAsset();
  const instance = await f.module.mountReadOnlyPdf({ bytes: new Uint8Array([1]), container: f.container });
  destroy = instance.destroy;
  nextPage(f.container);
  await new Promise((r) => setTimeout(r, 0));
  const status = f.container.querySelector('.file-preview-pdf-controls span');
  const before = status.textContent;
  instance.destroy();
  f.container.textContent = 'Newer preview';
  resolve(new Response('bad'));
  await new Promise((r) => setTimeout(r, 20));
  expect(status.textContent).toBe(before);
  expect(f.container.textContent).toBe('Newer preview');
  expect(live.terminate).toHaveBeenCalledOnce();
});
it('does not publish an internal error after the caller aborts during a later-page read', async () => {
  const f = await setup();
  state.pages = 2;
  const resolve = pendingAsset();
  const controller = new AbortController();
  const instance = await f.module.mountReadOnlyPdf({
    bytes: new Uint8Array([1]),
    container: f.container,
    signal: controller.signal,
  });
  destroy = instance.destroy;
  nextPage(f.container);
  await new Promise((r) => setTimeout(r, 0));
  const status = f.container.querySelector('.file-preview-pdf-controls span');
  const before = status.textContent;
  controller.abort();
  resolve(new Response('bad'));
  await new Promise((r) => setTimeout(r, 20));
  expect(status.textContent).toBe(before);
  expect(live.terminate).toHaveBeenCalledOnce();
});
it('honors a close triggered during cleanup before the terminal failure callback runs', async () => {
  const f = await setup();
  state.pages = 2;
  vi.stubGlobal('fetch', async () => new Response('bad'));
  const instance = await f.module.mountReadOnlyPdf({ bytes: new Uint8Array([1]), container: f.container });
  destroy = instance.destroy;
  state.loadingDestroy.mockImplementationOnce(() => {
    instance.destroy();
    f.container.textContent = 'Replacement during cleanup';
    return Promise.resolve();
  });
  nextPage(f.container);
  await vi.waitFor(() => expect(live.terminate).toHaveBeenCalledOnce());
  await new Promise((r) => setTimeout(r, 0));
  expect(f.container.textContent).toBe('Replacement during cleanup');
});
