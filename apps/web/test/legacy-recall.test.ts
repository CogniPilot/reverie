/**
 * @fileoverview Recall from the old memory store matches the python bridge it replaces. The fixture was produced by the
 * unmodified python reference: synthetic stores, a pinned clock and a fake embedding service; it records the exact rows
 * (hashed embeddings by digest) and what `python -m reverie.memory_cli` printed or failed with.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyRecall, parsePyJson, dumpPyJson, RECALL_LIMITS } from '../src/legacy-recall.js';
import { llamaEmbedder } from '../src/memory-embed.js';
import { build, fakeEmbeddingService, fixture, stage, type FixtureCase, type FixtureRow } from './legacy-store-fixture.js';

let serviceUrl = '';
let closeService = async () => {};
beforeAll(async () => {
  ({ url: serviceUrl, close: closeService } = await fakeEmbeddingService());
});
afterAll(() => closeService());

async function run(c: FixtureCase): Promise<{ text?: string; error?: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-')));
  try {
    const { home, config } = await stage(c, root);
    const embedUrl = c.embed === 'service' ? serviceUrl : c.embed === 'down' ? 'http://127.0.0.1:1/v1' : '';
    try {
      return { text: await legacyRecall(config, c.request, { home, embedUrl, now: () => fixture.now }) };
    } catch (error) {
      return { error: (error as Error).message.replaceAll(root, '<root>') };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('parity with the python bridge', () => {
  for (const c of fixture.cases.filter((x) => !x.refuses)) {
    it(c.id, async () => {
      const got = await run(c);
      if (c.expect.code === 0) expect(got).toEqual({ text: c.expect.stdout.trim() });
      else expect(got).toEqual({ error: (JSON.parse(c.expect.stderr.trim()) as { error: string }).error });
    });
  }
});

describe('named differences', () => {
  it('refuses, instead of importing, when a legacy-history.json would still add episodes before ranking', async () => {
    const pending = fixture.cases.find((c) => c.refuses)!;
    expect(pending.expect.code).toBe(0); // python imported it on the spot and wrote the episodes
    expect((await run(pending)).error).toMatch(/legacy-history\.json that was never imported/);
  });

  it('never writes to the store it reads', async () => {
    const c = fixture.cases.find((x) => x.id === 'private-stale-reembedded-hashed')!;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-ro-')));
    try {
      const config = path.join(root, 'config', 'agent.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify(c.instance));
      const db = path.join(root, 'state', 'memory.sqlite');
      await build(db, c.schema, c.private!, null, null);
      const before = fs.readFileSync(db);
      fs.chmodSync(db, 0o444);
      await legacyRecall(config, c.request, { home: root, now: () => fixture.now });
      expect(fs.readFileSync(db).equals(before)).toBe(true);
      expect(fs.readdirSync(path.join(root, 'state')).sort()).toEqual(['memory.sqlite']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers [] for a missing store without creating it or the state directory', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-none-')));
    try {
      const config = path.join(root, 'config', 'agent.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(
        config,
        JSON.stringify({ id: 'a1', agent_name: 'A', owner_name: 'O', data_dir: '../state', persona: 'p' })
      );
      expect(await legacyRecall(config, { query: 'q' }, { home: root })).toBe('[]');
      expect(await legacyRecall(config, { query: 'q', project: 'p1' }, { home: root })).toBe('[]');
      expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds the rows it reads and the service re-embeds it makes', () => {
    expect(RECALL_LIMITS.rows).toBeGreaterThan(0);
    expect(RECALL_LIMITS.serviceReembeds).toBeGreaterThan(0);
  });
});

describe("python's json", () => {
  it('keeps int and float kinds through a round trip, as json.loads then json.dumps does', () => {
    expect(
      dumpPyJson(
        parsePyJson(
          '{"a": 1, "b": 1.0, "c": 1e2, "d": -0, "e": 12345678901234567890123, "f": [1.5e-7, "x\\u0001\\"y"], "a": 2}'
        )
      )
    ).toBe('{"a": 2, "b": 1.0, "c": 100.0, "d": 0, "e": 12345678901234567890123, "f": [1.5e-07, "x\\u0001\\"y"]}');
  });
});

describe('bounds on the embedding service and on one recall', () => {
  async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  it('stops reading an embedding response as soon as it passes the size bound', async () => {
    let written = 0;
    const big = await serve((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = () => {
        while (written < 8 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => (written = Math.min(written, 8 * 1024 * 1024)));
      pump();
    });
    try {
      await expect(llamaEmbedder(big.url, { maxBytes: 64 * 1024 }).embed('x')).rejects.toThrow(
        'embedding response is too large'
      );
      expect(written).toBeLessThan(8 * 1024 * 1024);
    } finally {
      await big.close();
    }
  });

  it('gives every request only the time left of the shared deadline', async () => {
    const hang = await serve(() => {});
    try {
      const started = Date.now();
      await expect(
        llamaEmbedder(hang.url, { timeoutMs: 10_000, deadline: Date.now() + 300 }).embed('x')
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await hang.close();
    }
  });

  it('ends a whole recall at its time limit even when every request is within its own', async () => {
    let requests = 0;
    const slow = await serve((req, res) => {
      if (requests++ === 0) {
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] })));
      } // later requests never answer
    });
    const c = fixture.cases.find((x) => x.id === 'private-service-embedder')!;
    const total = RECALL_LIMITS.totalMs;
    RECALL_LIMITS.totalMs = 800;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-deadline-')));
    try {
      const config = path.join(root, 'config', 'agent.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify(c.instance));
      await build(path.join(root, 'state', 'memory.sqlite'), c.schema, c.private!, null, null);
      const started = Date.now();
      await expect(
        legacyRecall(config, c.request, { home: root, embedUrl: slow.url, now: () => fixture.now })
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      RECALL_LIMITS.totalMs = total;
      fs.rmSync(root, { recursive: true, force: true });
      await slow.close();
    }
  });

  it('refuses rather than re-embedding more stale rows than the bound', async () => {
    const c = fixture.cases.find((x) => x.id === 'private-stale-reembedded-hashed')!;
    const cap = RECALL_LIMITS.hashedReembeds;
    RECALL_LIMITS.hashedReembeds = 1;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-cap-')));
    try {
      const config = path.join(root, 'config', 'agent.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify(c.instance));
      await build(path.join(root, 'state', 'memory.sqlite'), c.schema, c.private!, null, null);
      await expect(legacyRecall(config, c.request, { home: root, now: () => fixture.now })).rejects.toThrow(
        /stored under another embedder/
      );
    } finally {
      RECALL_LIMITS.hashedReembeds = cap;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bounds on what one recall reads and returns', () => {
  async function store(id: string, legacy?: (state: string) => void, edit?: (rows: FixtureRow[]) => FixtureRow[]) {
    const c = fixture.cases.find((x) => x.id === id)!;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-bound-')));
    const config = path.join(root, 'config', 'agent.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(c.instance));
    await build(
      path.join(root, 'state', 'memory.sqlite'),
      c.schema,
      edit ? edit(c.private!) : c.private!,
      c.columns,
      c.state
    );
    legacy?.(path.join(root, 'state'));
    return {
      recall: (extra: { clock?: () => number } = {}) =>
        legacyRecall(config, c.request, { home: root, now: () => fixture.now, ...extra }),
      done: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }
  async function withLimit(name: keyof typeof RECALL_LIMITS, value: number, run: () => Promise<void>) {
    const before = RECALL_LIMITS[name];
    RECALL_LIMITS[name] = value;
    try {
      await run();
    } finally {
      RECALL_LIMITS[name] = before;
    }
  }

  it('measures row sizes before reading any row, and refuses an oversized one', async () => {
    const s = await store('private-hashed-ranking');
    try {
      await withLimit('rowBytes', 64, () =>
        expect(s.recall()).rejects.toThrow('an old memory is too large for recall to read')
      );
      await withLimit('inputBytes', 1024, () =>
        expect(s.recall()).rejects.toThrow('the old memory store is too large for recall to read')
      );
    } finally {
      s.done();
    }
  });

  it('refuses results larger than the old bridge passed on', async () => {
    const s = await store('private-hashed-ranking');
    try {
      await withLimit('outputBytes', 512, () =>
        expect(s.recall()).rejects.toThrow('returned more than recall passes on')
      );
    } finally {
      s.done();
    }
  });

  it('refuses an over-bound legacy-history.json instead of answering as if none were pending', async () => {
    const s = await store('legacy-history-without-pairs', (state) =>
      fs.writeFileSync(path.join(state, 'legacy-history.json'), '[' + ' '.repeat(100) + ']')
    );
    try {
      await withLimit('legacyHistoryBytes', 10, () =>
        expect(s.recall()).rejects.toThrow('legacy-history.json is too large to read')
      );
    } finally {
      s.done();
    }
    const dir = await store('legacy-history-without-pairs', (state) =>
      fs.mkdirSync(path.join(state, 'legacy-history.json'))
    );
    try {
      expect(await dir.recall()).toMatch(/^\[\{"id": 1/); // a directory is an OSError to python: nothing pending
    } finally {
      dir.done();
    }
  });
});

describe('every column and every step count against the bounds', () => {
  async function single(edit: (row: FixtureRow) => FixtureRow) {
    const c = fixture.cases.find((x) => x.id === 'legacy-assistant-column')!;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-step-')));
    const config = path.join(root, 'config', 'agent.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(c.instance));
    await build(path.join(root, 'state', 'memory.sqlite'), c.schema, c.private!.map(edit), c.columns, c.state);
    return {
      recall: (clock?: () => number) => legacyRecall(config, c.request, { home: root, now: () => fixture.now, clock }),
      done: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  it('measures columns that are not memory text, such as importance_source', async () => {
    const s = await single((row) => ({ ...row, importance_source: 'x'.repeat(16 * 1024) }));
    const before = RECALL_LIMITS.rowBytes;
    RECALL_LIMITS.rowBytes = 8 * 1024;
    try {
      await expect(s.recall()).rejects.toThrow('an old memory is too large for recall to read');
    } finally {
      RECALL_LIMITS.rowBytes = before;
      s.done();
    }
  });

  it('refuses at whichever step the deadline passes, the last one included', async () => {
    const s = await single((row) => row);
    try {
      let reads = 0;
      await s.recall(() => (reads++, 0));
      // one row, hashed, nothing stale: the deadline is set, then checked before the query, after scoring, after the
      // results are built and after they are serialized; no step may finish once it has passed
      expect(reads).toBe(5);
      for (let expireAfter = 1; expireAfter < reads; expireAfter++) {
        let n = 0;
        const clock = () => (n++ < expireAfter ? 0 : RECALL_LIMITS.totalMs + 1);
        await expect(s.recall(clock), `deadline passing after ${expireAfter} reads`).rejects.toThrow(
          'recall took longer than its time limit'
        );
      }
    } finally {
      s.done();
    }
  });
});
