/**
 * @fileoverview Which video a browser may be handed to play inline. The declared type is only trusted when the bytes
 * really start like that container, so nothing else (HTML, SVG, a script) is ever served under a playable type. Shared by
 * chat attachments (chatroom-routes) and workspace file previews (workspace-files).
 */

/** Top-level atoms a QuickTime file can open on (the same set the session upload check accepts for `.mov`). */
const QUICKTIME_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);

/** Bytes a video player needs before it can show a first frame and a play button. */
export const VIDEO_SNIFF_BYTES = 12;

/** The declared type of each video extension in VIDEO_ATTACHMENT_EXTENSIONS (attachment-registry; pinned equal in tests). */
export const VIDEO_EXTENSION_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
};

/**
 * The video type to serve inline, or null to keep the file a download. The type is only trusted when the file starts like
 * that container: an MP4 `ftyp` box (M4V is the same container and is served as video/mp4), a QuickTime top-level atom
 * (iPhone `.mov` clips open on `ftyp`; older QuickTime files can open on another atom), the WebM/EBML magic, or an Ogg
 * page. Movies then play where they are clicked instead of forcing a download. Whether a clip
 * decodes is the browser's: Safari plays iPhone HEVC, other browsers may not, and the page falls back to a download.
 */
export function inlineVideoType(type: string, head: Uint8Array): string | null {
  const declared = type.toLowerCase();
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if ((declared === 'video/mp4' || declared === 'video/x-m4v') && head.length >= 12 && ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (declared === 'video/quicktime' && head.length >= 12 && QUICKTIME_ATOMS.has(ascii(4, 8))) return 'video/quicktime';
  if (declared === 'video/webm' && head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
    return 'video/webm';
  if (declared === 'video/ogg' && head.length >= 4 && ascii(0, 4) === 'OggS') return 'video/ogg';
  return null;
}
