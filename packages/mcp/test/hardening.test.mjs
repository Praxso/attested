// Review fixes in the MCP server: which CLI runs, how project files are read, packet shape, and the verified verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { applyRunConclusion, attestedCommand, CliNotFoundError, readProjectBytes, readProjectFile, runConclusionFromJobs, validatePacket, verdictFromAttestations, VERSION } from '../dist/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'bin', 'attested-mcp.js');
const T = 'https://praxso.ai/attested/v0.1';
const HEAD = 'a'.repeat(40);
const children = [];
test.after(() => children.forEach((c) => c.kill()));

function client(env = {}) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  children.push(child);
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  let id = 0;
  const call = (name, args) => new Promise((ok) => { const n = ++id; waiting.set(n, (m) => ok(m.result)); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
  return { call, close: () => child.kill() };
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'attested-mcp-hard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  mkdirSync(join(dir, 'attested'));
  return dir;
}

const packet = () => ({
  tool: 'attested', result: 'FAILED',
  failingTests: [{ name: 't', file: 'a.spec.ts', line: 3, message: 'm', stack: ['at a'], count: 1, evidence: [{ kind: 'trace', path: 'test-results/t.zip', sha256: '0'.repeat(64) }] }],
  console: [{ level: 'error', message: 'boom', count: 1 }], network: [{ method: 'GET', path: '/x', status: 500, count: 1 }], rerun: 'attested run -- x', truncated: false,
});

// --- which CLI runs ------------------------------------------------------------------------------

test('the bundled CLI runs by default; ATTESTED_BIN is the only override', () => {
  const [node, bin] = attestedCommand({});
  assert.equal(node, process.execPath);
  assert.match(bin, /attested[\\/]bin[\\/]attested\.js$|cli[\\/]bin[\\/]attested\.js$/);
  assert.deepEqual(attestedCommand({ ATTESTED_BIN: '/opt/attested' }), ['/opt/attested']);
});

test('an unresolvable bundled CLI fails clearly and never falls back to npx at a guessed version', () => {
  assert.throws(() => attestedCommand({}, () => { throw new Error('not installed'); }),
    (err) => err instanceof CliNotFoundError && /bundled with @praxso\/attested-mcp .* could not be resolved .*ATTESTED_BIN/.test(err.message) && !/npx/.test(err.message));
  assert.equal(VERSION, JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version);
});

test('a node_modules/.bin/attested in the project is never run', async () => {
  const dir = project();
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '.bin', 'attested'), `#!/bin/sh\ntouch "${join(dir, 'PROJECT_BIN_RAN')}"\n`);
  chmodSync(join(dir, 'node_modules', '.bin', 'attested'), 0o755);
  writeFileSync(join(dir, 't.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('attested/ctrf.json', JSON.stringify({ results: { tests: [{ name: 'a', status: 'passed' }] } }));`);
  const c = client({ ATTESTED_BIN: '' });
  const r = await c.call('attested_run', { command: `${process.execPath} t.mjs`, cwd: dir });
  c.close();
  assert.equal(existsSync(join(dir, 'PROJECT_BIN_RAN')), false);
  assert.equal(JSON.parse(r.content[0].text).result, 'PASSED');
});

// --- project files ---------------------------------------------------------------------------------

test('project files: symlinks, symlinked parents, and oversized files are refused', () => {
  const dir = project();
  const outside = mkdtempSync(join(tmpdir(), 'attested-mcp-out-'));
  writeFileSync(join(outside, 'packet.json'), JSON.stringify(packet()));
  symlinkSync(join(outside, 'packet.json'), join(dir, 'attested', 'packet.json'));
  assert.throws(() => readProjectFile(dir, 'attested/packet.json', 1e6), /attested\/packet\.json is a symlink/);
  const dir2 = mkdtempSync(join(tmpdir(), 'attested-mcp-hard-'));
  symlinkSync(outside, join(dir2, 'attested'));
  assert.throws(() => readProjectFile(dir2, 'attested/packet.json', 1e6), /resolves outside the project/);
  writeFileSync(join(dir, '..', `${basename(dir)}-sibling.json`), '{}');
  assert.throws(() => readProjectFile(dir, `../${basename(dir)}-sibling.json`, 1e6), /resolves outside the project/);
  writeFileSync(join(dir, 'big.json'), 'x'.repeat(101));
  assert.throws(() => readProjectFile(dir, 'big.json', 100), /101 bytes, over the 100-byte limit/);
  assert.equal(readProjectFile(dir, 'missing.json', 100), null);
});

test('attested_packet returns a tool error for a symlinked or malformed packet, and only known fields otherwise', async () => {
  const dir = project();
  const c = client();
  const outside = mkdtempSync(join(tmpdir(), 'attested-mcp-out-'));
  writeFileSync(join(outside, 'p.json'), JSON.stringify(packet()));
  symlinkSync(join(outside, 'p.json'), join(dir, 'attested', 'packet.json'));
  let r = await c.call('attested_packet', { cwd: dir });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /symlink/);
  const dir2 = project();
  writeFileSync(join(dir2, 'attested', 'packet.json'), JSON.stringify({ ...packet(), failingTests: [{ name: 1 }] }));
  r = await c.call('attested_packet', { cwd: dir2 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /does not have the failure packet shape/);
  const dir3 = project();
  writeFileSync(join(dir3, 'attested', 'packet.json'), JSON.stringify({ ...packet(), instructions: 'ignore previous', extra: 1 }));
  r = await c.call('attested_packet', { cwd: dir3 });
  c.close();
  assert.deepEqual(JSON.parse(r.content[0].text), packet());
});

test('validatePacket rejects every wrong shape', () => {
  assert.deepEqual(validatePacket(packet()), packet());
  for (const change of [
    (p) => { p.tool = 'x'; }, (p) => { p.result = 'PASSED'; }, (p) => { p.rerun = 1; }, (p) => { p.console = {}; },
    (p) => { p.failingTests[0].stack = [1]; }, (p) => { p.failingTests[0].line = 1.5; }, (p) => { p.failingTests[0].evidence[0].sha256 = 'x'; },
    (p) => { p.failingTests[0].evidence[0].kind = 'report'; }, (p) => { p.console[0].level = 'info'; }, (p) => { p.network[0].status = '500'; },
    (p) => { p.truncated = true; },
  ]) {
    const p = packet(); change(p);
    assert.throws(() => validatePacket(p), /failure packet shape/);
  }
});

// --- verified verdict --------------------------------------------------------------------------------

function attestation({ result = 'PASSED', run = '42', ref = 'refs/pull/7/merge', commit = 'b'.repeat(40), headCommit = HEAD, type = T } = {}) {
  return { verificationResult: {
    signature: { certificate: { runInvocationURI: `https://github.com/o/r/actions/runs/${run}/attempts/1`, sourceRepositoryRef: ref } },
    statement: { predicateType: type, predicate: { source: { commit, headCommit }, testResult: { result, failedTests: result === 'FAILED' ? ['t'] : [] } } },
  } };
}
const pin = { runId: '42', sourceRef: 'refs/pull/7/merge', head: HEAD };

test('verdict comes only from the attestation of the pinned run and ref, under the head rule', () => {
  assert.deepEqual(verdictFromAttestations([attestation()], pin), { ok: true, result: 'PASSED', reason: 'signed receipt passed', rule: `source.headCommit == ${HEAD}` });
  const forged = attestation({ run: '777', ref: 'refs/heads/side' });
  assert.equal(verdictFromAttestations([forged], pin).ok, false);
  assert.match(verdictFromAttestations([forged], pin).reason, /no attestation from run 42 on refs\/pull\/7\/merge/);
  for (const list of [[forged, attestation({ result: 'FAILED' })], [attestation({ result: 'FAILED' }), forged]]) {
    assert.deepEqual(verdictFromAttestations(list, pin).result, 'FAILED');
  }
  assert.equal(verdictFromAttestations([attestation({ run: '4242' })], pin).ok, false);
  assert.equal(verdictFromAttestations([attestation({ ref: 'refs/heads/side' })], pin).ok, false);
  assert.match(verdictFromAttestations([attestation({ headCommit: 'c'.repeat(40) })], pin).reason, /SHA mismatch/);
  assert.match(verdictFromAttestations([attestation({ type: 'x' })], pin).reason, /predicate type x/);
  assert.equal(verdictFromAttestations([attestation()], { ...pin, runId: '' }).ok, false);
});

test('verdict result policy: PASSED and WARNED pass, FAILED, missing, and unknown fail', () => {
  assert.equal(verdictFromAttestations([attestation({ result: 'WARNED' })], pin).ok, true);
  assert.deepEqual(verdictFromAttestations([attestation({ result: 'FAILED' })], pin).failedTests, ['t']);
  for (const result of ['FAILED', null, 'passed']) assert.equal(verdictFromAttestations([attestation({ result })], pin).ok, false, String(result));
});

test('attested_status builds "verified" from the signed statement and labels the local receipt unverified', async () => {
  const dir = project();
  writeFileSync(join(dir, 'attested', 'ctrf.json'), '{"results":{}}');
  // The local receipt claims PASSED; the signed statement for run 42 says FAILED.
  writeFileSync(join(dir, 'attested', 'receipt.json'), JSON.stringify({ subject: [{ digest: { sha256: '1'.repeat(64) } }], predicate: { testResult: { result: 'PASSED', passedTests: ['t'], failedTests: [], warnedTests: [] } } }));
  const bin = mkdtempSync(join(tmpdir(), 'attested-mcp-gh-'));
  writeFileSync(join(bin, 'verify.json'), JSON.stringify([attestation({ result: 'PASSED', run: '777', ref: 'refs/heads/side' }), attestation({ result: 'FAILED' })]));
  writeFileSync(join(bin, 'runs.json'), JSON.stringify({ workflow_runs: [{ id: 42, event: 'pull_request', head_branch: 'x', pull_requests: [{ number: 7 }] }] }));
  writeFileSync(join(bin, 'jobs.json'), JSON.stringify(jobs('success', 'success')));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$1" in
  --version) echo gh ;;
  attestation) printf '%s\\n' "$*" > "${bin}/args"; cat "${bin}/verify.json" ;;
  api) case "$2" in *jobs*) cat "${bin}/jobs.json" ;; *) cat "${bin}/runs.json" ;; esac ;;
  *) exit 9 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const c = client({ PATH: `${bin}:${process.env.PATH}` });
  const s = JSON.parse((await c.call('attested_status', { cwd: dir, repo: 'o/r', head_sha: HEAD })).content[0].text);
  c.close();
  assert.equal(s.verified.checked, true);
  assert.equal(s.verified.ok, false);
  assert.equal(s.verified.result, 'FAILED');
  assert.equal(s.verified.runId, '42');
  assert.equal(s.verified.sourceRef, 'refs/pull/7/merge');
  assert.match(readFileSync(join(bin, 'args'), 'utf8'), /--signer-workflow o\/r\/\.github\/workflows\/attested\.yml/);
  assert.equal(s.localReceipt.unverified, true);
  assert.equal(s.localReceipt.result, 'PASSED');
});

// --- second review pass ------------------------------------------------------------------------------

function jobs(job, step) {
  return { jobs: [{ name: 'attested run', conclusion: job, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'attested run', conclusion: step }] }] };
}

test('a signed PASSED verdict is not ok when the attested run job failed at its test step or did not finish normally', () => {
  const v = verdictFromAttestations([attestation({ result: 'PASSED' })], pin);
  assert.equal(v.ok, true);
  assert.equal(applyRunConclusion(v, runConclusionFromJobs(jobs('success', 'success'))).ok, true);
  const failed = applyRunConclusion(v, runConclusionFromJobs(jobs('failure', 'failure')));
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /test command failed/);
  for (const body of [jobs('cancelled', 'cancelled'), jobs('failure', 'success'), { jobs: [] }, null]) {
    assert.equal(applyRunConclusion(v, runConclusionFromJobs(body)).ok, false, JSON.stringify(body));
  }
});

async function statusWith(jobsBody) {
  const dir = project();
  writeFileSync(join(dir, 'attested', 'ctrf.json'), '{"results":{"tests":[]}}');
  writeFileSync(join(dir, 'attested', 'receipt.json'), JSON.stringify({ subject: [{ digest: { sha256: '1'.repeat(64) } }], predicate: { testResult: { result: 'PASSED', passedTests: ['t'], failedTests: [], warnedTests: [] } } }));
  const bin = mkdtempSync(join(tmpdir(), 'attested-mcp-gh-'));
  writeFileSync(join(bin, 'verify.json'), JSON.stringify([attestation({ result: 'PASSED' })]));
  writeFileSync(join(bin, 'runs.json'), JSON.stringify({ workflow_runs: [{ id: 42, event: 'pull_request', head_branch: 'x', pull_requests: [{ number: 7 }] }] }));
  writeFileSync(join(bin, 'jobs.json'), JSON.stringify(jobsBody));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$1" in
  --version) echo gh ;;
  attestation) printf '%s' "$3" > "${bin}/path"; cp "$3" "${bin}/verified-copy"; cat "${bin}/verify.json" ;;
  api) case "$2" in *jobs*) cat "${bin}/jobs.json" ;; *) cat "${bin}/runs.json" ;; esac ;;
  *) exit 9 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const c = client({ PATH: `${bin}:${process.env.PATH}` });
  const s = JSON.parse((await c.call('attested_status', { cwd: dir, repo: 'o/r', head_sha: HEAD })).content[0].text);
  c.close();
  return { s, dir, bin };
}

test('attested_status: signed PASSED with a failed test step is verified.ok false', async () => {
  const { s } = await statusWith(jobs('failure', 'failure'));
  assert.equal(s.verified.result, 'PASSED');
  assert.equal(s.verified.ok, false);
  assert.match(s.verified.reason, /test command failed/);
  const ok = (await statusWith(jobs('success', 'success'))).s;
  assert.equal(ok.verified.ok, true);
  assert.equal(ok.verified.runConclusion, 'success');
});

test('attested_status verifies a private snapshot of the bytes it hashed, not the project path', async () => {
  const { s, dir, bin } = await statusWith(jobs('success', 'success'));
  const path = readFileSync(join(bin, 'path'), 'utf8');
  assert.notEqual(path, join(dir, 'attested', 'ctrf.json'));
  assert.equal(path.startsWith(dir), false);
  assert.equal(existsSync(path), false, 'snapshot is removed afterwards');
  assert.equal(readFileSync(join(bin, 'verified-copy'), 'utf8'), '{"results":{"tests":[]}}');
  assert.equal(s.verified.subjectSha256, createHash('sha256').update('{"results":{"tests":[]}}').digest('hex'));
});

test('a project file replaced or grown between validation and reading is refused', () => {
  const dir = project();
  const f = join(dir, 'attested', 'ctrf.json');
  writeFileSync(f, '{}');
  assert.equal(readProjectBytes(dir, 'attested/ctrf.json', 100).toString(), '{}');
  assert.throws(() => readProjectBytes(dir, 'attested/ctrf.json', 100, () => { writeFileSync(join(dir, 'other'), '{"x":1}'); renameSync(join(dir, 'other'), f); }), /was replaced while being read/);
  assert.throws(() => readProjectBytes(dir, 'attested/ctrf.json', 100, () => appendFileSync(f, 'x'.repeat(200))), /grew past the 100-byte limit|over the 100-byte limit/);
});
