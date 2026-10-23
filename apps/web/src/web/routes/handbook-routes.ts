/** Packaged office handbook: one Markdown source for humans and scoped agents. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HANDBOOK_PAGES = [
  {
    slug: 'recovery',
    title: 'Recover a stuck expert',
    summary: 'Diagnose a dead session, check permission, recover and verify readiness.',
  },
  {
    slug: 'permissions',
    title: 'Permissions and preferences',
    summary: 'Explicit grants, immediate saving, Sleep and Dream.',
  },
  { slug: 'laptops', title: 'Office laptops', summary: 'Where tools run, resource protection and host boundaries.' },
  {
    slug: 'power',
    title: 'Power and restarts',
    summary: 'Stop the office, stop agents, restart the website and the offline safeguard.',
  },
  {
    slug: 'work',
    title: 'Work and scratch',
    summary: 'Shared projects, private scratch ownership, leases and cleanup.',
  },
  {
    slug: 'models',
    title: 'Models and plans',
    summary: 'Select a runtime or local model while preserving expert identity.',
  },
] as const;

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  );
const inline = (value: string): string =>
  escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((\/handbook(?:\/[a-z-]+)?)\)/g, '<a href="$2">$1</a>');

/** Intentionally limited Markdown. Raw HTML and arbitrary link schemes stay text. */
export function renderHandbookMarkdown(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | undefined;
  let code: string[] | undefined;
  const flush = () => {
    if (paragraph.length) {
      output.push('<p>' + inline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
    if (list) {
      output.push('</' + list + '>');
      list = undefined;
    }
  };
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      if (code) {
        output.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        code = undefined;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      flush();
      output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const item = /^(?:([-*]) |\d+\. )(.*)$/.exec(line);
    if (item) {
      const kind = item[1] ? 'ul' : 'ol';
      if (paragraph.length || (list && list !== kind)) flush();
      if (!list) {
        list = kind;
        output.push('<' + list + '>');
      }
      output.push('<li>' + inline(item[2]) + '</li>');
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  if (code) output.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
  return output.join('\n');
}

function page(title: string, body: string, active = '', query = ''): string {
  const nav = HANDBOOK_PAGES.map(
    (p) => `<a href="/handbook/${p.slug}"${p.slug === active ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Reverie handbook</title><style>
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;color:light-dark(#20232a,#e6e9ef);background:light-dark(#fafafa,#11151b)}a{color:light-dark(#1459a3,#78c9ff)}header{padding:16px 24px;border-bottom:1px solid #8885;display:flex;gap:24px;flex-wrap:wrap}header strong{flex:1}form{padding:20px 24px;display:flex;gap:8px}input{min-width:0;max-width:460px;flex:1;padding:10px}button{padding:10px 16px}section{display:grid;grid-template-columns:240px minmax(0,780px);gap:32px;max-width:1120px;padding:0 24px 40px;margin:auto}nav{display:flex;flex-direction:column;gap:8px}nav a{padding:8px;border-radius:6px;text-decoration:none}nav a[aria-current]{background:#4499cc25;font-weight:600}article{min-width:0;overflow-wrap:anywhere}article h1{margin-top:0;font-size:1.8rem}article h2{margin-top:1.8em;font-size:1.25rem}li{margin:8px 0}pre{overflow:auto;padding:16px;background:#8882}code{font-size:.9em}.cards{display:grid;gap:16px}.card{border:1px solid #8885;border-radius:10px;padding:16px}.card h2{margin:0}.muted{opacity:.75}footer{margin-top:28px;border-top:1px solid #8885;padding-top:16px}@media(max-width:700px){section{display:block;padding:0 16px 28px}nav{flex-direction:row;flex-wrap:wrap;margin-bottom:24px;gap:4px}nav a{font-size:14px}header,form{padding:16px}article h1{font-size:1.5rem}}
</style></head><body><header><strong><a href="/handbook">Reverie handbook</a></strong><a href="/" target="_top">Back to chat</a></header><form action="/handbook" method="get" role="search"><input name="q" aria-label="Search handbook" placeholder="Search the handbook" value="${escapeHtml(query)}" maxlength="200"><button type="submit">Search</button></form><section><nav aria-label="Handbook pages">${nav}</nav><article>${body}<footer class="muted">Shared operational guidance. Your current permissions and owner choices still apply. <a href="/api/handbook">Agent API index</a></footer></article></section></body></html>`;
}

export function registerHandbookRoutes(
  app: FastifyInstance,
  dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'handbook')
): void {
  const metadata = (p: (typeof HANDBOOK_PAGES)[number]) => ({
    ...p,
    url: '/handbook/' + p.slug,
    apiUrl: '/api/handbook/' + p.slug,
    markdownUrl: '/handbook/' + p.slug + '.md',
  });
  const read = async (slug: string) => {
    const entry = HANDBOOK_PAGES.find((p) => p.slug === slug);
    return entry ? { ...metadata(entry), markdown: await readFile(join(dir, entry.slug + '.md'), 'utf8') } : undefined;
  };
  const missing = (reply: FastifyReply) => reply.code(404).send({ success: false, error: 'Handbook page not found' });
  const unavailable = (reply: FastifyReply) =>
    reply.code(503).send({ success: false, error: 'The packaged handbook is unavailable' });
  const html = (reply: FastifyReply, content: string) =>
    reply
      .type('text/html; charset=utf-8')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"
      )
      .send(content);
  app.addHook('onRequest', async (req, reply) => {
    if (/^\/(?:api\/)?handbook(?:\/|\?|$)/.test(req.url)) reply.header('Cache-Control', 'no-store');
  });
  app.get('/api/handbook', async () => ({
    success: true,
    data: { title: 'Reverie handbook', url: '/handbook', pages: HANDBOOK_PAGES.map(metadata) },
  }));
  app.get('/api/handbook/:slug', async (req, reply) => {
    try {
      const result = await read((req.params as { slug: string }).slug);
      return result ? { success: true, data: result } : missing(reply);
    } catch {
      return unavailable(reply);
    }
  });
  app.get('/handbook', async (req, reply) => {
    const query = (req.query as { q?: unknown }).q;
    if (query !== undefined && (typeof query !== 'string' || query.length > 200))
      return reply.code(400).send({ success: false, error: 'Search must be at most 200 characters' });
    try {
      const documents = await Promise.all(HANDBOOK_PAGES.map((p) => read(p.slug)));
      const matches = documents.filter(
        (p) =>
          p && (!query || (p.title + ' ' + p.summary + ' ' + p.markdown).toLowerCase().includes(query.toLowerCase()))
      );
      const cards = matches
        .map(
          (p) =>
            `<div class="card"><h2><a href="${p!.url}">${escapeHtml(p!.title)}</a></h2><p>${escapeHtml(p!.summary)}</p></div>`
        )
        .join('');
      return html(
        reply,
        page(
          'Office handbook',
          '<h1>Office handbook</h1><p>How to work in Reverie, recover a laptop and check what you are allowed to do.</p><div class="cards">' +
            (cards || '<p>No matching pages.</p>') +
            '</div>',
          '',
          query ?? ''
        )
      );
    } catch {
      return unavailable(reply);
    }
  });
  app.get('/handbook/:slug.md', async (req, reply) => {
    try {
      const result = await read((req.params as { slug: string }).slug);
      return result ? reply.type('text/markdown; charset=utf-8').send(result.markdown) : missing(reply);
    } catch {
      return unavailable(reply);
    }
  });
  app.get('/handbook/:slug', async (req, reply) => {
    try {
      const result = await read((req.params as { slug: string }).slug);
      return result
        ? html(reply, page(result.title, renderHandbookMarkdown(result.markdown), result.slug))
        : missing(reply);
    } catch {
      return unavailable(reply);
    }
  });
}
