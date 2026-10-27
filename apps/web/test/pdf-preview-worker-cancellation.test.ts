import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
const state = vi.hoisted(() => ({ options: null as any, pages: 1, loadingDestroy: vi.fn(), workerDestroy: vi.fn(), workerError: null as null | (() => void) }));
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
      addEventListener(type: string, listener: () => void) { if (type === 'error') state.workerError = listener; }
      terminate = live.terminate;
    }
  );
  vi.stubGlobal('requestAnimationFrame', (f: any) => f());
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({}) as any;
  const module = await import('../src/web/public/file-preview-pdf.mjs');
  const container = dom.window.document.getElementById('pdf');
  return { module, container };
}

it('queued registered worker error respects caller destroy and abort without mutating retired status', async () => {
  const results = [];
  for (const mode of ['destroy', 'abort']) {
    const f = await setup();
    const controller = new AbortController();
    const instance = await f.module.mountReadOnlyPdf({bytes: new Uint8Array([1]), container: f.container, signal: controller.signal});
    destroy = instance.destroy;
    const status = f.container.querySelector('.file-preview-pdf-controls span');
    const before = status.textContent;
    const listener = state.workerError;
    expect(typeof listener).toBe('function');
    if (mode === 'destroy') instance.destroy(); else controller.abort();
    f.container.textContent = 'New active preview';
    listener!(); // a previously queued error delivery, no real Worker or provider
    const after = status.textContent;
    const current = f.container.textContent;
    results.push({mode, before, after, current, terminated: live.terminate.mock.calls.length});
    expect(current).toBe('New active preview');
    expect(live.terminate).toHaveBeenCalledOnce();
    dom.window.close();
  }
  console.log('QUEUED-WORKER-ERROR-BOUNDARY', JSON.stringify(results));
  for (const result of results) expect(result.after).toBe(result.before);
});
it('publishes a genuine active worker error and performs cleanup exactly once', async () => {
  const f = await setup();
  const controller = new AbortController();
  const instance = await f.module.mountReadOnlyPdf({bytes: new Uint8Array([1]), container: f.container, signal: controller.signal});
  destroy = instance.destroy;
  const listener = state.workerError;
  expect(typeof listener).toBe('function');
  listener!();
  expect(f.container.querySelector('.file-preview-pdf-controls span').textContent).toBe('PDF worker unavailable. Use Download.');
  expect([...f.container.querySelectorAll('button')].every((button: any) => button.disabled)).toBe(true);
  expect(live.terminate).toHaveBeenCalledOnce();
  expect(state.workerDestroy).toHaveBeenCalledOnce();
  expect(state.loadingDestroy).toHaveBeenCalledOnce();
  expect(f.container.querySelector('canvas').width).toBe(0);
  expect(f.container.querySelector('canvas').height).toBe(0);
  instance.destroy();
  expect(live.terminate).toHaveBeenCalledOnce();
});
