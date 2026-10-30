import { describe, expect, it } from 'vitest';
import { inlineVideoType } from '../src/chatroom-files.js';

const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('inline chat video', () => {
  it('serves a declared MP4 or WebM inline only when the bytes are that container', () => {
    expect(inlineVideoType('video/mp4', bytes([0, 0, 0, 0x20], 'ftypisom'))).toBe('video/mp4');
    expect(inlineVideoType('VIDEO/WEBM', bytes([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0]))).toBe('video/webm');
  });
  it('serves a declared QuickTime clip inline when it opens on a QuickTime atom (iPhone .mov opens on ftyp qt)', () => {
    expect(inlineVideoType('video/quicktime', bytes([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 0, 0]))).toBe('video/quicktime');
    for (const atom of ['moov', 'mdat', 'wide', 'free', 'skip'])
      expect(inlineVideoType('Video/QuickTime', bytes([0, 0, 0, 8], atom, [0, 0, 0, 0]))).toBe('video/quicktime');
  });
  it('keeps a QuickTime declaration a download when the bytes are not QuickTime or too short', () => {
    expect(inlineVideoType('video/quicktime', bytes('<html><script>'))).toBeNull();
    expect(inlineVideoType('video/quicktime', bytes([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(inlineVideoType('video/quicktime', bytes([0, 0, 0, 0x14], 'ftyp'))).toBeNull(); // under the 12 sniffed bytes
    expect(inlineVideoType('video/quicktime', bytes([0, 0, 0, 8], 'MOOV', [0, 0, 0, 0]))).toBeNull(); // atom types are exact
  });
  it('keeps mismatched, truncated or other declared types a download', () => {
    expect(inlineVideoType('video/mp4', bytes('<html><script>'))).toBeNull();
    expect(inlineVideoType('video/webm', bytes([0, 0, 0, 0x20], 'ftypisom'))).toBeNull();
    expect(inlineVideoType('video/mp4', bytes([0, 0, 0, 0x20], 'ft'))).toBeNull();
    expect(inlineVideoType('text/html', bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
  });
});
