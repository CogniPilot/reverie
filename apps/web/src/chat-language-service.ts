/** Bounded, one-document stdio LSP requests. No commands, file paths or raw RPC come from the browser. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const ChatLanguageRequest = z
  .object({
    enabled: z.literal(true),
    language: z.enum(['python', 'modelica']),
    source: z.string().max(50000),
    action: z.enum(['diagnostics', 'completion', 'hover']),
    position: z
      .object({ line: z.number().int().min(0).max(50000), character: z.number().int().min(0).max(50000) })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const lines = value.source.split('\n');
    if (value.position.line >= lines.length || value.position.character > lines[value.position.line].length) {
      ctx.addIssue({ code: 'custom', message: 'Cursor outside snippet', path: ['position'] });
    }
  });
type LanguageRequest = z.infer<typeof ChatLanguageRequest>;
type JsonObject = Record<string, unknown>;
export interface LanguageResult {
  diagnostics: { line: number; character: number; message: string; severity?: number }[];
  diagnosticsReceived: boolean;
  completions?: { label: string; detail: string }[];
  hover?: string;
}

const MAX_FRAME = 1024 * 1024;
const MAX_OUTPUT = 4 * MAX_FRAME;
const text = (value: unknown, limit = 4000): string => (typeof value === 'string' ? value.slice(0, limit) : '');
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const hoverText = (value: unknown): string => {
  if (Array.isArray(value)) return value.slice(0, 20).map(hoverText).join('\n').slice(0, 12000);
  return typeof value === 'string' ? value.slice(0, 12000) : text(object(value).value, 12000);
};

export class ChatLanguageService {
  private readonly active = new Map<AbortController, LanguageRequest['language']>();
  private stopped = false;
  constructor(
    private readonly options: {
      binaries?: Partial<Record<LanguageRequest['language'], string>>;
      scratch?: string;
      timeoutMs?: number;
      enabled?: (language: LanguageRequest['language']) => boolean;
    } = {}
  ) {}

  private binary(language: LanguageRequest['language']): string | undefined {
    const value =
      this.options.binaries?.[language] ??
      process.env[language === 'python' ? 'REVERIE_CHAT_PYTHON_LSP_BINARY' : 'REVERIE_CHAT_MODELICA_LSP_BINARY'];
    return value && isAbsolute(value) ? value : undefined;
  }

  async available(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const language of ['python', 'modelica'] as const) {
      const binary = this.binary(language);
      result[language] =
        !!binary &&
        (await access(binary, constants.X_OK).then(
          () => true,
          () => false
        ));
    }
    return result;
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.active.keys()) controller.abort();
  }

  cancel(language: LanguageRequest['language']): void {
    for (const [controller, activeLanguage] of this.active) {
      if (activeLanguage === language) controller.abort();
    }
  }

  async assist(input: unknown, signal?: AbortSignal): Promise<LanguageResult> {
    // Validate even direct callers before looking up a binary or creating files/processes.
    const request = ChatLanguageRequest.parse(input);
    if (!this.options.enabled?.(request.language)) throw new Error('This language plugin is disabled by the owner');
    const binary = this.binary(request.language);
    if (!binary)
      throw new Error(
        `Local ${request.language === 'python' ? 'Pyright' : 'Rumoca LSP'} is not configured. Ask the owner to configure its installed binary.`
      );
    if (this.stopped || signal?.aborted) throw new Error('Language assistance cancelled');
    if (this.active.size >= 2) throw new Error('Language assistance busy; try again shortly');
    const controller = new AbortController();
    this.active.set(controller, request.language);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(15000, this.options.timeoutMs ?? 10000));
    let directory: string | undefined;
    try {
      const { mkdir } = await import('node:fs/promises');
      const scratch = this.options.scratch ?? process.env.TMPDIR ?? join(homedir(), 'scratch', 'reverie', 'chat-lsp');
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(scratch, 'snippet-'));
      if (controller.signal.aborted) throw new Error('Language assistance cancelled');
      // Isolated environment: no instance HOME, provider credentials, PYTHONPATH, Modelica path or proxy variables.
      // Absolute owner-selected programs only; never invoke a shell or an installer.
      const child = spawn(binary, request.language === 'python' ? ['--stdio'] : [], {
        cwd: directory,
        env: { HOME: directory, TMPDIR: directory, XDG_CACHE_HOME: directory, PATH: dirname(binary), LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      return await this.exchange(child, request, directory, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  private exchange(
    child: ChildProcessWithoutNullStreams,
    request: LanguageRequest,
    directory: string,
    signal: AbortSignal
  ): Promise<LanguageResult> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0),
        total = 0,
        nextId = 1,
        finished = false;
      const result: LanguageResult = { diagnostics: [], diagnosticsReceived: false };
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      const uri = pathToFileURL(join(directory, request.language === 'python' ? 'snippet.py' : 'Snippet.mo')).href;
      const killTimer = setTimeout(
        () => finish(new Error('Language server exceeded its deadline')),
        Math.min(15000, this.options.timeoutMs ?? 10000) + 100
      );
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        signal.removeEventListener('abort', aborted);
        // Each disposable POSIX server owns its group, including wrapper/Node children.
        // Signal only that group; never leave descendants after releasing the slot.
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        for (const waiter of pending.values()) waiter.reject(error ?? new Error('Language request finished'));
        pending.clear();
        // Wait for reaping before deleting the temporary document/HOME and releasing the concurrency slot.
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
          if (error) reject(error);
          else resolve(result);
        } else child.once('close', () => (error ? reject(error) : resolve(result)));
      };
      const aborted = (): void => finish(new Error('Language assistance cancelled or timed out'));
      const send = (message: JsonObject): void => {
        if (finished) return;
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        child.stdin.write(body);
      };
      const rpc = (method: string, params: unknown): Promise<unknown> =>
        new Promise((done, failed) => {
          if (finished) {
            failed(new Error('Language request finished'));
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve: done, reject: failed });
          send({ id, method, params });
        });
      const handle = (message: JsonObject): void => {
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            // A language server cannot delegate edits, execution, registrations or file reads to the client.
            if (message.method === 'workspace/configuration') {
              const items = object(message.params).items;
              send({
                id: message.id,
                result: Array.isArray(items)
                  ? items.slice(0, 100).map(() => ({
                      analysis: {
                        autoSearchPaths: false,
                        useLibraryCodeForTypes: false,
                        diagnosticMode: 'openFilesOnly',
                        typeCheckingMode: 'basic',
                      },
                    }))
                  : [],
              });
            } else send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
          } else if (message.method === 'textDocument/publishDiagnostics') {
            const params = object(message.params);
            if (params.uri !== uri || !Array.isArray(params.diagnostics)) return;
            result.diagnosticsReceived = true;
            result.diagnostics = params.diagnostics.slice(0, 100).map((value) => {
              const item = object(value),
                start = object(object(item.range).start);
              return {
                line: Number.isInteger(start.line) ? Math.max(0, Number(start.line)) : 0,
                character: Number.isInteger(start.character) ? Math.max(0, Number(start.character)) : 0,
                message: text(item.message),
                ...(typeof item.severity === 'number' ? { severity: item.severity } : {}),
              };
            });
            if (request.action === 'diagnostics') finish();
          }
          return;
        }
        const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
        if (!waiter) return;
        pending.delete(Number(message.id));
        if (message.error) waiter.reject(new Error('Language server rejected the request'));
        else waiter.resolve(message.result);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_OUTPUT) {
          finish(new Error('Language server output limit exceeded'));
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        while (!finished) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > 8192) finish(new Error('Invalid language server header'));
            break;
          }
          if (end > 8192) {
            finish(new Error('Invalid language server header'));
            break;
          }
          const length = /^Content-Length:\s*(\d+)\s*$/im.exec(buffer.subarray(0, end).toString());
          const size = length ? Number(length[1]) : -1;
          if (size < 0 || size > MAX_FRAME) {
            finish(new Error('Invalid language server frame'));
            break;
          }
          if (buffer.length < end + 4 + size) break;
          const frame = buffer.subarray(end + 4, end + 4 + size);
          buffer = buffer.subarray(end + 4 + size);
          try {
            handle(object(JSON.parse(frame.toString('utf8'))));
          } catch {
            finish(new Error('Invalid language server response'));
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_OUTPUT) finish(new Error('Language server output limit exceeded'));
      });
      child.stdin.on('error', () => finish(new Error('Language server input closed')));
      child.on('error', () => finish(new Error('Installed language server could not start')));
      child.on('exit', () => {
        if (!finished) finish(new Error('Language server exited before responding'));
      });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      void (async () => {
        await rpc('initialize', {
          processId: null,
          rootUri: pathToFileURL(directory).href,
          workspaceFolders: [],
          capabilities: {
            textDocument: {
              publishDiagnostics: {},
              hover: { contentFormat: ['plaintext'] },
              completion: { completionItem: { snippetSupport: false } },
            },
          },
          initializationOptions: { diagnosticMode: 'openFilesOnly' },
          clientInfo: { name: 'Reverie snippet assistance' },
        });
        send({ method: 'initialized', params: {} });
        send({
          method: 'workspace/didChangeConfiguration',
          params: {
            settings: {
              python: {
                analysis: {
                  autoSearchPaths: false,
                  useLibraryCodeForTypes: false,
                  diagnosticMode: 'openFilesOnly',
                  typeCheckingMode: 'basic',
                },
              },
            },
          },
        });
        send({
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId: request.language, version: 1, text: request.source } },
        });
        if (request.action === 'diagnostics') return;
        const value = await rpc(`textDocument/${request.action}`, {
          textDocument: { uri },
          position: request.position,
        });
        if (request.action === 'completion') {
          const items = Array.isArray(value) ? value : object(value).items;
          result.completions = Array.isArray(items)
            ? items
                .slice(0, 100)
                .map((item) => ({ label: text(object(item).label, 500), detail: text(object(item).detail, 1000) }))
            : [];
        } else result.hover = hoverText(object(value).contents);
        finish();
      })().catch(() => finish(new Error('Language server could not complete the request')));
    });
  }
}
