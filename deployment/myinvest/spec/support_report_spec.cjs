const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = resolve(__dirname, '../scripts');

function runReport(fail = false, existing = false) {
  const root = mkdtempSync(join(tmpdir(), 'support-report-proof-'));
  const deployment = join(root, 'deployment');
  const home = join(root, 'home');
  mkdirSync(join(deployment, 'scripts'), { recursive: true });
  mkdirSync(home);
  for (const name of ['support-report.sh', 'support-report.cjs']) {
    if (existsSync(join(scripts, name))) copyFileSync(join(scripts, name), join(deployment, 'scripts', name));
  }
  writeFileSync(join(deployment, '.env'), 'CLAUDE_AGENT_DATABASE_URL=postgres://secret-sentinel\nAGENT_LEARNING_CHATWOOT_DATABASE_URL=postgres://secret-sentinel\n');
  writeFileSync(join(root, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$PROOF_ROOT/argv"\nif [ "$2" = logs ]; then printf '%s\\n' '{"event":"agent_answer_failed","detail":"customer-sentinel"}'; exit 0; fi\nif [ "$4" = postgres ]; then echo customer-sentinel; exit 0; fi\nexec node -r "$PROOF_ROOT/pg-stub.cjs" --input-type=commonjs -\n`, { mode: 0o700 });
  writeFileSync(join(root, 'pg-stub.cjs'), `const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
  if (name !== 'pg') return load.call(this, name, ...args);
  return { Pool: class {
    constructor(options) { if (!options.connectionString) throw Error('missing runtime connection'); }
    async query(sql) {
      require('node:fs').appendFileSync(process.env.PROOF_ROOT + '/queries', sql + '\\n');
      if (process.env.PROOF_FAIL === 'true') throw Error('postgres://secret-sentinel customer-sentinel');
      if (/left\\(|question_redacted|SELECT i\\.name/i.test(sql)) return { rows: [{ raw: 'customer-sentinel' }] };
      if (/FROM conversations/.test(sql)) return { rows: [{ account_id: 1, inbox_id: 2, conversations: '3', messages: '5' }] };
      if (/FROM messages/.test(sql)) return { rows: [{ topic: 'Login/Zugang', questions: '7' }] };
      if (/agent_delivery_ledger/.test(sql)) return { rows: [{ status: 'handed_off', deliveries: '11' }] };
      if (/agent_knowledge_candidates/.test(sql)) return { rows: [{ status: 'pending_review', candidates: '13' }] };
      throw Error('unrecognized query');
    }
    async end() {}
  }};
};`);
  const reportName = spawnSync('date', ['+%G-W%V'], { encoding: 'utf8' }).stdout.trim() + '.txt';
  const report = join(home, 'support-reports', reportName);
  if (existing) { mkdirSync(join(home, 'support-reports'), { mode: 0o755 }); writeFileSync(report, 'previous verified report', { mode: 0o644 }); }
  const result = spawnSync('bash', [join(deployment, 'scripts/support-report.sh')], {
    encoding: 'utf8', env: { ...process.env, HOME: home, PATH: root + ':' + process.env.PATH, PROOF_ROOT: root, PROOF_FAIL: String(fail), DATABASE_URL: 'postgres://runtime-agent', CHATWOOT_DATABASE_URL: 'postgres://runtime-readonly' },
  });
  return { root, home, report, result, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('weekly report never puts database credentials on argv or customer text in its artifact', () => {
  const run = runReport(false, true);
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.doesNotMatch(readFileSync(join(run.root, 'argv'), 'utf8'), /secret-sentinel|runtime-agent|runtime-readonly/);
    const content = readFileSync(run.report, 'utf8');
    assert.doesNotMatch(content, /customer-sentinel|secret-sentinel/);
    assert.match(content, /Login\/Zugang.*7/);
    assert.match(content, /handed_off.*11/);
    assert.match(content, /pending_review.*13/);
    assert.equal(statSync(run.report).mode & 0o777, 0o600);
    assert.equal(statSync(join(run.home, 'support-reports')).mode & 0o777, 0o700);
  } finally { run.cleanup(); }
});

test('database failure is nonzero, redacted, preserves last report and removes partial files', () => {
  const run = runReport(true, true);
  try {
    assert.notEqual(run.result.status, 0);
    assert.doesNotMatch(run.result.stdout + run.result.stderr, /secret-sentinel|customer-sentinel/);
    assert.equal(readFileSync(run.report, 'utf8'), 'previous verified report');
    assert.deepEqual(readdirSync(join(run.home, 'support-reports')), [run.report.split('/').pop()]);
    assert.equal(statSync(join(run.home, 'support-reports')).mode & 0o777, 0o700);
  } finally { run.cleanup(); }
});

test('customer text and raw operational log details never enter weekly output', () => {
  const run = runReport();
  try { assert.doesNotMatch(readFileSync(run.report, 'utf8'), /customer-sentinel/); }
  finally { run.cleanup(); }
});
