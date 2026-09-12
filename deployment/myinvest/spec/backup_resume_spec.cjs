const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const deployment = path.resolve(__dirname, '..');

function runBackup(t, failUnpause = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-backup-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scripts = path.join(dir, 'scripts');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(scripts);
  fs.mkdirSync(bin);
  for (const name of ['backup.sh', 'resume-services.sh']) {
    if (fs.existsSync(path.join(deployment, 'scripts', name))) {
      fs.copyFileSync(path.join(deployment, 'scripts', name), path.join(scripts, name));
    }
  }
  fs.writeFileSync(path.join(dir, '.env'), `LOCAL_SMOKE=true\nBACKUP_DIR=${dir}/backups\n`);
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.FAKE_DOCKER_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {
  paused: { rails: false, sidekiq: false, 'claude-agent': false, redis: false, minio: false },
  attempts: {},
};
const args = process.argv.slice(2);
const command = args.find(value => ['pause', 'unpause', 'run', 'ps', 'inspect'].includes(value));
const tail = args.slice(args.indexOf(command) + 1);
let code = 0;
if (command === 'pause') for (const service of tail) state.paused[service] = true;
if (command === 'run') code = 37; // Fault after pausing, before snapshot creation.
if (command === 'ps') console.log(tail.at(-1));
if (command === 'inspect') console.log('true ' + state.paused[tail.at(-1)]);
if (command === 'unpause') {
  if (tail.length > 1) {
    // Compose resumes parents, then aborts on the already-running Redis/MinIO.
    state.paused.rails = state.paused.sidekiq = false;
    code = 1;
  } else {
    const service = tail[0];
    state.attempts[service] = (state.attempts[service] || 0) + 1;
    if (!state.paused[service] || (service === 'claude-agent' && state.attempts[service] <= Number(process.env.FAIL_UNPAUSE))) code = 1;
    else state.paused[service] = false;
  }
}
fs.writeFileSync(file, JSON.stringify(state));
process.exitCode = code;
`, { mode: 0o700 });
  const result = spawnSync('bash', [path.join(scripts, 'backup.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: dir,
      ENV_FILE: path.join(dir, '.env'), FAKE_DOCKER_STATE: path.join(dir, 'state.json'),
      FAIL_UNPAUSE: String(failUnpause) },
    encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  return { result, state: JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))) };
}

test('backup failure resumes the agent even when Redis and MinIO are already running', t => {
  const { result, state } = runBackup(t);
  assert.equal(result.status, 37, 'preserve the original snapshot failure');
  assert.equal(state.paused['claude-agent'], false);
  assert.ok(Object.values(state.paused).every(value => value === false));
  assert.equal(state.attempts.redis, undefined, 'do not unpause an already-running container');
  assert.equal(state.attempts.minio, undefined);
});

test('a transient resume failure is retried and verified', t => {
  const { result, state } = runBackup(t, 1);
  assert.equal(result.status, 37);
  assert.equal(state.paused['claude-agent'], false);
  assert.equal(state.attempts['claude-agent'], 2);
});

test('a persistent resume failure is visible and does not prevent other services resuming', t => {
  const { result, state } = runBackup(t, 100);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claude-agent.*(paused|resume)/i);
  assert.equal(state.paused.rails, false);
  assert.equal(state.paused.sidekiq, false);
  assert.equal(state.attempts['claude-agent'], 3);
});
