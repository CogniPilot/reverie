/** Test port for preserved SDK/Input components, not native ownership/image acceptance. */
import {createServer, type Socket} from 'node:net';
import {parseArgs} from 'node:util';
import {AttachmentFrames, AttachmentInput} from '../../scripts/operator-viewer-input.js';
import {loadAttachmentPty, type AttachmentPty} from '../../scripts/operator-viewer-pty.js';
import {attachRequest, currentAsync, validateTarget, type Target} from '../../scripts/operator-viewer-bridge.js';

const v = parseArgs({options: {'session-id': {type: 'string'}, 'container-id': {type: 'string'}, 'started-at': {type: 'string'},
  pid: {type: 'string'}, socket: {type: 'string'}}, strict: true}).values;
const target: Target = {sessionId: v['session-id']!, containerId: v['container-id']!, startedAt: v['started-at']!,
  pid: Number(v.pid), socket: v.socket!};
validateTarget(target);
const originalPane = await currentAsync(target), spawnAttachment = loadAttachmentPty();
const sockets = new Set<Socket>();
const server = createServer(socket => {
  sockets.add(socket);
  let child: AttachmentPty | undefined, input: AttachmentInput | undefined, started = false, stopped = false;
  const send = (kind: string, bytes: Buffer) => {
    if (socket.destroyed || stopped) return;
    const header = Buffer.alloc(5); header[0] = kind.charCodeAt(0); header.writeUInt32BE(bytes.length, 1);
    socket.write(Buffer.concat([header, bytes]));
  };
  const stop = () => {stopped = true; input?.stop(); child?.close();};
  const fail = () => {send('E', Buffer.from('LEGACY_COMPONENT_REFUSED')); stop(); socket.end();};
  socket.on('error', () => {});
  socket.on('close', () => {sockets.delete(socket); stop();});
  const frames = new AttachmentFrames((kind, bytes) => {
    if (stopped) throw new Error('Legacy component stopped');
    if (!started) {
      const size = attachRequest(target, kind, bytes); started = true;
      void currentAsync(target).then(pane => {
        if (stopped || socket.destroyed || pane !== originalPane) throw new Error('Original legacy fixture changed');
        child = spawnAttachment(target.containerId, size.cols, size.rows,
          output => send('O', output), () => {input?.stop(); socket.end();});
        const original = child;
        input = new AttachmentInput({live: () => !stopped && !socket.destroyed && child === original && original.live(),
          drained: () => original.drained(), probe: async () => {
            if (await currentAsync(target) !== originalPane) throw new Error('Original legacy fixture changed');
          }, write: data => original.write(data), resize: (cols, rows) => original.resize(cols, rows), fail});
      }).catch(fail);
    } else if (kind === 73 && input) input.input(bytes);
    else if (kind === 82 && input) {
      const pair: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid legacy resize');
      input.resize(pair[0], pair[1]);
    } else throw new Error('Legacy fixture not ready');
  });
  socket.on('data', bytes => {try {frames.feed(bytes);} catch {fail();}});
});
const close = () => {for (const socket of sockets) socket.destroy(); server.close();};
process.once('SIGTERM', close); process.once('SIGINT', close);
server.listen(target.socket, () => console.log('Operator attachment ready; legacy component fixture only'));
