// Covers verify/verify.sh (the `attested verify` action) against a stub `gh`: each fail-closed rule, the head rule, and forks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'verify', 'verify.sh');
const T = 'https://praxso.ai/attested/v0.1';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

function attestation({ type = T, commit = MERGE, headCommit = HEAD, result = 'PASSED', run = '42', ref = 'refs/pull/7/merge' } = {}) {
  return { verificationResult: {
    signature: { certificate: { runInvocationURI: `https://github.com/o/r/actions/runs/${run}/attempts/1`, sourceRepositoryRef: ref } },
    statement: { predicateType: type, predicate: { source: { commit, headCommit }, testResult: { result, failedTests: result === 'FAILED' ? ['chromium,greeting.spec.ts > home page greets the visitor'] : [] } } },
  } };
}
const statement = (o) => [attestation(o)];

// gh stub: `attestation verify` prints $STUB_VERIFY_OUT or fails with $STUB_VERIFY_ERR; `api` prints $STUB_API_OUT.
function setup({ verifyOut = null, verifyErr = null, apiOut = '', event = null, subject = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'attested-verify-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
if [ "$1" = attestation ]; then
  if [ -n "$STUB_VERIFY_ERR" ]; then echo "$STUB_VERIFY_ERR" >&2; exit 1; fi
  echo "$STUB_VERIFY_OUT"; exit 0
fi
if [ "$1" = api ]; then printf '%s' "$STUB_API_OUT"; exit "\${STUB_API_EXIT:-0}"; fi
exit 9
`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  if (subject) { mkdirSync(join(dir, 'attested')); writeFileSync(join(dir, 'attested', 'ctrf.json'), '{"results":{}}'); }
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event ?? { pull_request: { head: { sha: HEAD, repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } } }));
  const env = {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_SHA: MERGE,
    ATTESTED_RUN_ID: '42', ATTESTED_SOURCE_REF: 'refs/pull/7/merge',
    STUB_VERIFY_OUT: verifyOut ? JSON.stringify(verifyOut) : '', STUB_VERIFY_ERR: verifyErr ?? '', STUB_API_OUT: apiOut,
  };
  return (extra = {}) => {
    const r = spawnSync('bash', [SCRIPT], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
}

test('green pull_request receipt passes via source.headCommit and explains the head rule', () => {
  const r = setup({ verifyOut: statement() })();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: .*head rule: source.headCommit == a{40} \(pull_request run: source.commit b{40} is the synthetic merge commit\)/);
});

test('green push receipt passes via source.commit', () => {
  const r = setup({ verifyOut: statement({ commit: HEAD, headCommit: null, run: '99', ref: 'refs/heads/main' }), event: {} })(
    { GITHUB_SHA: HEAD, ATTESTED_RUN_ID: '', ATTESTED_SOURCE_REF: '', GITHUB_RUN_ID: '99', GITHUB_REF: 'refs/heads/main' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /head rule: source.commit == a{40} \(push-style run/);
});

test('no receipt fails', () => {
  const r = setup({ subject: false })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no receipt: attested\/ctrf.json not found/);
});

test('no attestation (404) fails', () => {
  const r = setup({ verifyErr: 'Error: HTTP 404: Not Found' })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no attestation found for sha256:[0-9a-f]{64} in o\/r/);
});

test('no attestation stays "no attestation" when the attestations API itself 404s', () => {
  const r = setup({ verifyErr: 'Error: HTTP 404: Not Found', apiOut: '{"message":"Not Found","status":"404"}' })({ STUB_API_EXIT: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no attestation found for sha256:/);
});

test('predicate type mismatch is named when the digest is attested under another type', () => {
  const r = setup({ verifyErr: 'Error: HTTP 404: Not Found', apiOut: 'https://slsa.dev/provenance/v1' })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: predicate type mismatch: .* attested only as https:\/\/slsa.dev\/provenance\/v1/);
});

test('verification failure fails', () => {
  const r = setup({ verifyErr: 'Error: verifying with issuer: certificate identity mismatch' })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: verification failed for sha256:.*certificate identity mismatch/);
});

test('SHA mismatch fails', () => {
  const r = setup({ verifyOut: statement({ commit: 'c'.repeat(40), headCommit: 'd'.repeat(40) }) })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: SHA mismatch: receipt source.commit c{40} and source.headCommit d{40}, but the head being verified is a{40}/);
});

test('red receipt fails', () => {
  const r = setup({ verifyOut: statement({ result: 'FAILED' }) })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: result FAILED: .*home page greets the visitor/);
});

const fork = { pull_request: { head: { sha: HEAD, repo: { full_name: 'someone/r' } }, base: { repo: { full_name: 'o/r' } } } };

test('forked PR without attestation fails with "unsigned run from fork"', () => {
  const r = setup({ verifyErr: 'Error: HTTP 404: Not Found', event: fork })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: unsigned run from fork someone\/r/);
});

test('forked PR with allow-unsigned is neutral (exit 0 with a warning)', () => {
  const r = setup({ verifyErr: 'Error: HTTP 404: Not Found', event: fork })({ ALLOW_UNSIGNED: 'true' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning title=attested verify::neutral: unsigned run from fork/);
});

// Side-branch forgery: the same ctrf.json bytes signed PASSED by workflow_dispatch from a branch with a modified attested.yml.
const forged = attestation({ result: 'PASSED', run: '777', ref: 'refs/heads/side' });

test('only the attestation from the expected run and ref is accepted', () => {
  const r = setup({ verifyOut: [attestation()] })();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: .* in run 42 on refs\/pull\/7\/merge/);
});

test('an attestation from another run and ref is rejected', () => {
  const r = setup({ verifyOut: [forged] })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no attestation from run 42 on refs\/pull\/7\/merge \(sha256:[0-9a-f]{64} is attested by: https:\/\/github.com\/o\/r\/actions\/runs\/777\/attempts\/1 on refs\/heads\/side\)/);
});

test('with a forged PASSED and the real FAILED both present, in either order, the real one decides', () => {
  const real = attestation({ result: 'FAILED' });
  for (const list of [[forged, real], [real, forged]]) {
    const r = setup({ verifyOut: list })();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL: result FAILED/);
  }
});

test('same run id on a different ref is rejected', () => {
  const r = setup({ verifyOut: [attestation({ ref: 'refs/heads/side' })] })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no attestation from run 42 on refs\/pull\/7\/merge/);
});

test('a run id that is only a prefix of the real one is rejected', () => {
  const r = setup({ verifyOut: [attestation({ run: '4242' })] })();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no attestation from run 42/);
});

test('missing run id fails closed', () => {
  const r = setup({ verifyOut: statement() })({ ATTESTED_RUN_ID: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no run id to pin the attestation to/);
});

// Result policy: PASSED passes, WARNED passes with a warning, FAILED fails, missing or unknown fails closed.
test('WARNED passes with a warning annotation', () => {
  const r = setup({ verifyOut: statement({ result: 'WARNED' }) })();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning title=attested verify::result WARNED/);
  assert.match(r.out, /PASS: .*result WARNED/);
});

test('a missing result fails closed', () => {
  const noResult = attestation(); delete noResult.verificationResult.statement.predicate.testResult.result;
  for (const list of [statement({ result: null }), statement({ result: '' }), [noResult]]) {
    const r = setup({ verifyOut: list })();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL: result missing: the signed receipt for a{40} records no test result/);
  }
});

test('an unknown result fails closed', () => {
  for (const result of ['passed', 'SKIPPED', 'PASSED ', 1]) {
    const r = setup({ verifyOut: statement({ result }) })();
    assert.equal(r.code, 1, `${result}: ${r.out}`);
    assert.match(r.out, /FAIL: result unknown: /);
  }
});

// The "attested run" job conclusion that required.sh read from the Actions API.
test('a failed test command fails even when the receipt says PASSED', () => {
  const r = setup({ verifyOut: statement() })({ ATTESTED_RUN_CONCLUSION: 'failure' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: test command failed: the attested run job in run 42 failed at its test step, but the receipt says PASSED/);
});

test('a failed test command with a FAILED receipt names the failing tests', () => {
  const r = setup({ verifyOut: statement({ result: 'FAILED' }) })({ ATTESTED_RUN_CONCLUSION: 'failure' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: result FAILED: .*home page greets the visitor/);
});

test('a successful test job passes; any other job conclusion fails closed', () => {
  assert.equal(setup({ verifyOut: statement() })({ ATTESTED_RUN_CONCLUSION: 'success' }).code, 0);
  const r = setup({ verifyOut: statement() })({ ATTESTED_RUN_CONCLUSION: 'cancelled' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: attested run job concluded cancelled, not success or failure/);
});
