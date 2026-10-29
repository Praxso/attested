// Covers `attested check`: conclusion mapping, the PR-head target sha, no images, the fork / read-only fallbacks, and
// the printed verify and evidence commands run against the real artifact layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSummary, defaultCheckOptions } from '../dist/check.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attested.js');
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

function workdir(result, event) {
  const dir = mkdtempSync(join(tmpdir(), 'attested-check-'));
  mkdirSync(join(dir, 'attested'));
  const receipt = {
    subject: [{ name: 'ctrf.json', digest: { sha256: 'c'.repeat(64) } }],
    predicate: {
      testResult: { result, passedTests: ['p'], failedTests: result === 'FAILED' ? ['f'] : [], warnedTests: [] },
      source: { commit: MERGE, headCommit: HEAD, dirty: false, ref: 'refs/pull/7/merge' },
      target: { buildSha: null, url: null },
      ctrf: { summary: { tests: 2 } },
    },
  };
  writeFileSync(join(dir, 'attested/receipt.json'), JSON.stringify(receipt));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  return dir;
}

function api(status) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ html_url: 'https://example.test/check/1' }));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

function run(dir, apiUrl) {
  return new Promise((ok) => {
    const env = { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: apiUrl, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_SHA: MERGE, GITHUB_REF: 'refs/pull/7/merge', GITHUB_RUN_ID: '42', GITHUB_STEP_SUMMARY: '' };
    const child = spawn(process.execPath, [BIN, 'check', '--artifact-url', 'https://example.test/artifact', '--artifact-name', 'attested-x'], { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => ok({ code, out }));
  });
}

const prEvent = { pull_request: { head: { sha: HEAD, repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } } };
const forkEvent = { pull_request: { head: { sha: HEAD, repo: { full_name: 'someone/r' } }, base: { repo: { full_name: 'o/r' } } } };

for (const [result, conclusion] of [['PASSED', 'success'], ['FAILED', 'failure'], ['WARNED', 'neutral']]) {
  test(`${result} posts one "attested" check run with conclusion ${conclusion} on the PR head`, async () => {
    const s = await api(201);
    const r = await run(workdir(result, prEvent), s.url);
    s.close();
    assert.equal(r.code, 0, r.out);
    assert.equal(s.calls.length, 1);
    const { url, auth, body } = s.calls[0];
    assert.equal(url, '/repos/o/r/check-runs');
    assert.equal(auth, 'Bearer test-token');
    assert.equal(body.name, 'attested');
    assert.equal(body.head_sha, HEAD);
    assert.equal(body.conclusion, conclusion);
    assert.equal('images' in body.output, false);
    assert.match(body.output.summary, /gh attestation verify attested-receipt\/attested\/ctrf.json --repo o\/r --predicate-type https:\/\/praxso.ai\/attested\/v0.1/);
    assert.match(body.output.summary, /\[workflow artifact\]\(https:\/\/example.test\/artifact\)/);
    // The evidence download names the bundled workflow's results artifact and checks every file against the receipt.
    assert.match(body.output.summary, /gh run download 42 --repo o\/r --name results-x --dir attested-evidence/);
    assert.match(body.output.summary, /\| shasum -a 256 -c/);
  });
}

test('forked PR prints the summary to the log without calling the API', async () => {
  const s = await api(201);
  const r = await run(workdir('PASSED', forkEvent), s.url);
  s.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(s.calls.length, 0);
  assert.match(r.out, /### attested: PASSED/);
  assert.match(r.out, /::notice title=attested check::forked pull request: GITHUB_TOKEN is read-only/);
});

test('HTTP 403 (read-only token) falls back to the log without failing', async () => {
  const s = await api(403);
  const r = await run(workdir('FAILED', prEvent), s.url);
  s.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /### attested: FAILED/);
  assert.match(r.out, /HTTP 403/);
});

// --- the printed instructions, run end to end against the real two-artifact layout ------------------
// A fake `gh` stands in for the network: `run download` is a no-op over pre-made directories, and `attestation verify`
// prints a canned verification result. jq and shasum are the real ones.

const PREDICATE_TYPE = 'https://praxso.ai/attested/v0.1';
const sha = (text) => createHash('sha256').update(text).digest('hex');

function instructions(receipt) {
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: HEAD, GITHUB_EVENT_PATH: '' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const { summary } = buildSummary(receipt, null, { ...defaultCheckOptions(), artifactName: 'attested-x' });
    return [...summary.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join('');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// A red run as the bundled workflow leaves it: the receipt artifact (ctrf, receipt, packet) and the evidence artifact.
function redRun({ run = '42' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'attested-layout-'));
  const files = {
    'attested-receipt/attested/ctrf.json': '{"results":{"tests":[]}}',
    'attested-receipt/attested/packet.json': '{"result":"FAILED"}',
    'attested-evidence/attested/ctrf.json': '{"results":{"tests":[]}}',
    'attested-evidence/test-results/a b/trace.zip': 'trace',
    'attested-evidence/test-results/a b/shot.png': 'png',
    'attested-evidence/playwright.config.ts': 'export default {}',
  };
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); }
  const artifacts = [
    { path: 'attested/ctrf.json', sha256: sha(files['attested-evidence/attested/ctrf.json']), kind: 'report' },
    { path: 'test-results/a b/shot.png', sha256: sha('png'), kind: 'screenshot' },
    { path: 'test-results/a b/trace.zip', sha256: sha('trace'), kind: 'trace' },
    { path: 'attested/packet.json', sha256: sha(files['attested-receipt/attested/packet.json']), kind: 'packet' },
  ];
  const predicate = {
    testResult: { result: 'FAILED', passedTests: [], failedTests: ['f'], warnedTests: [] },
    source: { commit: HEAD, headCommit: null, dirty: null, ref: 'refs/heads/main' },
    target: { buildSha: null, url: null },
    artifacts,
    ctrf: { summary: { tests: 1 } },
  };
  const receipt = { subject: [{ name: 'ctrf.json', digest: { sha256: artifacts[0].sha256 } }], predicateType: PREDICATE_TYPE, predicate };
  writeFileSync(join(dir, 'attested-receipt/attested/receipt.json'), JSON.stringify(receipt));
  const verified = [{ verificationResult: {
    signature: { certificate: { sourceRepositoryRef: 'refs/heads/main', runInvocationURI: `https://github.com/o/r/actions/runs/${run}/attempts/1` } },
    statement: { predicateType: PREDICATE_TYPE, predicate },
  } }];
  writeFileSync(join(dir, 'verify.json'), JSON.stringify(verified));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), `#!/bin/sh\ncase "$1" in run) exit 0;; attestation) cat "${join(dir, 'verify.json')}";; esac\n`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  return { dir, receipt };
}

function runInstructions(dir, script) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
}

test('the printed evidence check passes on an intact red run: packet from the receipt download, the rest from the evidence download', () => {
  const { dir, receipt } = redRun();
  const r = runInstructions(dir, instructions(receipt));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const p of ['attested/ctrf.json', 'test-results/a b/shot.png', 'test-results/a b/trace.zip', 'attested/packet.json']) assert.match(r.stdout, new RegExp(`${p}: OK`));
});

test('the printed evidence check takes fingerprints from the signed statement: a rewritten receipt.json manifest does not help', () => {
  const { dir, receipt } = redRun();
  // Swap an evidence file and make the downloaded, unsigned receipt.json agree with the swap.
  writeFileSync(join(dir, 'attested-evidence/test-results/a b/shot.png'), 'other png');
  const local = JSON.parse(readFileSync(join(dir, 'attested-receipt/attested/receipt.json'), 'utf8'));
  local.predicate.artifacts.find((a) => a.kind === 'screenshot').sha256 = sha('other png');
  writeFileSync(join(dir, 'attested-receipt/attested/receipt.json'), JSON.stringify(local));
  const r = runInstructions(dir, instructions(receipt));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /shot\.png: FAILED/);
});

test('the printed instructions accept only a statement signed in this run', () => {
  const { dir, receipt } = redRun({ run: '41' });
  const r = runInstructions(dir, instructions(receipt));
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(join(dir, 'attested-statement.json'), 'utf8').trim(), 'null');
});
