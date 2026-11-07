// Real fixed per-task userspace perf workload. No host setup, installation,
// configuration change, privileged container, extra capability or shell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const workload = 'const end=process.hrtime.bigint()+750000000n;let n=1;while(process.hrtime.bigint()<end){for(let i=1;i<10000;i++)n=Math.imul(n+i,i)|0;}process.stdout.write(String(n));';
export function guestFor(purpose) {
  assert.ok(purpose === 'image' || purpose === 'laptop');
  const nnp = purpose === 'image' ? "assert.match(status,/^NoNewPrivs:\\s*1$/m,'strict image fixture requires no-new-privileges');" : '';
  return `
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), cp=require('node:child_process');
assert.ok(process.getuid()>0,'perf workload must run as the actual nonroot laptop user');
const status=fs.readFileSync('/proc/self/status','utf8');
const capability=(key)=>{const line=status.split('\\n').find(line=>line.startsWith(key+':'));assert.ok(line,'missing '+key);return BigInt('0x'+line.slice(key.length+1).trim());};
for(const key of ['CapEff','CapPrm'])assert.equal(capability(key),0n,key+' must be empty');
assert.match(status,/^Seccomp:\\s*2$/m,'seccomp filter must be active');
const bound=capability('CapBnd');assert.equal(bound&((1n<<19n)|(1n<<21n)|(1n<<38n)),0n,'ptrace/admin/perfmon must not be available in the bounding set');
${nnp}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-perf-'));
const invoke=(args)=>{const r=cp.spawnSync('perf',args,{cwd:dir,env:{...process.env,HOME:dir,XDG_CACHE_HOME:dir},encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.ifError(r.error);assert.equal(r.status,0,'perf '+args[0]+' failed: '+r.stderr);return r;};
try{
 invoke(['--version']);
 const stats=path.join(dir,'stat.csv'), data=path.join(dir,'perf.data');
 invoke(['stat','--no-big-num','-x,','--output',stats,'--event','task-clock:u','--',process.execPath,'-e',${JSON.stringify(workload)}]);
 const text=fs.readFileSync(stats,'utf8');assert.doesNotMatch(text,/<not (counted|supported)>/);assert.match(text,/task-clock:u/);assert.ok(text.split('\\n').some(line=>Number(line.split(',')[0])>0),'no positive task-clock count');
 invoke(['record','--quiet','--mmap-pages','64','--freq','99','--event','task-clock:u','--output',data,'--',process.execPath,'-e',${JSON.stringify(workload)}]);
 const report=invoke(['report','--stdio','--header','--input',data]);
 assert.match(report.stdout,/task-clock:u/);assert.match(report.stdout,/# Samples:\\s*[1-9]/,'record/report must contain actual samples');
 process.stdout.write(JSON.stringify({perf:'passed',uid:process.getuid(),event:'task-clock:u',stat:true,record:true,report:true})+'\\n');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
`;
}

function docker(args, timeout = 60000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
export function imageArguments(image, profile, identity = '2000:2000') {
  assert.ok(image && !image.startsWith('-') && !image.includes('\0'), 'image reference required');
  assert.ok(profile.startsWith('/nix/store/') && !profile.includes('\0'), 'verified generated Nix policy required');
  assert.match(identity, /^[1-9]\d*:[1-9]\d*$/, 'Nix image must declare a nonroot numeric uid:gid');
  const [uid, gid] = identity.split(':');
  return ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', identity,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${profile}`,
    '--pids-limit', '64', '--memory', '512m', '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=64m,uid=${uid},gid=${gid},mode=0700`,
    '--entrypoint', 'node', image, '-e', guestFor('image')];
}
function inventory(deployment) {
  const output = docker(['ps', '--quiet', '--no-trunc', '--filter', `label=reverie.worker=${deployment}`, '--filter', 'label=reverie.session']);
  const ids = output.trim() ? output.trim().split('\n').sort() : [];
  for (const id of ids) assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}
export function restricted(row, deployment) {
  assert.equal(row.State.Running, true, 'laptop stopped during acceptance');
  assert.equal(row.Config.Labels['reverie.worker'], deployment);
  assert.match(row.Config.Labels['reverie.session'], /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.equal(row.HostConfig.Privileged, false, 'privileged laptops do not qualify');
  assert.ok(!row.HostConfig.PidMode, 'host/shared PID namespace does not qualify');
  assert.ok(!(row.HostConfig.CapAdd ?? []).some(cap => /^(?:CAP_)?(?:PERFMON|SYS_ADMIN|SYS_PTRACE|ALL)$/i.test(cap)), 'broad capability does not qualify');
  assert.ok(!(row.HostConfig.SecurityOpt ?? []).some(option => /^(?:seccomp|apparmor)[=:]unconfined$/i.test(option)), 'unconfined seccomp/AppArmor does not qualify');
  // Canonical rootless laptops intentionally permit systempaths=unconfined
  // and omit NNP for their fixed ID helpers. Kernel caps/seccomp are checked
  // in the actual process; this acceptance adds no replacement launch policy.
}
function inspect(id) {
  const rows = JSON.parse(docker(['inspect', id]));
  assert.equal(rows.length, 1); assert.equal(rows[0].Id, id);
  return rows[0];
}
export function main(args) {
  if (args.length === 4 && args[0] === '--image' && args[2] === '--profile') {
    const images = JSON.parse(docker(['image', 'inspect', args[1]]));
    assert.equal(images.length, 1); assert.match(images[0].Id, /^sha256:[0-9a-f]{64}$/);
    process.stdout.write(docker(imageArguments(images[0].Id, args[3], images[0].Config.User)));
    return;
  }
  assert.ok(args.length === 2 && args[0] === '--deployment', 'use cargo xtask verify-worker-perf');
  const deployment = args[1];
  assert.ok(deployment.length > 0 && deployment.length <= 128 && !deployment.includes('\0'));
  const before = inventory(deployment);
  assert.ok(before.length > 0, 'no running laptops; all-laptop acceptance is unproved');
  const failures = [];
  for (const id of before) {
    try {
      const original = inspect(id); restricted(original, deployment);
      const result = docker(['exec', id, 'node', '-e', guestFor('laptop')]);
      const after = inspect(id); restricted(after, deployment);
      assert.equal(after.State.Pid, original.State.Pid, 'laptop restarted during acceptance');
      assert.equal(after.Image, original.Image);
      process.stdout.write(JSON.stringify({containerId: id, ...JSON.parse(result.trim())}) + '\n');
    } catch (error) {
      failures.push(id); process.stderr.write(`${id}: ${error.message}\n`);
    }
  }
  assert.deepEqual(inventory(deployment), before, 'running laptop inventory changed during acceptance');
  assert.equal(failures.length, 0, `${failures.length}/${before.length} running laptops failed real perf; no laptop was installed, restarted or reconfigured`);
}
if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2));
