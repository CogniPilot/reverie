/**
 * The paired tests' delivery oracle refuses anything but complete, well-formed framing, so a positive case can only
 * pass on the exact bytes the route sent.
 */
import { describe, expect, it } from 'vitest';
import { responseBody, sseBody } from './http-body.js';

const chunked = (body: string) =>
  Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n${body}`, 'latin1');

describe('the paired fixture delivery oracle', () => {
  it('decodes complete chunked framing and passes an identity body through', () => {
    expect(responseBody(chunked('3\r\nabc\r\n0\r\n\r\n')).toString()).toBe('abc');
    expect(responseBody(chunked('3\r\nabc\r\na\r\n0123456789\r\n0\r\n\r\n')).toString()).toBe('abc0123456789');
    expect(responseBody(chunked('A\r\n0123456789\r\n0\r\n\r\n')).toString()).toBe('0123456789');
    expect(responseBody(chunked('0\r\n\r\n')).length).toBe(0);
    expect(responseBody(Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\nabc')).toString()).toBe('abc');
  });

  it.each([
    ['a size line with a valid hex prefix and garbage', '3oops\r\nabc\r\n0\r\n\r\n'],
    ['a chunk extension, which Node never sends', '3;x=1\r\nabc\r\n0\r\n\r\n'],
    ['an empty size line', '\r\nabc\r\n0\r\n\r\n'],
    ['a signed size', '+3\r\nabc\r\n0\r\n\r\n'],
    ['a size line without its CRLF', '3'],
    ['chunk data cut short', '3\r\nab'],
    ['chunk data without its CRLF', '3\r\nabcX0\r\n\r\n'],
    ['a chunk longer than its size', '3\r\nabcd\r\n0\r\n\r\n'],
    ['no terminal chunk', '3\r\nabc\r\n'],
    ['a terminal chunk without the final CRLF', '3\r\nabc\r\n0\r\n'],
    ['a trailer after the terminal chunk', '3\r\nabc\r\n0\r\nx-trailer: 1\r\n\r\n'],
    ['bytes after the terminal framing', '3\r\nabc\r\n0\r\n\r\nextra'],
  ])('refuses %s', (_name, body) => {
    expect(() => responseBody(chunked(body))).toThrow();
  });

  it('refuses a response without the end of its headers', () => {
    expect(() => responseBody(Buffer.from('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n'))).toThrow();
  });

  it('gives exactly the bytes /sse sends', () => {
    expect(sseBody(2, 3)).toBe('data: xxx\n\ndata: xxx\n\n');
    expect(sseBody(0, 3)).toBe('');
  });
});
