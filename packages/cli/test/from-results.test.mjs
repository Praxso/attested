// `attested attest --from-results`: the sign job builds the receipt from a downloaded results directory as data,
// with source from the event context, recomputed digests, and no trust in anything the test job wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attested.js');
const MERGE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const OTHER = '/home/runner/work/attested/attested/examples/sample-app'; // the test machine's project root
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text)); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'attested-results-'));
  const r = join(dir, 'results');
  mkdirSync(join(r, 'attested'), { recursive: true });
  mkdirSync(join(r, 'test-results', 't'), { recursive: true });
  writeFileSync(join(r, 'test-results', 't', 'trace.zip'), zip({ '0-trace.trace': JSON.stringify({ type: 'console', messageType: 'error', text: 'boom' }) }));
  writeFileSync(join(r, 'test-results', 't', 'video.webm'), 'video');
  symlinkSync('/etc/hosts', join(r, 'test-results', 'link'));
  writeFileSync(join(r, 'playwright.config.ts'), 'export default {}');
  writeFileSync(join(r, 'attested', 'ctrf.json'), JSON.stringify({ results: { summary: { tests: 2, passed: 1, failed: 1 }, tests: [
    { name: 'ok', status: 'passed', suite: ['chromium', 'a.spec.ts'] },
    { name: 'greets', status: 'failed', suite: ['chromium', 'a.spec.ts'], filePath: `${OTHER}/tests/a.spec.ts`, message: 'Error: nope',
      trace: `Error: nope\n    at ${OTHER}/tests/a.spec.ts:6:5`, attachments: [{ name: 'trace', path: `${OTHER}/test-results/t/trace.zip` }] },
  ] } }));
  // Forgeries the test job could plant: they must be ignored.
  writeFileSync(join(r, 'attested', 'receipt.json'), JSON.stringify({ predicate: { testResult: { result: 'PASSED' }, source: { commit: 'f'.repeat(40), headCommit: 'f'.repeat(40) } } }));
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { head: { sha: HEAD } } }));
  return dir;
}

function attest(dir, env = {}) {
  const r = spawnSync(process.execPath, [BIN, 'attest', '--from-results', 'results', '--out', 'signed/attested', '--rerun', 'pnpm exec attested run -- pnpm exec playwright test'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_SHA: MERGE, GITHUB_REF: 'refs/pull/7/merge', GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_OUTPUT: join(dir, 'out'), ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('builds the receipt from results as data, with source from the event context', () => {
  const dir = setup();
  const r = attest(dir);
  assert.equal(r.code, 0, r.out);
  const receipt = JSON.parse(readFileSync(join(dir, 'signed/attested/receipt.json'), 'utf8'));
  const p = receipt.predicate;
  assert.deepEqual(p.source, { commit: MERGE, headCommit: HEAD, dirty: null, ref: 'refs/pull/7/merge' });
  assert.equal(p.testResult.result, 'FAILED');
  assert.equal(receipt.subject[0].digest.sha256, sha(join(dir, 'results/attested/ctrf.json')));
  assert.equal(sha(join(dir, 'signed/attested/ctrf.json')), receipt.subject[0].digest.sha256);
  const byPath = Object.fromEntries(p.artifacts.map((a) => [a.path, a]));
  assert.deepEqual(Object.keys(byPath).sort(), ['attested/ctrf.json', 'attested/packet.json', 'test-results/t/trace.zip', 'test-results/t/video.webm']);
  assert.equal(byPath['test-results/t/trace.zip'].sha256, sha(join(dir, 'results/test-results/t/trace.zip')));
  assert.equal(byPath['attested/packet.json'].sha256, sha(join(dir, 'signed/attested/packet.json')));
  assert.equal(p.testResult.configuration[0].name, 'playwright.config.ts');
  const packet = JSON.parse(readFileSync(join(dir, 'signed/attested/packet.json'), 'utf8'));
  assert.equal(packet.failingTests[0].file, 'tests/a.spec.ts');
  assert.equal(packet.failingTests[0].line, 6);
  assert.deepEqual(packet.failingTests[0].stack, ['at tests/a.spec.ts:6:5']);
  assert.deepEqual(packet.failingTests[0].evidence, [{ kind: 'trace', path: 'test-results/t/trace.zip', sha256: byPath['test-results/t/trace.zip'].sha256 }]);
  assert.deepEqual(packet.console, [{ level: 'error', message: 'boom', count: 1 }]);
  assert.equal(packet.rerun, 'pnpm exec attested run -- pnpm exec playwright test');
  const out = readFileSync(join(dir, 'out'), 'utf8');
  assert.match(out, /subject-path=\S*\/signed\/attested\/ctrf\.json\n/);
  assert.match(out, /predicate-type=https:\/\/praxso.ai\/attested\/v0.1\n/);
});

test('refuses without GITHUB_SHA rather than trusting anything in the results', () => {
  const r = attest(setup(), { GITHUB_SHA: '' });
  assert.equal(r.code, 2);
  assert.match(r.out, /--from-results needs GITHUB_SHA/);
});

test('refuses a results directory without a CTRF report', () => {
  const dir = setup();
  const r = spawnSync(process.execPath, [BIN, 'attest', '--from-results', 'nope'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_SHA: MERGE } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /results directory nope not found/);
});
