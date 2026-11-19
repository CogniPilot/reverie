/** Fixed synthetic workloads for the disposable worker isolation test. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const MIB = 1024 * 1024;

function serve() {
  const server = createServer((request, response) => {
    response.statusCode = request.url === '/' ? 200 : 404;
    response.end();
  });
  server.listen(3000, '0.0.0.0');
}

function pressureTask() {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  const closed = new Promise((resolve) => child.once('close', resolve));
  return { child, closed, started: once(child, 'spawn') };
}

async function requireInput(lines) {
  if ((await lines.next()).done) throw new Error('Worker isolation test input closed early');
}

async function exhaustTasks() {
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  const active = [];
  try {
    console.log('PRESSURE_READY');
    await requireInput(lines);
    for (let attempt = 0; attempt < 96; attempt++) {
      const task = pressureTask();
      try {
        await task.started;
        active.push(task);
      } catch (error) {
        await task.closed;
        if (error.code !== 'EAGAIN') throw error;
        if (active.length === 0) throw new Error('Worker had no capacity before task pressure');
        console.log('TASK_LIMIT_REACHED');
        await requireInput(lines);
        return;
      }
    }
    throw new Error('Worker task limit was not reached');
  } finally {
    input.close();
    for (const { child } of active) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(active.map(({ closed }) => closed));
  }
}

function exhaustMemory() {
  const retained = [];
  for (let attempt = 0; attempt < 24; attempt++) {
    // A nonzero fill touches the pages. An untouched reservation would not
    // test the kernel memory limit.
    retained.push(Buffer.alloc(32 * MIB, 0x5a));
  }
  throw new Error(`Worker survived ${retained.length * 32} MiB of resident allocations`);
}

switch (process.argv[2]) {
  case 'http':
    serve();
    break;
  case 'tasks':
    await exhaustTasks();
    break;
  case 'memory':
    exhaustMemory();
    break;
  default:
    throw new Error('Expected http, tasks, or memory workload');
}
