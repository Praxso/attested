// Review fixes in the CLI: the FAILED rule, redaction of every outward-facing string, bounded packet fields,
// input size limits, and refusal of symlinked or escaping result paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { testResultFromCtrf, validateCtrf } from '../dist/receipt.js';
import { publicUrl } from '../dist/run.js';
import { ctrfMeta, MAX_CTRF_BYTES } from '../dist/assemble.js';
import { buildPacket, readZip, rerunCommand, serializePacket, PACKET_MAX_BYTES, MAX_TRACE_ENTRY_BYTES } from '../dist/packet.js';
import { readInside, sha256File } from '../dist/util.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attested.js');
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const ctrf = (tests, summary) => ({ results: { tests, ...(summary === undefined ? {} : { summary }) } });

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

// --- receipt result ------------------------------------------------------------------------------

test('result is FAILED when any test fails, even if the summary says 0 failed', () => {
  const tr = testResultFromCtrf(ctrf([{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }], { tests: 2, passed: 2, failed: 0 }), [], null);
  assert.equal(tr.result, 'FAILED');
  assert.deepEqual(tr.failedTests, ['b']);
});

test('result is FAILED when the summary reports a failure, even if no individual test does', () => {
  for (const failed of [1, '1', null, -1]) {
    assert.equal(testResultFromCtrf(ctrf([{ name: 'a', status: 'passed' }], { failed }), [], null).result, 'FAILED', String(failed));
  }
});

test('result is PASSED or WARNED only with no failure anywhere', () => {
  assert.equal(testResultFromCtrf(ctrf([{ name: 'a', status: 'passed' }], { failed: 0 }), [], null).result, 'PASSED');
  assert.equal(testResultFromCtrf(ctrf([{ name: 'a', status: 'passed' }]), [], null).result, 'PASSED');
  assert.equal(testResultFromCtrf(ctrf([{ name: 'a', status: 'skipped' }], { failed: 0 }), [], null).result, 'WARNED');
});

test('receipt test names are redacted and bounded', () => {
  const tr = testResultFromCtrf(ctrf([
    { name: `uses ${SECRET}`, status: 'passed' }, { name: 'mail a@b.example', status: 'failed' }, { name: 'x'.repeat(5000), status: 'skipped', suite: 'token=abcdef123' },
  ]), [], null);
  const all = JSON.stringify(tr);
  assert.equal(all.includes('ghp_'), false);
  assert.equal(all.includes('a@b.example'), false);
  assert.equal(all.includes('abcdef123'), false);
  assert.ok(tr.warnedTests[0].length < 400);
});

test('CTRF tool and summary copied into the receipt are allowlisted and redacted', () => {
  const meta = ctrfMeta({ specVersion: '0.0.0', results: {
    tool: { name: `pw ${SECRET}`, version: '1.0', extra: { env: 'SECRET=1' } },
    summary: { tests: 2, passed: 1, failed: 1, note: SECRET, start: 1, duration: 'long' },
  } });
  assert.deepEqual(meta, { specVersion: '0.0.0', tool: { name: 'pw [REDACTED]', version: '1.0' }, summary: { tests: 2, passed: 1, failed: 1, start: 1 } });
  assert.deepEqual(ctrfMeta({ specVersion: 3, results: { tool: 'x', summary: [] } }), { specVersion: null, tool: null, summary: {} });
});

// --- packet --------------------------------------------------------------------------------------

test('packet redacts test names, file paths, evidence paths, the rerun command, and request methods', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attested-hard-'));
  const evidence = `test-results/token=${'s'.repeat(12)}/trace.zip`;
  mkdirSync(join(dir, dirname(evidence)), { recursive: true });
  writeFileSync(join(dir, evidence), zip({ '0-trace.network': JSON.stringify({ type: 'resource-snapshot', snapshot: { request: { url: 'https://x.test/a', method: `GET ${SECRET}` }, response: { status: 500 } } }) }));
  const packet = buildPacket(ctrf([{ name: `t ${SECRET}`, status: 'failed', filePath: join(dir, 'tests', 'key=abcdefgh123.spec.ts'), attachments: [{ path: join(dir, evidence) }] }]),
    [{ path: evidence, sha256: '0'.repeat(64), bytes: 1, kind: 'trace' }], dir, `attested run -- npx playwright test --token=${'t'.repeat(12)}`);
  const s = serializePacket(packet);
  for (const leak of ['ghp_', 'abcdefgh123', 'ssssssssssss', 'tttttttttttt']) assert.equal(s.includes(leak), false, `${leak} leaked`);
  assert.equal(packet.network[0].method, 'GET [REDACTED]');
  assert.match(packet.failingTests[0].evidence[0].path, /\[REDACTED\]/);
  assert.match(rerunCommand(['run', '--', 'x', `--password=${'p'.repeat(10)}`]), /password=\[REDACTED\]/);
});

test('every scalar is bounded, so the 12 KB cap holds for one huge failure and for many', () => {
  const huge = 'y'.repeat(200_000);
  const one = { name: huge, status: 'failed', suite: huge, filePath: `/${huge}`, message: huge, trace: Array.from({ length: 50 }, () => `at ${huge}:1:1`).join('\n'), line: 1e300,
    attachments: Array.from({ length: 50 }, (_, i) => ({ path: `/r/test-results/${i}.png` })) };
  const arts = Array.from({ length: 50 }, (_, i) => ({ path: `test-results/${i}.png`, sha256: '0'.repeat(64), bytes: 1, kind: 'screenshot' }));
  for (const tests of [[one], Array.from({ length: 30 }, (_, i) => ({ ...one, name: `${i}${huge}` }))]) {
    const p = buildPacket(ctrf(tests), arts, '/r', `attested run -- ${huge}`);
    assert.ok(Buffer.byteLength(serializePacket(p)) <= PACKET_MAX_BYTES, `${Buffer.byteLength(serializePacket(p))} bytes`);
  }
  const p = buildPacket(ctrf([one]), arts, '/r', 'x');
  assert.equal(p.failingTests[0].line, null);
  assert.ok(p.failingTests[0].evidence.length <= 10);
});

test('non-string CTRF fields do not crash the packet', () => {
  const p = buildPacket(ctrf([{ name: 1, status: 'failed', message: { a: 1 }, trace: 5, filePath: 7, attachments: 'x' }, { name: 'n', status: 'failed', attachments: [null, { path: 3 }] }]), [], '/r', 'x');
  assert.equal(p.failingTests.length, 2);
});

test('trace decompression is limited per entry; the oversized entry is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attested-hard-'));
  const path = join(dir, 'trace.zip');
  writeFileSync(path, zip({ 'big.trace': 'a'.repeat(MAX_TRACE_ENTRY_BYTES + 1), 'ok.trace': '{"type":"x"}' }));
  const files = readZip(path, () => true);
  assert.deepEqual([...files.keys()], ['ok.trace']);
  assert.equal(readZip(path, () => true, { left: 5 }).size, 0);
});

test('evidence files over the size limit are refused with a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attested-hard-'));
  writeFileSync(join(dir, 'f'), 'x'.repeat(100));
  assert.equal(sha256File(join(dir, 'f'), 100).bytes, 100);
  assert.throws(() => sha256File(join(dir, 'f'), 99), /is 100 bytes, over the 99-byte limit for evidence files/);
});

// --- attest --from-results: subject bytes, size limit, symlinks ------------------------------------

function results(ctrfText = JSON.stringify(ctrf([{ name: `t ${SECRET}`, status: 'passed' }], { tests: 1, passed: 1, failed: 0, note: SECRET }))) {
  const dir = mkdtempSync(join(tmpdir(), 'attested-hard-'));
  mkdirSync(join(dir, 'results', 'attested'), { recursive: true });
  writeFileSync(join(dir, 'results', 'attested', 'ctrf.json'), ctrfText);
  return dir;
}
function attest(dir, args = []) {
  const r = spawnSync(process.execPath, [BIN, 'attest', '--from-results', 'results', '--out', 'signed/attested', ...args],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_SHA: 'b'.repeat(40), GITHUB_OUTPUT: join(dir, 'out') } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('the signed ctrf.json subject stays byte-identical while the receipt copies are redacted', () => {
  const text = `${JSON.stringify(ctrf([{ name: `t ${SECRET}`, status: 'passed' }], { tests: 1, passed: 1, failed: 0, note: SECRET }), null, 3)}\n\n`;
  const dir = results(text);
  const r = attest(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(dir, 'signed/attested/ctrf.json'), 'utf8'), text);
  const receipt = readFileSync(join(dir, 'signed/attested/receipt.json'), 'utf8');
  assert.equal(receipt.includes('ghp_'), false);
  assert.deepEqual(JSON.parse(receipt).predicate.ctrf.summary, { tests: 1, passed: 1, failed: 0 });
});

test('a ctrf.json over the size limit is refused with a clear error', () => {
  const dir = results(' '.repeat(MAX_CTRF_BYTES + 1));
  const r = attest(dir);
  assert.equal(r.code, 2);
  assert.match(r.out, new RegExp(`attested/ctrf.json is ${MAX_CTRF_BYTES + 1} bytes, over the ${MAX_CTRF_BYTES}-byte limit for CTRF reports`));
});

test('a symlinked results root is refused', () => {
  const dir = results();
  symlinkSync(join(dir, 'results'), join(dir, 'linked'));
  const r = spawnSync(process.execPath, [BIN, 'attest', '--from-results', 'linked'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_SHA: 'b'.repeat(40) } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /results directory linked is a symlink; refusing to read it/);
});

test('a symlinked ctrf.json is refused', () => {
  const dir = results();
  writeFileSync(join(dir, 'outside.json'), JSON.stringify(ctrf([])));
  symlinkSync(join(dir, 'outside.json'), join(dir, 'results', 'attested', 'link.json'));
  const r = attest(dir, ['--ctrf', 'attested/link.json']);
  assert.equal(r.code, 2);
  assert.match(r.out, /CTRF report .*link\.json is a symlink; refusing to read it/);
});

test('a ctrf path that resolves outside the results directory is refused, including through a symlinked parent', () => {
  const dir = results();
  mkdirSync(join(dir, 'elsewhere'));
  writeFileSync(join(dir, 'elsewhere', 'ctrf.json'), JSON.stringify(ctrf([])));
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'results', 'via'));
  for (const p of ['../elsewhere/ctrf.json', 'via/ctrf.json']) {
    const r = attest(dir, ['--ctrf', p]);
    assert.equal(r.code, 2, p);
    assert.match(r.out, /CTRF report .* resolves outside .*results; refusing to read it/);
  }
});

test('a symlinked or escaping test config is refused', () => {
  const dir = results();
  writeFileSync(join(dir, 'outside.ts'), 'export default {}');
  symlinkSync(join(dir, 'outside.ts'), join(dir, 'results', 'playwright.config.ts'));
  assert.match(attest(dir).out, /test config .*playwright\.config\.ts is a symlink; refusing to read it/);
  const dir2 = results();
  writeFileSync(join(dir2, 'outside.ts'), 'export default {}');
  assert.match(attest(dir2, ['--config', '../outside.ts']).out, /test config .*outside\.ts resolves outside/);
});

test('a symlinked output directory is refused', () => {
  const dir = results();
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'results', 'test-results'));
  assert.match(attest(dir).out, /output directory .*test-results is a symlink; refusing to read it/);
});

// --- second review pass ------------------------------------------------------------------------------

test('artifact paths and config names that look like secrets are refused, never published', () => {
  const dir = results();
  mkdirSync(join(dir, 'results', 'test-results'));
  writeFileSync(join(dir, 'results', 'test-results', `token=${SECRET}.png`), 'png');
  const r = attest(dir);
  assert.equal(r.code, 2);
  assert.match(r.out, /refusing to publish the path test-results\/token=\[REDACTED\]/);
  assert.equal(r.out.includes(SECRET), false);
  const dir2 = results();
  writeFileSync(join(dir2, 'results', `key=${SECRET}.ts`), 'export default {}');
  const r2 = attest(dir2, ['--config', `key=${SECRET}.ts`]);
  assert.equal(r2.code, 2);
  assert.equal(r2.out.includes(SECRET), false);
});

test('the complete emitted predicate carries no recognized secret from paths, config names, or the workflow ref', () => {
  const dir = results();
  mkdirSync(join(dir, 'results', 'test-results'));
  writeFileSync(join(dir, 'results', 'test-results', 'shot.png'), 'png');
  writeFileSync(join(dir, 'results', 'playwright.config.ts'), 'export default {}');
  const r = spawnSync(process.execPath, [BIN, 'attest', '--from-results', 'results', '--out', 'signed/attested'], { cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_SHA: 'b'.repeat(40), GITHUB_OUTPUT: join(dir, 'out'), GITHUB_WORKFLOW_REF: `o/r/.github/workflows/a.yml@refs/heads/token=${SECRET}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of ['receipt.json', 'predicate.json', 'test-result.json']) assert.equal(readFileSync(join(dir, 'signed/attested', f), 'utf8').includes('ghp_'), false, f);
  const p = JSON.parse(readFileSync(join(dir, 'signed/attested/predicate.json'), 'utf8'));
  assert.deepEqual(p.artifacts.map((a) => a.path), ['attested/ctrf.json', 'test-results/shot.png']);
  assert.equal(p.testResult.configuration[0].name, 'playwright.config.ts');
});

test('target URLs lose credentials, query, and fragment', () => {
  assert.equal(publicUrl(`https://user:${SECRET}@app.test/x?token=${SECRET}#f`), 'https://app.test/x');
  assert.equal(publicUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});

test('malformed CTRF containers and entries are rejected; a valid zero-test report is accepted', () => {
  assert.equal(validateCtrf({ results: { tests: [], summary: { tests: 0 } } }), null);
  assert.match(validateCtrf({ results: [] }), /missing "results"/);
  assert.match(validateCtrf({ results: { summary: { tests: 1, passed: 1 } } }), /"results.tests" is not an array/);
  assert.match(validateCtrf({ results: { tests: { a: 1 } } }), /"results.tests" is not an array/);
  assert.match(validateCtrf({ results: { tests: [{ name: 'a', status: 'passed' }, null] } }), /results.tests\[1\]/);
  assert.match(validateCtrf({ results: { tests: [{ name: 'a' }] } }), /results.tests\[0\]/);
  assert.match(validateCtrf({ results: { tests: [], summary: [] } }), /"results.summary" is not an object/);
  for (const bad of [{ results: [] }, { results: { summary: { failed: 0 } } }, { results: { tests: 'x' } }]) {
    const r = attest(results(JSON.stringify(bad)));
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.out, /is not a CTRF report/);
  }
  assert.equal(attest(results(JSON.stringify({ results: { tests: [], summary: { tests: 0, failed: 0 } } }))).code, 0);
});

test('a file replaced or grown between validation and reading is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attested-hard-'));
  const f = join(dir, 'ctrf.json');
  writeFileSync(f, '{}');
  assert.equal(readInside(dir, f, 100, 'CTRF report').toString(), '{}');
  assert.throws(() => readInside(dir, f, 100, 'CTRF report', () => { writeFileSync(join(dir, 'other'), '{"x":1}'); renameSync(join(dir, 'other'), f); }), /was replaced while being read/);
  assert.throws(() => readInside(dir, f, 100, 'CTRF report', () => appendFileSync(f, 'x'.repeat(200))), /over the 100-byte limit/);
  symlinkSync(join(dir, 'ctrf.json'), join(dir, 'link.json'));
  assert.throws(() => readInside(dir, join(dir, 'link.json'), 100, 'CTRF report'), /CTRF report .*link\.json is a symlink/);
  assert.throws(() => sha256File(join(dir, 'link.json')), /link\.json is a symlink/);
});

test('rejected trace entries are charged to the shared budget, which stops inflation once spent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attested-hard-'));
  const path = join(dir, 'trace.zip');
  writeFileSync(path, zip({ 'a.trace': 'a'.repeat(2000), 'b.trace': 'b'.repeat(2000), 'c.trace': '{"type":"x"}' }));
  const budget = { left: 1500 };
  assert.equal(readZip(path, () => true, budget).size, 0);
  assert.equal(budget.left, 0);
});

test('flaky tests, per test or in the summary, make the result WARNED', () => {
  const tr = testResultFromCtrf(ctrf([{ name: 'a', status: 'passed' }, { name: 'b', status: 'passed', flaky: true }]), [], null);
  assert.equal(tr.result, 'WARNED');
  assert.deepEqual(tr.passedTests, ['a']);
  assert.deepEqual(tr.warnedTests, ['b [flaky]']);
  assert.equal(testResultFromCtrf(ctrf([{ name: 'a', status: 'passed' }], { tests: 1, passed: 1, failed: 0, flaky: 1 }), [], null).result, 'WARNED');
  assert.equal(testResultFromCtrf(ctrf([{ name: 'a', status: 'passed', flaky: false }], { tests: 1, passed: 1, failed: 0, flaky: 0 }), [], null).result, 'PASSED');
});
