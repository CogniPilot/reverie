// Source candidate: call once before importing the application/creating children.
// Fixed installed path; it contains no credential. No inherited FD adoption.
import net from 'node:net';
import fs from 'node:fs';
const PATH = '/run/reverie-owner-terminal/bootstrap.sock';
const READY = Buffer.from('READY\n');
let attempted = false;
export function connectOwnerTerminal() {
  if (attempted) throw new Error('Owner terminal bootstrap cannot reconnect');
  attempted = true;
  return new Promise((resolve, reject) => {
    const connection = net.createConnection({ path: PATH });
    let settled = false, acknowledgement = Buffer.alloc(0);
    let deadlineTimer;
    const refuse = () => {
      if (settled) return;
      settled = true;
      connection.off('data', ready);
      connection.setTimeout(0);
      clearTimeout(deadlineTimer);
      connection.destroy();
      reject(new Error('Owner terminal protected channel unavailable'));
    };
    const ready = (data) => {
      const count = Math.min(READY.length - acknowledgement.length, data.length);
      acknowledgement = Buffer.concat([acknowledgement, data.subarray(0, count)]);
      if (!READY.subarray(0, acknowledgement.length).equals(acknowledgement)) { refuse(); return; }
      if (acknowledgement.length !== READY.length) return;
      // Return a PAUSED socket. Consumer must attach frame/error/end handlers
      // before resume(). Preserve coalesced bytes exactly, never decode/drop.
      connection.pause();
      connection.off('data', ready);
      if (data.length > count) connection.unshift(data.subarray(count));
      connection.setTimeout(0);
      clearTimeout(deadlineTimer);
      settled = true;
      resolve(connection);
    };
    deadlineTimer = setTimeout(refuse, 120000);
    connection.setTimeout(120000, refuse);
    connection.on('error', refuse);
    connection.once('end', refuse);
    connection.once('close', refuse);
    connection.once('connect', () => {
      // On pinned Node/libuv fresh sockets use SOCK_CLOEXEC. Check the actual
      // Linux FD before returning any connected capability to application code.
      connection.pause();
      const fd = connection._handle?.fd;
      try {
        if (!Number.isInteger(fd) || fd < 0) throw new Error();
        const text = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
        const flags = /^flags:\s+([0-7]+)$/m.exec(text);
        if (!flags || !(parseInt(flags[1], 8) & 0o2000000)) throw new Error();
        connection.on('data', ready);
        connection.resume();
      } catch { refuse(); }
    });
  });
}
