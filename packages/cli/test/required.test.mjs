// Covers verify/required.sh (the org-ruleset workflow's receipt lookup) against a stub `gh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'verify', 'required.sh');
const HEAD = 'a'.repeat(40);

// gh stub: PR files from $STUB_FILES, run "<id> <status>" from $STUB_RUN, artifact name from $STUB_ARTIFACT; download writes a ctrf.json.
function setup({ files = 'examples/sample-app/server.mjs', run = '42 completed', artifact = 'attested-b' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'attested-required-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
case "$*" in
  *pulls/*/files*) printf '%s\\n' $STUB_FILES ;;
  *workflows/attested.yml/runs*) [ -n "$STUB_RUN" ] && echo "$STUB_RUN" ;;
  *artifacts*) [ -n "$STUB_ARTIFACT" ] && echo "$STUB_ARTIFACT" ;;
  "run download"*) d="\${@: -1}"; mkdir -p "$d/attested"; echo '{}' > "$d/attested/ctrf.json" ;;
  *) exit 9 ;;
esac
`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 7, head: { sha: HEAD } } }));
  const env = {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_OUTPUT: join(dir, 'out'), GITHUB_ENV: join(dir, 'env'),
    WAIT_SECONDS: '0', POLL_SECONDS: '0', WORKFLOW_REF: 'o/r/.github/workflows/attested-verify.yml@refs/heads/main', WORKFLOW_SHA: 'c'.repeat(40),
    STUB_FILES: files, STUB_RUN: run, STUB_ARTIFACT: artifact,
  };
  const r = spawnSync('bash', [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, dir, output: existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '' };
}

test('downloads the receipt of the completed attested run for the PR head', () => {
  const r = setup();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify code from o\/r\/.github\/workflows\/attested-verify.yml@refs\/heads\/main @ c{40}/);
  assert.match(r.out, /mode: ruleset or default-branch copy/);
  assert.equal(r.output, 'subject-path=receipt/attested/ctrf.json\n');
  assert.ok(existsSync(join(r.dir, 'receipt/attested/ctrf.json')));
  assert.equal(readFileSync(join(r.dir, 'env'), 'utf8'), 'ATTESTED_RUN_ID=42\nATTESTED_SOURCE_REF=refs/pull/7/merge\n');
});

for (const path of ['.github/workflows/attested.yml', '.github/workflows/attested-verify.yml']) {
  test(`a PR that changes ${path} is blocked with the protected-path message`, () => {
    const r = setup({ files: `README.md ${path}` });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`FAIL: attesting workflow changed in this PR; merge requires an explicit admin bypass after review \\(${path.replace(/\./g, '\\.')}\\)`));
  });
}

test('changing the CLI sources is allowed (the CLI is the code under test here)', () => {
  assert.equal(setup({ files: 'packages/cli/src/run.ts verify/verify.sh' }).code, 0);
});

test('no finished attested run within the wait is "no receipt"', () => {
  const r = setup({ run: '42 in_progress' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no receipt: no attested run for a{40} finished within 0 minutes \(last seen: 42 in_progress\)/);
});

test('a run without an attested artifact is "no receipt"', () => {
  const r = setup({ artifact: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no receipt: attested run 42 uploaded no attested-\* artifact/);
});
