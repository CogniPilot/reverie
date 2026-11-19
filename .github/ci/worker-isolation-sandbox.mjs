/** Qualify fixed workloads in disposable containers from an exact image ID. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
assert.match(image ?? '', /^sha256:[0-9a-f]{64}$/);
assert.equal(process.argv.length, 3);
const workload = fileURLToPath(new URL('worker-isolation-workload.mjs', import.meta.url));

function docker(args, input) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, input }).trim();
}

function disposable(mode, limits, check) {
  const id = docker([
    'create', '--pull=never', '--network=none', '--read-only', '--user=2000:2000',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--init',
    '--mount', `type=bind,source=${workload},target=/workload.mjs,readonly`,
    '--entrypoint=/bin/node', ...limits, image, '/workload.mjs', mode,
  ]);
  assert.match(id, /^[0-9a-f]{64}$/);
  try {
    check(id);
  } finally {
    docker(['rm', '--force', id]);
  }
}

disposable('http', ['--memory=128m', '--pids-limit=32'], (id) => {
  docker(['start', id]);
  const check = `
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const paths = ['/', '/api/company'];
        const responses = await Promise.all(paths.map(path =>
          fetch('http://127.0.0.1:3000' + path, {signal: AbortSignal.timeout(2000)})));
        console.log(JSON.stringify(responses.map(response => response.status)));
        process.exit(0);
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    process.exit(1);
  `;
  assert.deepEqual(JSON.parse(docker(['exec', id, '/bin/node', '--input-type=module', '-e', check])), [200, 404]);
  console.log('PASS isolated HTTP routes');
});

disposable('tasks', ['--interactive', '--memory=128m', '--pids-limit=32'], (id) => {
  const output = docker(['start', '--attach', '--interactive', id], 'start\nstop\n');
  assert.match(output, /(?:^|\n)PRESSURE_READY(?:\n|$)/);
  assert.match(output, /(?:^|\n)TASK_LIMIT_REACHED(?:\n|$)/);
  assert.equal(docker(['inspect', '--format={{.State.ExitCode}}', id]), '0');
  console.log('PASS task limit and child reaping');
});

disposable('memory', ['--memory=128m', '--memory-swap=128m', '--pids-limit=32'], (id) => {
  docker(['start', id]);
  assert.equal(docker(['wait', id]), '137');
  assert.equal(docker(['inspect', '--format={{.State.OOMKilled}}', id]), 'true');
  console.log('PASS kernel memory limit');
});
