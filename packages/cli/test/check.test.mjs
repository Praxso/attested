// Covers `attested check`: conclusion mapping, the PR-head target sha, no images, and the fork / read-only fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const env = { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: apiUrl, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_SHA: MERGE, GITHUB_RUN_ID: '42', GITHUB_STEP_SUMMARY: '' };
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
