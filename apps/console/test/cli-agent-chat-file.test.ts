/**
 * `reverie agent chat say --file`: each file is uploaded raw into the room, then the
 * message names the uploaded ids.
 */
import { describe, expect, it } from 'vitest';
import { agentChatSay, guessContentType, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

describe('agent chat say --file', () => {
  it('uploads each file raw, then posts the message with the attachment ids', async () => {
    const calls: RequestOptions[] = [];
    const deps: AgentDeps = {
      ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
      json: false,
      io: { out: () => {}, err: () => {} },
      request: async (_ctx, options) => {
        calls.push(options);
        if (options.path === '/api/v1/chatrooms' && options.method === 'GET') {
          return {
            status: 200,
            text: '',
            json: { success: true, data: { rooms: [{ id: 'room-1', name: 'Reverie', members: [] }] } },
          };
        }
        if (options.path.endsWith('/files')) {
          return { status: 200, text: '', json: { success: true, data: { file: { id: `f${calls.length}` } } } };
        }
        return { status: 200, text: '', json: { success: true, data: { message: {} } } };
      },
    };
    const code = await agentChatSay(deps, {
      text: '',
      to: 'user',
      files: ['/tmp/out/plot.png', '/tmp/out/run.log'],
      readFile: async (p) => Buffer.from(p),
    });
    expect(code).toBe(0);
    const uploads = calls.filter((c) => c.path.endsWith('/files'));
    expect(uploads.map((u) => u.query)).toEqual([
      { name: 'plot.png', type: 'image/png' },
      { name: 'run.log', type: 'text/plain' },
    ]);
    expect(uploads[0].rawBody?.toString()).toBe('/tmp/out/plot.png');
    const post = calls.at(-1)!;
    expect(post.path).toBe('/api/v1/chatrooms/room-1/messages');
    // a --to is never sent: a post always goes to everyone
    expect(post.body).toEqual({ text: '', attachments: ['f2', 'f3'] });
  });

  it('guesses an image type so the room shows it inline', () => {
    expect(guessContentType('a.JPG')).toBe('image/jpeg');
    expect(guessContentType('a.weird')).toBe('application/octet-stream');
  });
});
