// Covers verify/required.sh (the org-ruleset workflow's receipt lookup) against a stub `gh`. The stub serves JSON
// fixtures per API path and applies the script's own --jq filter with jq, so the filters are tested too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'verify', 'required.sh');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PROTECTED = ['.github/workflows/attested.yml', '.github/workflows/attested-verify.yml'];
const key = (path) => path.replace(/[/?=&.]/g, '_');
const blob = (c) => ({ type: 'file', sha: c.repeat(40) });

// Default fixtures: a PR into main whose protected files are unchanged, and a completed run whose test job succeeded.
function fixtures() {
  const f = {
    'repos/o/r': { default_branch: 'main' },
    'repos/o/r/pulls/7': { base: { ref: 'main', sha: BASE, repo: { full_name: 'o/r' } }, head: { sha: HEAD } },
    [`repos/o/r/actions/workflows/attested.yml/runs?head_sha=${HEAD}&event=pull_request&per_page=1`]:
      { workflow_runs: [{ id: 42, status: 'completed', pull_requests: [{ number: 7, base: { ref: 'main' } }] }] },
    'repos/o/r/actions/runs/42/jobs?filter=latest&per_page=100': { total_count: 2, jobs: [
      { name: 'attested run', conclusion: 'success', steps: [{ name: 'Install', conclusion: 'success' }, { name: 'attested run', conclusion: 'success' }] },
      { name: 'attested sign', conclusion: 'success', steps: [] },
    ] },
    'repos/o/r/actions/runs/42/artifacts': { artifacts: [{ name: 'results-x' }, { name: 'attested-b' }] },
  };
  for (const p of PROTECTED) { f[`repos/o/r/contents/${p}?ref=${BASE}`] = blob('1'); f[`repos/o/r/contents/${p}?ref=${HEAD}`] = blob('1'); }
  return f;
}

function setup(change = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'attested-required-'));
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'api'));
  const f = fixtures(); change(f);
  for (const [path, body] of Object.entries(f)) if (body !== undefined) writeFileSync(join(dir, 'api', key(path)), JSON.stringify(body));
  writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
if [ "$1" = run ] && [ "$2" = download ]; then d="\${@: -1}"; mkdir -p "$d/attested"; echo '{}' > "$d/attested/ctrf.json"; exit 0; fi
[ "$1" = api ] || exit 9
path="$2"; shift 2; jqf=.
while [ $# -gt 0 ]; do [ "$1" = --jq ] && jqf="$2"; shift; done
f="$STUB_DIR/api/$(printf %s "$path" | tr '/?=&.' '_____')"
[ -f "$f" ] || { echo "HTTP 404: Not Found ($path)" >&2; exit 1; }
jq -r "$jqf" "$f"
`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 7, head: { sha: HEAD } } }));
  const env = {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_OUTPUT: join(dir, 'out'), GITHUB_ENV: join(dir, 'env'),
    WAIT_SECONDS: '0', POLL_SECONDS: '0', WORKFLOW_REF: 'o/r/.github/workflows/attested-verify.yml@refs/heads/main', WORKFLOW_SHA: 'c'.repeat(40), STUB_DIR: dir,
  };
  const r = spawnSync('bash', [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
  const read = (n) => existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : '';
  return { code: r.status, out: r.stdout + r.stderr, dir, output: read('out'), env: read('env') };
}
const jobs = (f) => f['repos/o/r/actions/runs/42/jobs?filter=latest&per_page=100'].jobs[0];
const runs = (f) => f[`repos/o/r/actions/workflows/attested.yml/runs?head_sha=${HEAD}&event=pull_request&per_page=1`].workflow_runs[0];

test('downloads the receipt of the completed attested run for the PR head', () => {
  const r = setup();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify code from o\/r\/.github\/workflows\/attested-verify.yml@refs\/heads\/main @ c{40}/);
  assert.match(r.out, /mode: ruleset or default-branch copy/);
  assert.match(r.out, /attested run job concluded success/);
  assert.equal(r.output, 'subject-path=receipt/attested/ctrf.json\n');
  assert.ok(existsSync(join(r.dir, 'receipt/attested/ctrf.json')));
  assert.equal(r.env, 'ATTESTED_RUN_ID=42\nATTESTED_SOURCE_REF=refs/pull/7/merge\nATTESTED_RUN_CONCLUSION=success\n');
});

// Protected-path check: blob shas at the base and head commits, from the contents API.
for (const path of PROTECTED) {
  test(`a PR whose head changes ${path} is blocked with the protected-path message`, () => {
    const r = setup((f) => { f[`repos/o/r/contents/${path}?ref=${HEAD}`] = blob('2'); });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`FAIL: attesting workflow changed in this PR; merge requires an explicit admin bypass after review \\(${path.replace(/\./g, '\\.')}\\)`));
  });

  test(`a PR that deletes ${path} fails closed`, () => {
    const r = setup((f) => { f[`repos/o/r/contents/${path}?ref=${HEAD}`] = undefined; });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`FAIL: could not read ${path.replace(/\./g, '\\.')} at the head commit a{40}; failing closed`));
  });
}

test('a contents API error at the base commit fails closed', () => {
  const r = setup((f) => { f[`repos/o/r/contents/${PROTECTED[0]}?ref=${BASE}`] = undefined; });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: could not read \.github\/workflows\/attested\.yml at the base commit b{40}; failing closed/);
});

test('a contents response without a blob sha fails closed (directory, symlink, or missing sha)', () => {
  for (const body of [[{ type: 'file', sha: '1'.repeat(40) }], { type: 'symlink', sha: '1'.repeat(40) }, { type: 'file' }, { type: 'file', sha: 'not-a-sha' }]) {
    const r = setup((f) => { f[`repos/o/r/contents/${PROTECTED[1]}?ref=${HEAD}`] = body; });
    assert.equal(r.code, 1, JSON.stringify(body));
    assert.match(r.out, /FAIL: could not read \.github\/workflows\/attested-verify\.yml at the head commit/);
  }
});

test('changing other files, including the CLI sources, is allowed (no file listing is consulted)', () => {
  const r = setup((f) => { f['repos/o/r/pulls/7/files'] = Array.from({ length: 3001 }, (_, i) => ({ filename: `f${i}` })); });
  assert.equal(r.code, 0, r.out);
});

// The PR must target the default branch, as the API reports it.
test('a PR into a branch other than the default branch fails', () => {
  const r = setup((f) => { f['repos/o/r/pulls/7'].base.ref = 'release'; });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: PR #7 targets release, not the default branch main/);
});

test('an unreadable default branch or PR fails closed', () => {
  assert.match(setup((f) => { f['repos/o/r'] = undefined; }).out, /FAIL: could not read the default branch of o\/r/);
  assert.match(setup((f) => { f['repos/o/r'] = {}; }).out, /FAIL: could not read the default branch of o\/r/);
  assert.match(setup((f) => { f['repos/o/r/pulls/7'] = undefined; }).out, /FAIL: (could not read PR #7|PR #7 does not belong)/);
  assert.match(setup((f) => { delete f['repos/o/r/pulls/7'].base.sha; }).out, /FAIL: could not read the base commit of PR #7/);
});

test('a PR whose head moved since the event fails', () => {
  const r = setup((f) => { f['repos/o/r/pulls/7'].head.sha = 'd'.repeat(40); });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: PR #7 head is now d{40}, not a{40}/);
});

test('a run that records another PR or another base branch fails', () => {
  assert.match(setup((f) => { runs(f).pull_requests = [{ number: 8, base: { ref: 'main' } }]; }).out, /FAIL: attested run 42 is not a run of PR #7 into main \(recorded base: -\)/);
  assert.match(setup((f) => { runs(f).pull_requests = [{ number: 7, base: { ref: 'release' } }]; }).out, /FAIL: attested run 42 is not a run of PR #7 into main \(recorded base: release\)/);
});

test('a run that lists no pull requests (fork) relies on the PR check', () => {
  const r = setup((f) => { runs(f).pull_requests = []; });
  assert.equal(r.code, 0, r.out);
});

// The "attested run" job conclusion.
test('a test-step failure is passed on to verify as ATTESTED_RUN_CONCLUSION=failure', () => {
  const r = setup((f) => { jobs(f).conclusion = 'failure'; jobs(f).steps[1].conclusion = 'failure'; });
  assert.equal(r.code, 0, r.out);
  assert.match(r.env, /ATTESTED_RUN_CONCLUSION=failure\n/);
});

for (const [name, change, want] of [
  ['cancelled', (j) => { j.conclusion = 'cancelled'; j.steps[1].conclusion = 'cancelled'; }, 'job cancelled, test step cancelled'],
  ['timed out', (j) => { j.conclusion = 'timed_out'; }, 'job timed_out, test step success'],
  ['skipped test step', (j) => { j.steps[1].conclusion = 'skipped'; }, 'job success, test step skipped'],
  ['failure outside the test step', (j) => { j.conclusion = 'failure'; j.steps[0].conclusion = 'failure'; j.steps[1].conclusion = 'skipped'; }, 'job failure, test step skipped, 1 other failed steps'],
  ['missing test step', (j) => { j.steps.pop(); }, 'job success, test step missing'],
]) {
  test(`an attested run job that did not finish normally fails (${name})`, () => {
    const r = setup((f) => change(jobs(f)));
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`FAIL: attested run job in run 42 did not finish normally \\(${want}`));
  });
}

test('a missing attested run job or an unreadable jobs list fails closed', () => {
  assert.match(setup((f) => { jobs(f).name = 'other'; }).out, /FAIL: attested run job in run 42 did not finish normally \(job missing/);
  assert.match(setup((f) => { f['repos/o/r/actions/runs/42/jobs?filter=latest&per_page=100'] = undefined; }).out, /FAIL: could not read the jobs of attested run 42/);
});

test('no finished attested run within the wait is "no receipt"', () => {
  const r = setup((f) => { runs(f).status = 'in_progress'; });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no receipt: no attested run for a{40} finished within 0 minutes \(last seen: 42 in_progress\)/);
});

test('a run without an attested artifact is "no receipt"', () => {
  const r = setup((f) => { f['repos/o/r/actions/runs/42/artifacts'] = { artifacts: [{ name: 'results-x' }] }; });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: no receipt: attested run 42 uploaded no attested-\* artifact/);
});
