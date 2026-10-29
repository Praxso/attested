// Covers the fail-closed --target-url rule. Needs `pnpm build` first (runs the committed launcher).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attested.js');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'attested-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  // Fake test command: writes a CTRF report and a marker proving it executed.
  writeFileSync(join(dir, 'fake-test.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('attested', { recursive: true });
writeFileSync('attested/ctrf.json', JSON.stringify({ results: { tool: { name: 'fake' }, summary: { tests: 1, passed: 1, failed: 0 }, tests: [{ name: 't', status: 'passed' }] } }));
writeFileSync('ran', '1');
`);
  return { dir, head: git('rev-parse', 'HEAD') };
}

function serve(body) {
  let hits = 0;
  const server = createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, hits: () => hits, close: () => server.close() })));
}

// Async so the in-process health server can answer while the CLI runs.
function run(dir, extra) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [BIN, 'run', '--allow-dirty', ...extra, '--', process.execPath, 'fake-test.mjs'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => ok({ code, stderr, ran: existsSync(join(dir, 'ran')) }));
  });
}

test('without --target-url no probe runs and tests execute', async () => {
  const { dir } = makeRepo();
  const s = await serve('{}');
  const r = await run(dir, []);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.ran, true);
  assert.equal(s.hits(), 0);
  const receipt = JSON.parse(readFileSync(join(dir, 'attested/receipt.json'), 'utf8'));
  assert.deepEqual(receipt.predicate.target, { buildSha: null, url: null });
  assert.equal('signed' in receipt, false);
});

test('matching build sha passes and is recorded', async () => {
  const { dir, head } = makeRepo();
  const s = await serve(JSON.stringify({ ok: true, sha: head }));
  const r = await run(dir, ['--target-url', s.url]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.ran, true);
  assert.equal(s.hits(), 1);
  const receipt = JSON.parse(readFileSync(join(dir, 'attested/receipt.json'), 'utf8'));
  assert.equal(receipt.predicate.target.buildSha, head);
  assert.equal(receipt.predicate.target.url, s.url);
});

test('target metadata is allowlisted: no health body, no URL query, nothing secret-shaped', async () => {
  const { dir, head } = makeRepo();
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const s = await serve(JSON.stringify({ sha: head, env: { GITHUB_TOKEN: SECRET }, admin: 'a@b.example' }));
  const r = await run(dir, ['--target-url', `${s.url}/?token=${SECRET}#x`]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(join(dir, 'attested/receipt.json'), 'utf8');
  assert.equal(text.includes('ghp_'), false);
  assert.equal(text.includes('a@b.example'), false);
  const { target } = JSON.parse(text).predicate;
  assert.deepEqual(target, { buildSha: head, url: `${s.url}/`, health: { probed: `${s.url}/healthz`, status: 200 } });
});

test('mismatched build sha fails before tests', async () => {
  const { dir } = makeRepo();
  const s = await serve(JSON.stringify({ sha: '0000000000000000000000000000000000000000' }));
  const r = await run(dir, ['--target-url', s.url]);
  s.close();
  assert.equal(r.code, 2);
  assert.equal(r.ran, false);
  assert.match(r.stderr, /is built from 0{40}, expected [0-9a-f]{40}; refusing to run tests/);
});

test('missing build sha fails before tests', async () => {
  const { dir } = makeRepo();
  const s = await serve(JSON.stringify({ ok: true }));
  const r = await run(dir, ['--target-url', s.url]);
  s.close();
  assert.equal(r.code, 2);
  assert.equal(r.ran, false);
  assert.match(r.stderr, /did not report a build sha/);
});

test('unreachable target fails before tests', async () => {
  const { dir } = makeRepo();
  const s = await serve('{}');
  const url = s.url;
  s.close();
  await new Promise((ok) => setTimeout(ok, 50));
  const r = await run(dir, ['--target-url', url]);
  assert.equal(r.code, 2);
  assert.equal(r.ran, false);
  assert.match(r.stderr, /is unreachable/);
});

test('--expect-sha wins over HEAD as the expected build sha', async () => {
  const { dir, head } = makeRepo();
  const s = await serve(JSON.stringify({ sha: head }));
  const r = await run(dir, ['--expect-sha', head, '--target-url', s.url]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
});
