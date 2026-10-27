/** Packaged office handbook: one Markdown source for humans and scoped agents. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HANDBOOK_PAGES = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    summary: 'Sign in, connect a plan, hire an expert and begin a conversation.',
  },
  {
    slug: 'profiles',
    title: 'Profiles and reporting lines',
    summary: 'Edit roles, working style, appearance and reporting relationships.',
  },
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
    slug: 'operations',
    title: 'Capabilities, deployments and credentials',
    summary:
      'Check current grants, file Board requests, restart or deploy the website, and locate named GitHub credentials.',
  },
  {
    slug: 'memory',
    title: 'Channels and long-term memory',
    summary: 'Read current channels, recall source-backed history and keep private and project memory separate.',
  },
  {
    slug: 'previews',
    title: 'Laptop previews',
    summary: 'Open agent web pages over HTTPS on separate secure addresses.',
  },
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
    slug: 'plugins',
    title: 'Optional chat plugins',
    summary: 'Enable math previews and local Python or Modelica snippet assistance.',
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
  const activeGuide = HANDBOOK_PAGES.find((p) => p.slug === active)?.title || 'All guides';
  const nav = HANDBOOK_PAGES.map(
    (p) => `<a href="/handbook/${p.slug}"${p.slug === active ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Reverie handbook</title><style>
:root{color-scheme:light dark;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;color:light-dark(#20232a,#e6e9ef);background:light-dark(#fafafa,#11151b)}
a{color:light-dark(#1459a3,#78c9ff)}
header{border-bottom:1px solid #8885}
.masthead{max-width:1120px;padding:16px 24px;display:flex;gap:24px;flex-wrap:wrap}
.masthead strong{flex:1}
.handbook-layout{display:grid;grid-template-columns:224px minmax(0,780px);gap:32px;max-width:1120px;padding:24px 24px 40px}
nav{display:flex;flex-direction:column;gap:4px;min-width:0;align-self:start}
nav a{padding:8px 12px;border-radius:6px;text-decoration:none}
nav a[aria-current]{background:#4499cc25;font-weight:600}
aside,main,article{min-width:0}
.guide-picker{display:none}
.guide-picker summary{cursor:pointer;padding:12px 14px;border:1px solid #8885;border-radius:8px;list-style:none}
.guide-picker summary::-webkit-details-marker{display:none}
.guide-picker summary::after{content:'';float:right;width:8px;height:8px;border-right:1.5px solid;border-bottom:1.5px solid;transform:rotate(45deg);margin:-20px 2px 0 0}
.guide-picker[open] summary::after{transform:rotate(225deg)}
.guide-picker summary span{display:block;font-size:12px;opacity:.7}
.guide-picker summary strong{font-size:15px;font-weight:600}
.guide-picker nav{padding:8px 0;margin-top:4px;border:1px solid #8885;border-radius:8px}
form{display:flex;gap:8px;margin:0 0 24px}
input{min-width:0;flex:1;padding:10px;font:inherit}
button{padding:10px 16px;font:inherit}
article{overflow-wrap:anywhere}
article h1{margin-top:0;font-size:1.8rem;line-height:1.3}
article h2{margin-top:1.8em;font-size:1.25rem}
li{margin:8px 0}
pre{overflow:auto;padding:16px;background:#8882}
code{font-size:.9em}
.cards{display:grid;gap:16px}
.card{border:1px solid #8885;border-radius:10px;padding:16px}
.card h2{margin:0}
.muted{opacity:.75}
footer{margin-top:28px;border-top:1px solid #8885;padding-top:16px}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}
@media(max-width:900px){
.masthead{padding:16px;gap:16px}
.masthead a{display:inline-flex;align-items:center;min-height:44px}
.handbook-layout{display:block;padding:16px 16px 28px;max-width:812px}
.desktop-guides{display:none}
.guide-picker{display:block;margin-bottom:20px}
nav a{white-space:normal;overflow-wrap:anywhere;font-size:14px;min-height:44px}
article h1{font-size:1.5rem}
}
</style></head><body><header><div class="masthead"><strong><a href="/handbook">Reverie handbook</a></strong><a href="/" target="_top">Back to chat</a></div></header><div class="handbook-layout"><aside><nav class="desktop-guides" aria-label="Handbook pages">${nav}</nav><details class="guide-picker"><summary aria-label="Choose handbook guide"><span>Guide</span><strong>${escapeHtml(activeGuide)}</strong></summary><nav aria-label="Choose a guide">${nav}</nav></details></aside><main><form action="/handbook" method="get" role="search"><input name="q" aria-label="Search handbook" placeholder="Search the handbook" value="${escapeHtml(query)}" maxlength="200"><button type="submit">Search</button></form><article>${body}<footer class="muted">Shared operational guidance. Your current permissions and owner choices still apply. <a href="/api/handbook">Agent API index</a></footer></article></main></div></body></html>`;
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
