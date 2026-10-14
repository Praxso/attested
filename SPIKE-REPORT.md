# M1 spike report: `prove run` and `prove attest`

Date: 2026-10-14. Brief: [docs/spikes/m1-brief.md](docs/spikes/m1-brief.md). Repo: [Praxso/prove](https://github.com/Praxso/prove) (public).

## Result in one line

All seven exit tests pass. A thin CLI plus `actions/attest` and `gh attestation` is enough to turn a Playwright run into a Sigstore-signed, offline-verifiable, tamper-evident receipt. No stop condition was hit.

## Time

Agent execution, wall clock, measured from the session's shell timestamps (UTC):

| Deliverable | Start | End | Elapsed |
|---|---|---|---|
| Read brief and six references | 20:59 | 21:01 | 2 min |
| CLI (`packages/cli`) | 21:01 | 21:03 | 2 min |
| Sample app, local green/red runs, exit tests 5 and 6 | 21:03 | 21:04 | 1 min |
| Workflow, README, PR 1, one CI failure and fix | 21:04 | 21:08 | 4 min |
| Exit tests 1, 3, 4; merge PR 1 | 21:06 | 21:08 | 2 min |
| Red dispatch, exit test 2, fresh-clone timing | 21:08 | 21:12 | 4 min |
| This report, PR 2 | 21:12 | 21:20 | 8 min |
| **Total** | | | **about 25 min** of the 3-day box |

Agent runtime also included roughly 10 minutes of waiting on GitHub Actions runs (each run takes 50 to 60 s).

## Exit tests

### 1. Green run verifies online

Run: https://github.com/Praxso/prove/actions/runs/38637526887 (pull_request). Attestations: [56007893](https://github.com/Praxso/prove/attestations/56007893) (receipt), [56007905](https://github.com/Praxso/prove/attestations/56007905) (in-toto Test Result).

```
$ gh run download 38637526887 --dir green && cd green/prove-*
$ gh attestation verify prove/ctrf.json --repo Praxso/prove \
    --predicate-type https://Praxso/prove/receipt/v0.1 \
    --signer-workflow Praxso/prove/.github/workflows/prove.yml
Loaded digest sha256:852e15a9... for file://prove/ctrf.json
Loaded 1 attestation from GitHub API
✓ Verification succeeded!
$ ... --format json | jq '.[0].verificationResult.statement | {subject, predicateType, commit: .predicate.source.commit, result: .predicate.testResult.result}'
{
  "subject": [{ "name": "ctrf.json", "digest": { "sha256": "852e15a97151081c959c1de5461230e4b142b5c31f5f906fcbb429c4e8a12a89" } }],
  "predicateType": "https://Praxso/prove/receipt/v0.1",
  "commit": "d2895e68d4af43e8025b184e92be1eb26094de7a",
  "result": "PASSED"
}
$ ... | jq '.[0].verificationResult.signature.certificate | {sourceRepositoryDigest, buildTrigger, subjectAlternativeName}'
{
  "sourceRepositoryDigest": "d2895e68d4af43e8025b184e92be1eb26094de7a",
  "buildTrigger": "pull_request",
  "subjectAlternativeName": "https://github.com/Praxso/prove/.github/workflows/prove.yml@refs/pull/1/merge"
}
```

The predicate's `source.commit` equals the certificate's `sourceRepositoryDigest`. Note that on `pull_request` this is the synthetic merge commit, not the branch head (see findings). The push-to-main run attests the real commit `dc1b595`.

### 2. Red run: FAILED receipt, still verifies, job fails

Run: https://github.com/Praxso/prove/actions/runs/38637904567 (`workflow_dispatch`, `break=true`, conclusion **failure**). Attestations: [56008811](https://github.com/Praxso/prove/attestations/56008811), [56008821](https://github.com/Praxso/prove/attestations/56008821).

```
$ gh workflow run prove.yml --ref main -f break=true
# job log, trimmed:
prove: test command exited with 1
prove: receipt: prove/receipt.json (FAILED, 1 passed, 1 failed, 9 artifacts)
prove: failed: chromium,greeting.spec.ts > home page greets the visitor
##[error]Process completed with exit code 1.
prove: prepared predicate for actions/attest: subject ctrf.json sha256:83f50523..., type https://Praxso/prove/receipt/v0.1
receipt attestation: https://github.com/Praxso/prove/attestations/56008811

$ gh run download 38637904567 --dir red && cd red/prove-*
$ gh attestation verify prove/ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1 \
    --signer-workflow Praxso/prove/.github/workflows/prove.yml --format json \
  | jq '.[].verificationResult.statement.predicate | {commit: .source.commit, result: .testResult.result, failedTests: .testResult.failedTests}'
{
  "commit": "dc1b595752c2e433053b0d701325e4f9ac8fbcd9",
  "result": "FAILED",
  "failedTests": ["chromium,greeting.spec.ts > home page greets the visitor"]
}
```

Also checked: verifying with the default predicate type (SLSA provenance) fails with `HTTP 404`, so `gh attestation verify` does enforce `--predicate-type`.

### 3. Offline verification

```
$ gh attestation download prove/ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1
Wrote attestations to file sha256:852e15a9....jsonl.
$ gh attestation trusted-root > trusted_root.jsonl
$ mkdir ../clean && cp prove/ctrf.json sha256:*.jsonl trusted_root.jsonl ../clean/ && cd ../clean
$ HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
  gh attestation verify ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1 \
    --signer-workflow Praxso/prove/.github/workflows/prove.yml \
    --bundle sha256:*.jsonl --custom-trusted-root trusted_root.jsonl
✓ Verification succeeded!            # exit 0
# control, same blocked-network env without --bundle:
error creating Sigstore verifier: no valid Sigstore verifiers could be initialized   # exit 1
```

The network was blocked by pointing the proxy at a closed port; the control shows the block was real.

### 4. Tamper

```
$ cp ctrf.json tampered.json && printf '\n' >> tampered.json
$ gh attestation verify tampered.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1
Error: HTTP 404: Not Found (.../attestations/sha256:da44dc0e...)     # exit 1: no attestation exists for the new digest

$ jq '.predicate.source.commit = "0000000000000000000000000000000000000000"' receipt.json > receipt-edited.json
$ jq -r '.dsseEnvelope.payload' sha256:*.jsonl | base64 -d | jq -r '.predicate.source.commit'
d2895e68d4af43e8025b184e92be1eb26094de7a                              # the signed bundle still carries the original
$ diff <(jq -S '.[0].verificationResult.statement.predicate' verify.json) <(jq -S '.predicate' receipt-edited.json)
<     "commit": "d2895e68d4af43e8025b184e92be1eb26094de7a",
>     "commit": "0000000000000000000000000000000000000000"        # local edit is detectable
```

`prove attest` itself also refuses to attest if `ctrf.json` changed since `prove run`:

```
$ printf ' ' >> prove/ctrf.json && pnpm exec prove attest
prove: error: prove attest: prove/ctrf.json changed since `prove run` (sha256 d327b302... != ed1cf180...); refusing to attest   # exit 2
```

### 5. Fail-closed

```
$ pnpm exec prove run --allow-dirty --expect-sha 0000000000000000000000000000000000000000 -- pnpm exec playwright test
prove: error: prove run: HEAD is 756eac03..., expected 00000000...; refusing to run tests     # exit 2, no tests ran

$ git status --porcelain | head -2
 M pnpm-lock.yaml
?? examples/
$ pnpm exec prove run -- pnpm exec playwright test
prove: error: prove run: working tree is dirty; commit or pass --allow-dirty                 # exit 2, no tests ran
```

In CI the workflow passes `--expect-sha "$GITHUB_SHA"` and no `--allow-dirty`; both checks pass there because the checkout is clean and build outputs are gitignored.

### 6. Local unsigned path

```
$ pnpm exec prove attest
prove: warning: not running in GitHub Actions: wrote UNSIGNED receipt (signed: false). Push to GitHub to get a Sigstore-signed attestation.
# exit 0
$ jq '{signed, signing}' prove/receipt.json
{ "signed": false, "signing": { "mode": "none", "note": "not running in GitHub Actions; receipt is unsigned" } }
```

### 7. Fresh-clone timing

Same agent, clean temp directory, README followed verbatim from `git clone` to exit test 1 against the push-to-main run.

| Caches | Clone, install, build | Local run + unsigned attest | Download + verify | Total |
|---|---|---|---|---|
| Warm (pnpm store and Playwright browser present) | 2 s | 2 s | 9 s | **13 s** |
| Cold (empty pnpm store, empty browser cache) | 2 s | 13 s | 6 s | **24 s** |

Both are far under the 15-minute target. The dominant cold cost is the Chromium headless shell download (99 MiB).

## Where a primitive did not do what the design assumed

1. **`prove` is Perl's TAP harness.** `/usr/bin/prove` exists on ubuntu-latest and on macOS. pnpm does not create a bin shim for a workspace package whose bin target is missing at install time, and `dist/` is only built after install, so `pnpm exec prove` in CI silently ran Perl's `prove` (run [38637308046](https://github.com/Praxso/prove/actions/runs/38637308046), "Result: NOTESTS", exit 2). Fixed with a committed `packages/cli/bin/prove.js` launcher. Any published package named `prove` will collide with Perl on every developer machine; this is a naming input.
2. **`actions/attest` README now lists `artifact-metadata: write`** as a required permission. It is only needed for the artifact storage record (OCI `push-to-registry`). The brief's exact three permissions (`contents: read`, `id-token: write`, `attestations: write`) worked on the first signing attempt; the predicate was accepted unchanged.
3. **A CLI cannot invoke a GitHub Action.** `prove attest` therefore prepares `prove/predicate.json`, re-checks the subject digest, and emits step outputs (`subject-path`, `predicate-path`, `predicate-type`); the `actions/attest` step that follows does the signing. The receipt's `signed: true` is written before that step runs; if the step fails the job fails, but a receipt with `signed: true` and no attestation can exist in the uploaded artifact. M2 should either write `signed` after the action via a second CLI call, or drop the field and treat the attestation store as the only truth.
4. **`pull_request` attests the merge commit.** `GITHUB_SHA` on `pull_request` is the synthetic `refs/pull/N/merge` commit, so `source.commit` in a PR run is not a commit on the branch. `push` runs attest the real commit. Consumers that want to check "was commit X tested" must use push runs or `pull_request` with the head sha recorded separately.
5. **CTRF has no WARNED status.** CTRF statuses are `passed|failed|skipped|pending|other`. The CLI maps anything that is neither passed nor failed into `warnedTests` with a `[status]` suffix so nothing is silently dropped. Test names come out as `<project>,<file> > <title>` because the reporter joins project and file into `suite` with a comma.
6. **The reporter writes `.last-run.json` into `test-results`**, which gets hashed as an artifact of kind `report`. Harmless, but it changes on every run.
7. **`gh attestation verify` fails on tamper with `HTTP 404`**, not a signature error, because lookup is by subject digest. Offline with `--bundle`, the same tamper produces a digest-mismatch error. Both are failures, but tooling that distinguishes "never attested" from "attested then altered" needs the bundle.
8. **`gh` version**: 2.102.0 was used. `--predicate-type`, `--signer-workflow`, `download --predicate-type`, and `trusted-root` all exist. No version floor was tested.

## Size and dependencies

CLI: 435 lines of TypeScript across 7 files (`packages/cli/src/*.ts`, `bin/prove.js`), **zero runtime dependencies** (Node 22 built-ins only).

| Package | Version | License | Used by |
|---|---|---|---|
| typescript | 5.9.3 | Apache-2.0 | CLI build |
| @types/node | 22.20.5 | MIT | CLI build |
| @playwright/test | 1.64.1 | Apache-2.0 | sample app |
| playwright-ctrf-json-reporter | 0.2.0 | MIT | sample app |

Actions, pinned to commit SHAs: actions/checkout v7.0.1, pnpm/action-setup v6.1.0, actions/setup-node v7.1.0, actions/attest v4.2.2, actions/upload-artifact v7.0.2.

## Dual attestation

Done; it cost about 10 minutes. `prove run` writes `prove/test-result.json` (pure in-toto Test Result v0.1 predicate) and the workflow runs a second `actions/attest` step. It verifies with `--predicate-type https://in-toto.io/attestation/test-result/v0.1` (shown under exit test 2). Cost per run: one extra Sigstore signing, about 5 s.

## Open decisions for Zach

Resolved on 2026-10-14 in PR #3 (`Praxso/attested`), after the repo was renamed from `Praxso/prove`.

1. **Final name.** `prove` collides with Perl's test harness on every Mac and Linux box (finding 1). Keep the name and accept that `prove` on PATH is ambiguous, or rename.
   **Resolved:** renamed to `attested` (`@praxso/attested`, `attested run`, `attested attest`, output dir `attested/`, workflow `attested.yml`). The committed launcher stays because the pnpm shim gap is independent of the name.
2. **Predicate URI domain.** `https://Praxso/prove/receipt/v0.1` is not a resolvable URL. Pick a real domain (for example `https://praxso.dev/prove/receipt/v0.1`) before anyone verifies against it in anger; it is a single constant in `packages/cli/src/constants.ts`.
   **Resolved:** `https://praxso.ai/attested/v0.1`.
3. **Keep the dual attestation?** It is cheap and lets any in-toto consumer read the result without knowing prove. Cost is one more signing step and two attestations per subject.
   **Resolved:** kept. The custom predicate is authoritative; the in-toto Test Result attestation is a projection of it.
4. **`--target-url` in M2.** It is implemented (`/healthz` probed, `sha` field recorded as `target.buildSha`, failure only warns). Decide whether a missing or mismatched build sha should fail closed.
   **Resolved:** fail-closed. With the flag, an unreachable target, missing `sha`, or `sha` different from `--expect-sha` (or `HEAD`) exits 2 before tests run; without the flag no probe runs. Covered by `packages/cli/test/target-url.test.mjs`.
5. **`signed` field semantics** (finding 3): drop it, or set it only after `actions/attest` succeeds.
   **Resolved:** dropped, along with the companion `signing` object. `gh attestation verify` is the only answer to whether a receipt is signed.
