# M1 spike brief: `prove run` and `prove attest` on a public sample repo

Time box: 3 working days of agent execution. Stop at the time box and write the report regardless of state.

## Preconditions Zach provides before the session starts

- An empty public GitHub repository under an organization Zach owns, with Actions enabled. Working name: `prove`. Final name is Zach's call; use the placeholder everywhere so a rename is one commit.
- A LICENSE file committed by Zach. Working assumption: Apache-2.0. Do not add or change it.
- Confirmation that the agent may push branches and open PRs in that repository. The agent must not touch `InductAI/induct` or any other repository.

## Goal

Prove, with measured evidence, that a thin CLI can turn an ordinary Playwright run into a signed, verifiable receipt using only existing standards and GitHub primitives, with no custom runner, no custom signing, and no hosted service.

## Non-goals for M1

No MCP server, no skill, no check run, no `prove verify` action, no ruleset changes, no failure packet, no ledger, no UI, no multi-framework support beyond what CTRF already gives for free, and no code copied from the Induct repository. Nothing in M1 needs Induct code.

## Deliverables

1. `packages/cli` (TypeScript, Node 22, pnpm) exposing two commands:
   - `prove run -- <test command>`: runs the given command, requires a CTRF report at a configurable path, computes sha256 of the CTRF file and of every artifact under the configured Playwright output directory (traces, videos, screenshots), and writes `prove/receipt.json`.
   - `prove attest`: in GitHub Actions, invokes `actions/attest` in custom-predicate mode with the receipt as predicate and the CTRF file as subject. Outside Actions, writes the receipt with `"signed": false` and exits 0 with a visible warning.
2. `examples/sample-app`: a tiny web app (static or Next, agent's choice, smallest that works) with two Playwright tests. One passes; the other fails when `PROVE_SAMPLE_BREAK=1` is set. Uses `playwright-ctrf-json-reporter`.
3. `.github/workflows/prove.yml`: on `pull_request` and `push` to main, runs `prove run`, then `prove attest`, uploads the Playwright artifacts as a workflow artifact with 90-day retention, and prints the attestation URL. Permissions exactly: `contents: read`, `id-token: write`, `attestations: write`.
4. `README.md`: from clone to a verified receipt in under 15 minutes, every command copy-pasteable.
5. `SPIKE-REPORT.md` with the measured facts listed under "Report".

## Receipt design (decide in M1, keep it small)

- Statement: in-toto Statement v1. Subject: the CTRF report file, `sha256` digest, name `ctrf.json`.
- Predicate type: `https://Praxso/prove/receipt/v0.1` (placeholder URI; make it a single constant).
- Predicate body:
  - `testResult`: an object conforming to the in-toto Test Result predicate v0.1 (`result`, `configuration`, `url`, `passedTests`, `warnedTests`, `failedTests`), populated from CTRF.
  - `source`: `{ "commit": "<40-hex sha1>", "dirty": boolean, "ref": "<ref or null>" }`.
  - `target`: `{ "buildSha": "<sha or null>", "url": "<base url or null>" }`. In M1 this is null unless `--target-url` is given, in which case fetch `<url>/healthz` or a configurable path and record what it returns; do not fail on it in M1.
  - `artifacts`: array of `{ "path", "sha256", "bytes", "kind": "trace" | "video" | "screenshot" | "report" }`.
  - `tool`: `{ "name": "prove", "version" }`, `ctrf`: `{ "specVersion", "tool", "summary" }`, `createdAt`.
- Fail-closed rule in M1: `prove run --expect-sha <sha>` exits non-zero before running tests when `HEAD` differs from `<sha>`, and when the working tree is dirty unless `--allow-dirty` is set. Record both behaviors in the report.
- Optionally also emit a second, pure in-toto Test Result attestation (predicate type `https://in-toto.io/attestation/test-result/v0.1`) for interoperability. Do this only if it costs under an hour; note the outcome either way.

## Exit tests (all must be demonstrated in the report with command output)

1. On a green run in Actions: `gh attestation verify ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1 --signer-workflow Praxso/prove/.github/workflows/prove.yml` succeeds, and `--format json` shows the predicate with the correct commit.
2. On a red run (`PROVE_SAMPLE_BREAK=1`): the receipt records `result: FAILED` with the failing test named, the attestation still verifies, and the workflow exit code is non-zero.
3. Offline: `gh attestation download` plus `gh attestation trusted-root`, then `gh attestation verify --bundle ... --custom-trusted-root ...` succeeds with the network disabled or the bundle moved to a clean directory.
4. Tamper: edit one byte of `ctrf.json` after attestation; verify fails. Edit the receipt's commit field in a local copy; show that the signed bundle still carries the original and the local edit is detectable.
5. Fail-closed: `prove run --expect-sha <wrong sha>` exits non-zero without running tests; a dirty tree without `--allow-dirty` exits non-zero.
6. Local unsigned path: `prove attest` outside Actions produces `signed: false` and a warning, exit 0.
7. Fresh-clone timing: a second agent, or the same agent in a clean directory, follows the README from clone to exit test 1 and records wall-clock time. Target under 15 minutes; report the actual.

## Constraints

- Public repo only. If any step needs a private repo, stop and note it; artifact attestations on private repos require GitHub Enterprise Cloud.
- No secrets, no long-lived keys, no self-hosted runner. Signing is Sigstore keyless via the workflow OIDC identity only.
- Pin every action to a full commit SHA. Pin dependency versions. Commit a lockfile.
- No screenshots or videos pushed to any repository. Artifacts go only to workflow artifacts.
- Do not post images anywhere. Links only.
- Small commits, one concern each, conventional messages. Open one PR per milestone within the spike so the workflow runs on `pull_request`.

## Report (`SPIKE-REPORT.md`)

Record measured facts, not impressions:

- Wall-clock elapsed per deliverable and total agent execution time as best the session can measure.
- Exit test results with the exact commands and trimmed outputs.
- Every point where a standard or primitive did not do what the design assumed (for example `actions/attest` subject constraints, predicate schema rejections, `gh` version requirements, CTRF reporter gaps). These drive M2 scope.
- Size of the CLI in lines, and the dependency list with licenses.
- The fresh-clone time.
- Open decisions for Zach: final name, predicate URI domain, whether to keep the dual-attestation output, and whether `--target-url` attestation should become fail-closed in M2.

## Stop conditions

Stop early and report if: `actions/attest` cannot accept the custom predicate after two documented attempts; `gh attestation verify` cannot enforce the predicate type; or the CTRF Playwright reporter cannot produce a report in a form the CLI can consume. Each of these is a finding, not a failure of the spike.

## References the session should read first

- in-toto Test Result predicate: https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md
- `actions/attest` README (custom predicate mode, permissions): https://github.com/actions/attest
- `gh attestation verify` manual: https://cli.github.com/manual/gh_attestation_verify
- Offline verification guide: https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline
- CTRF and the Playwright reporter: https://ctrf.io/
- Playwright CI setup: https://playwright.dev/docs/ci-intro
