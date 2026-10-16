# M2 report: `attested check`, `attested verify`, failure packet, MCP server, listings

Date: 2026-10-14. Brief: [docs/spikes/m2-brief.md](docs/spikes/m2-brief.md). Repo: [Praxso/attested](https://github.com/Praxso/attested) (public).

## Result in one line

Seven of eight exit tests pass on real GitHub runs. Exit test 5 (forks) passes only in simulation, because no fork was created. No stop condition was hit: `GITHUB_TOKEN` created check runs on the first attempt, the head rule separates every case, and the plugin-only Claude Code session completed with no human message. Nothing was submitted to a third party.

## Time

Agent execution, wall clock, UTC, from shell and PR timestamps:

| Deliverable | Start | End | Elapsed |
|---|---|---|---|
| Read brief, M1 report, references | 23:21 | 23:24 | 3 min |
| A. `attested check` (PR #4) | 23:24 | 23:28 | 4 min |
| B. `attested verify`, head rule, ruleset docs (PR #5), ruleset applied | 23:27 | 23:32 | 5 min |
| C. Failure packet (PR #6), exit-test-3 fixture PRs #7 to #9, one verify fix | 23:31 | 23:40 | 9 min |
| D. MCP server, plugin, Codex skill (PR #10) | 23:34 | 23:42 | 8 min |
| Exit test 6, two attempts (PR #11) | 23:41 | 23:46 | 5 min |
| E/F. README, SECURITY.md, listings (PR #12), README fix (PR #14) | 23:43 | 23:49 | 6 min |
| Exit test 7, two attempts (PRs #13, #15) | 23:46 | 23:51 | 5 min |
| This report | 23:51 | 23:56 | 5 min |
| **Total** | | | **about 35 min** of the 5-day box |

The ranges overlap because the agent kept working while Actions runs were in flight. Each workflow run takes 60 to 75 s.

## Exit tests

### 1. Green PR shows the `attested` check with success, the verify command, and an artifact link; no image anywhere: PASS

PR #4, check run [116159772448](https://github.com/Praxso/attested/runs/116159772448):

```
$ gh api repos/Praxso/attested/check-runs/116159772448 --jq '{name,head_sha,conclusion,app:.app.slug,images:.output.images}'
{"app":"github-actions","conclusion":"success","head_sha":"7489919dd9c226798c75d9785d888462cdeed6b2","images":null,"name":"attested"}
```

`head_sha` is the PR head, not the merge commit. The summary is a text table (verdict, commit tested, target build, counts, subject digest, artifact link, attestation link, run link) plus:

```bash
gh run download 38654061979 --repo Praxso/attested --name attested-713747b4... --dir attested-receipt
gh attestation verify attested-receipt/attested/ctrf.json --repo Praxso/attested --predicate-type https://praxso.ai/attested/v0.1 --signer-workflow Praxso/attested/.github/workflows/attested.yml
```

### 2. Red PR shows failure with the packet inline, under 12 KB, redaction proven: PASS

- PR #7 (planted greeting typo): check run [116161624302](https://github.com/Praxso/attested/runs/116161624302), conclusion `failure`, `images: null`, packet 1,660 bytes inline.
- Red dispatch on `main` with `break=true` (run [38655668903](https://github.com/Praxso/attested/actions/runs/38655668903)): check run 116165032393, packet 2,048 bytes, showing masking on real browser data:

```json
"console": [
  { "level": "error", "message": "Failed to load resource: the server responded with a status of 500 (Internal Server Error)", "count": 1 },
  { "level": "error", "message": "greeting service failed for [EMAIL] with token=[REDACTED]", "count": 1 }
],
"network": [ { "method": "GET", "path": "/api/greeting", "status": 500, "count": 1 } ],
"rerun": "attested run --expect-sha fe8a3d6a... -- pnpm exec playwright test"
```

The page logged `ops@example.com` with `token=sample-not-a-secret` and requested `/api/greeting?key=sample-not-a-secret#frag`. `grep` for the raw values in the packet finds 0 matches. The fixture test (`packages/cli/test/packet.test.mjs`) covers bearer, `key=` in a URL query and in text, `token=`, email, GitHub PAT, JWT, JSON `"password"`, and ANSI. It also checks that 50 identical failures collapse to one group with `count: 50`, that 40 distinct failures truncate to 12 KB or less with `truncated` recording the cut, and that the output is byte-for-byte deterministic.

### 3. Ruleset requiring `attested verify` blocks no receipt, SHA mismatch, red; passes green: PASS

Ruleset 25125161 "attested verify required" on the default branch, `required_status_checks` with context `attested verify` and `integration_id` 15368 (github-actions). All four cases are real PRs:

| PR | Setup | `mergeStateStatus` | `attested verify` line |
|---|---|---|---|
| #8 | workflow skips signing | BLOCKED | `FAIL: no attestation found for sha256:b76627b8... in Praxso/attested (receipt was never signed)` |
| #9 | verify job downloads main's signed receipt | BLOCKED | `FAIL: SHA mismatch: receipt source.commit 41ce398d... and source.headCommit none, but the head being verified is 8a3cea8f...` |
| #7 | real app bug | BLOCKED | `FAIL: result FAILED: the signed receipt for 1154da30... records failing tests (chromium,greeting.spec.ts > home page greets the visitor)` |
| #6 | green | CLEAN | `PASS: sha256:d6f77b85... signed by Praxso/attested/.github/workflows/attested.yml, predicate https://praxso.ai/attested/v0.1, result PASSED; head rule: source.headCommit == 56fb37f1... (pull_request run: source.commit e6c6c34f... is the synthetic merge commit)` |

#7 to #9 were closed unmerged; their branches are kept.

### 4. `pull_request` and `push` both verify, with the head rule in the output: PASS

```
# pull_request, PR #5 (run 38654316210)
attested verify: PASS: ... head rule: source.headCommit == 45048bf5... (pull_request run: source.commit 410bae89... is the synthetic merge commit)
# push to main, c33a9ad (run 38655695188)
attested verify: PASS: ... head rule: source.commit == c33a9ad7... (push-style run: the attested commit is the head)
```

[docs/ruleset.md](docs/ruleset.md) explains why.

### 5. Forked PR: PASS IN SIMULATION ONLY

No fork was created. A real fork would be a new public repository under someone's account, which the brief did not authorize. Instead:

- `attested check`, `packages/cli/test/check.test.mjs`: with an event payload whose head repo differs from the base, it calls no API, prints `### attested: PASSED` and `::notice title=attested check::forked pull request: GITHUB_TOKEN is read-only, so no check run was created ...`, and exits 0. A mocked HTTP 403 takes the same path.
- `attested verify`, `packages/cli/test/verify.test.mjs` with a stub `gh` returning 404: `FAIL: unsigned run from fork someone/r: forked pull requests get no OIDC token, so the run could not be signed and no attestation exists (set allow-unsigned: true to allow)`, exit 1. With `ALLOW_UNSIGNED=true`: `::warning title=attested verify::neutral: unsigned run from fork ...`, exit 0.
- The workflow skips both `actions/attest` steps when `github.event.pull_request.head.repo.fork` is true, so a fork run reaches verify instead of failing at signing.

Open item: run this once with a real fork.

### 6. Behavioral MCP test: PASS (second attempt)

`claude -p` (Opus 5.5) in a clean worktree, with `--plugin-dir` set to a copy of `plugins/attested` whose `.mcp.json` points at the local build, because the npm package is not published. `--setting-sources project` was set, so no user MCP servers or plugins loaded: the session listed exactly `attested_run`, `attested_packet`, and `attested_status`, plus built-in skills. Allowed tools: the three MCP tools, Read, Edit, Grep, Glob, `Bash(git:*)`, `Bash(gh pr:*)`. One prompt, no further messages: "The Playwright tests for examples/sample-app are failing on branch exit6-base. Get them passing and open a pull request against exit6-base."

Transcript summary (14 turns, 53 s, $0.29):

1. Loaded the `attested:attested` skill.
2. Compared branches and read the sample app and tests.
3. `attested_run` → `FAILED`, 1 failed, packet inline (`Expected: "Hello from sample-app"`, `Received: "Hello from sampel-app"`, `tests/greeting.spec.ts` line 6).
4. Fixed `server.mjs` (Edit). A `sed` attempt was denied by permissions.
5. `attested_run` → `PASSED`, subject sha256 `bbd7f78b...`.
6. Committed, pushed, and opened [PR #11](https://github.com/Praxso/attested/pull/11) with `attested: PASSED locally, ctrf.json sha256 bbd7f78b...` in the body, then edited the body to remove stray backslashes.

On PR #11, `attested` passed and `attested verify` printed `PASS ... head rule: source.headCommit == d02e87db...`. The PR was closed unmerged because it targets a throwaway branch.

Deviations:

- The brief says to point the agent at the sample app with `ATTESTED_SAMPLE_BREAK=1`. That switch breaks the server from the environment, so no code change can turn it green. The test planted the same symptom as a code bug (a greeting typo) in a commit on a base branch.
- Attempt 1 put the bug in the agent's own last commit and asked for a PR against `main`. The agent read `git show HEAD`, fixed the typo before running anything, saw that `main` was already correct, and declined to open an empty PR. That was right of the agent and a flaw in the test. It is kept as `exit6-attempt1` in the session notes.
- In attempt 2 the agent guessed the cause from the source before the red run. The packet confirmed the cause; it did not discover it. A bug whose cause is not visible in the diff would test the packet harder.

### 7. Fresh clone to a passing `attested verify` on a PR, README verbatim: PASS (second attempt), 89 s

Empty pnpm store (`npm_config_store_dir`) and empty Playwright browser cache (`PLAYWRIGHT_BROWSERS_PATH`), both in a temp directory:

| Step | Time |
|---|---|
| 1. Clone, install, build | 3 s |
| 2. Chromium download plus local run, PASSED receipt | 11 s |
| 3a. Branch, empty commit, push, `gh pr create` ([PR #15](https://github.com/Praxso/attested/pull/15)) | 4 s |
| 3b. Wait for `attested verify` to pass (one Actions run) | 71 s |
| **Total** | **89 s** |

Attempt 1 (PR #13) failed at step 3b: `gh pr checks --watch --required` ran 3 s after the PR opened and exited with `no checks reported`. PR #14 changed the README to wait for the check to register first.

### 8. Zero runtime dependencies in the CLI; MCP dependencies with licenses: PASS

`@praxso/attested` has `"dependencies": {}`, uses only Node 22 built-ins, and reads trace zips with its own reader built on `node:zlib`. `@praxso/attested-mcp` speaks JSON-RPC itself, with no MCP SDK:

| Package | Version | License | Kind |
|---|---|---|---|
| @praxso/attested | 0.1.0 (`workspace:*`, rewritten on publish) | Apache-2.0 | runtime, the only one; itself zero-dependency |
| typescript | 5.9.3 | Apache-2.0 | dev |
| @types/node | 22.20.5 | MIT | dev |

`attested verify` is a composite action running bash, `gh`, and `jq`, all preinstalled on GitHub-hosted runners.

## Where a primitive did not do what the design assumed

1. **Check-run name collision.** The M1 job was named `attested`, so its job check had the same name as the `attested` check run. It is renamed `attested run`, and the verify job is `attested verify`.
2. **A required status check pinned to `github-actions` is satisfied by any job of that name.** A pull request, from a branch or a fork, runs the workflow as it is in the PR and can replace or remove the verify job, or add a same-named one. Pinning to the app only stops other apps and tokens. **Hardened after M2:** the `verify` job left `attested.yml`; `.github/workflows/attested-verify.yml` is meant to be required by an organization ruleset (workflows rule, pinned commit; [docs/rulesets/README.md](docs/rulesets/README.md)). It checks out the verifier at its own commit, never runs PR code, waits for the `attested` run on the PR head and downloads its receipt, and blocks PRs that change `attested.yml` or itself pending an admin bypass. The guarantee is now that the verify decision runs from the default-branch commit and a PR cannot replace it. What remains: test files are PR-controlled by nature, and any admin identity can bypass rulesets, including agents running under Zach's account. The real boundary for agents is a separate non-admin bot identity.
3. **Actions jobs cannot conclude `neutral`.** `allow-unsigned: true` passes with a `neutral:` warning annotation. Fork tokens cannot create check runs, so a real neutral check run is not possible there either.
4. **Workflow artifacts in a public repository are readable by any signed-in GitHub user.** The brief's "repo-private" holds only for private repositories. The check summary and SECURITY.md now say that artifact access follows the repository's visibility.
5. **`gh api` prints the 404 body on stdout and exits 1.** The first verify script treated that body as a list of predicate types, so PR #8's first run said "predicate type mismatch ... {"message":"Not Found"...}". Fixed in PR #6 with a regression test.
6. **Trace and CTRF layout.** Playwright 1.64 names trace entries `N-trace.trace` and `N-trace.network`, not `trace.trace`. `playwright-ctrf-json-reporter` 0.2.0 has no `line` field, so the line is taken from the first stack frame in the test file. `suite` is an array, so names still read `chromium,greeting.spec.ts > ...`.
7. **`claude -p --strict-mcp-config` drops a plugin's MCP servers**: the skill loads but the tools do not. `--setting-sources project` isolates the session instead.
8. **`.gitignore` `attested/` matched the new `plugins/attested/` and `codex/skills/attested/`.** It now ignores only `/attested/` and `examples/*/attested/`.
9. **The Actions Marketplace has no API.** Publishing needs a release created on github.com with the Marketplace box ticked, plus the org owner's acceptance of the Marketplace Developer Agreement and 2FA. `action.yml` is ready, with root location, unique name, and branding, but the click is Zach's.
10. **Outreach targets do not exist as described.** The CTRF integrations list is on ctrf.io, whose source is not in a public `ctrf-io` repository, so the patch adds a line to the `ctrf-io/ctrf` README instead. The Playwright MCP README has no related-tools section, so the patch adds one, which maintainers may decline.

## Size and dependencies

| Part | Lines |
|---|---|
| CLI, `packages/cli/src/*.ts` plus launcher (`check.ts` 130, `packet.ts` 218 new) | 862 |
| MCP server, `packages/mcp/src/index.ts` plus launcher | 202 |
| Verify action, `action.yml` plus `verify/verify.sh` | 116 |
| Skill, `plugins/attested/skills/attested/SKILL.md` (Codex copy identical) | 42 |
| Tests: 25 CLI (check, verify, packet, target-url), 3 MCP | |

Actions are pinned to commit SHAs. New in M2: `actions/download-artifact` v8.0.2 at `9000827ccba6bdab643e8b6fd33ac0654aef8333`.

## Listings: prepared, not submitted

All texts are in [docs/outreach/README.md](docs/outreach/README.md):

- MCP registry: `packages/mcp/server.json`, `io.github.Praxso/attested`. Needs npm publish, then Zach's approval.
- Claude Code: this repo is a marketplace (`/plugin marketplace add Praxso/attested`). The directory entry text is ready for Zach.
- Codex skill directory: entry text ready for Zach.
- Actions Marketplace: ready, needs the release-page click (finding 9).
- CTRF and Playwright MCP: patch files plus PR titles and bodies for Zach to open.

## Open decisions for Zach

1. **Publish to npm.** `@praxso/attested` and `@praxso/attested-mcp` 0.1.0. Every MCP config snippet and the plugin's `.mcp.json` assume `npx -y @praxso/attested-mcp@0.1.0`, which fails until then.
2. **Approve the listing texts** (registry, plugin directory, Codex) and open the two outreach PRs.
3. **Publish `attested verify` to the Actions Marketplace** from the release page.
4. **Harden the required check**: done in code (finding 2). Remaining: apply the organization ruleset from `docs/rulesets/org-attested-verify.json` with the pinned sha, then run the four hardening exit tests. Agents should also move to a non-admin bot identity.
5. **Repository ruleset 25125161** requires the context `attested verify`, which the PR's own copy of `attested-verify.yml` now provides. It is redundant and spoofable once the organization ruleset is live; delete it then.
6. **Real fork test** for exit test 5: allow a fork under a test account.
7. **`attested_run` defaults to `allow_dirty: true`** so an agent can iterate before committing; the receipt records `dirty: true`. Keep it, or make the agent opt in?
8. **Cleanup**: branches `m2-exit-red`, `m2-exit-unsigned`, `m2-exit-replay`, `exit6-base`, and `exit6-agent` are kept as evidence. Delete them when no longer needed.

## Hardened required check

After M2, the verify decision moved out of the PR-controlled `attested.yml` into `.github/workflows/attested-verify.yml` ([PR #17](https://github.com/Praxso/attested/pull/17), merged with Zach's admin bypass as `351af3292fde457e4a12d51a30004b0e3c983b35`). Org ruleset 25127513 "attested verify (required workflow)" requires it by workflow identity, pinned to that commit, for this repository only, with OrganizationAdmin bypass in pull-request mode. Repo ruleset 25125161 (required check name only) was deleted. The guarantee: the verify decision runs from the pinned default-branch commit, a PR cannot replace or imitate it, and a PR that edits the attesting workflow is blocked pending an admin bypass. Remaining limits: test files are PR-controlled by nature, and any admin identity, including an agent under Zach's account, can bypass rulesets; a separate non-admin bot identity for agents is the real boundary.

Exit tests, 2026-10-15, no `--admin`, no ruleset changes. In every run below the verifier logged `verify code from Praxso/attested/.github/workflows/attested-verify.yml@refs/heads/main @ 351af3292fde457e4a12d51a30004b0e3c983b35`, `mode: ruleset or default-branch copy (verify code is not taken from the PR)`, and `HEAD is now at 351af32` for its checkout. So **`github.workflow_sha` resolved to the pinned commit under the ruleset**, not to the PR's merge commit.

| Test | PR | Ruleset run result | Merge attempt |
|---|---|---|---|
| 1. Normal green PR merges | [#18](https://github.com/Praxso/attested/pull/18) | `PASS: sha256:92ce797d... signed by Praxso/attested/.github/workflows/attested.yml ... result PASSED; head rule: source.headCommit == 4c09f184...` | `gh pr merge 18 --squash`: merged as `07c4a84` |
| 2. Red PR is blocked | [#19](https://github.com/Praxso/attested/pull/19) | `FAIL: result FAILED: the signed receipt for fec6a0ac... records failing tests (chromium,greeting.spec.ts > home page greets the visitor)` | `X Pull request Praxso/attested#19 is not mergeable: the base branch policy prohibits the merge.` |
| 3. Fake always-passing `attested verify` job plus red tests | [#20](https://github.com/Praxso/attested/pull/20) | The fake job (`fake-verify.yml`, check 116185428954) **succeeded**; the ruleset run failed with `FAIL: result FAILED: the signed receipt for 508af5c0... records failing tests (...)` | `not mergeable: the base branch policy prohibits the merge.` |
| 4. PR edits `attested.yml` | [#21](https://github.com/Praxso/attested/pull/21) | `FAIL: attesting workflow changed in this PR; merge requires an explicit admin bypass after review (.github/workflows/attested.yml)` | `X Pull request Praxso/attested#21 is not mergeable: the base branch policy prohibits the merge.` |

#19 to #21 were closed unmerged; their branches are kept.

What behaved differently from the design:

- GitHub ran only the ruleset copy of `attested-verify.yml` on each PR (workflow id 384961159), not also the PR's own copy (384955763). The "informational second run" the design allowed for never appeared. `docs/rulesets/README.md` is corrected.
- `gh run view` returns HTTP 404 for ruleset workflow runs because their workflow id is not in the repository's workflow list. Logs come from `gh api repos/Praxso/attested/actions/jobs/<id>/logs`.
- Test 3's first push had a YAML error in the fake workflow (an unquoted `: `), so the fake job never ran. After the fix the fake job passed and the PR stayed blocked. The `attested` check run from `attested check` had attached itself to the invalid workflow's check suite. That is a known quirk of check runs created with `GITHUB_TOKEN`; it does not affect the verdict.
- `gh pr merge` on a blocked PR suggests `--admin`. Any admin identity can take that path, which is why agents should not run as admins.

## Signing job split

The hardened required check still trusted a receipt signed by `attested.yml`, and that job ran PR code (tests, config, dependencies, and in this repository the CLI itself) while holding `id-token: write`, `attestations: write`, and `checks: write`. PR code could therefore request the job's OIDC token and sign any predicate as `attested.yml`, or post its own green `attested` check. `attested.yml` is now two jobs:

- `attested run`: `contents: read` only. Runs the PR's tests and uploads `results-<sha>` (`ctrf.json`, `test-results/`, the Playwright config). The name must not start with `attested-`, because `verify/required.sh` takes the first such artifact as the receipt.
- `attested sign`: `needs: run`, with `id-token: write`, `attestations: write`, `checks: write`. Checks out attested at `github.event.pull_request.base.sha` (or `github.sha` on push), builds it without the dependency cache, downloads the results as data, and runs `attested attest --from-results`. That recomputes every digest, takes `source.commit` from `GITHUB_SHA` and `source.headCommit` from the event, sets `source.dirty` to `null`, and ignores any receipt the test job wrote. It then signs, uploads `attested-<sha>`, and posts the check.

The claim is now: A receipt proves this commit's own test suite reported this result, signed by a job that ran no PR code; it does not prove the change is correct. A PR can still weaken its own tests, or have a test write a passing `ctrf.json`. Follow-ups, not built: a test-disappearance check against the base branch's last receipt, and CODEOWNERS on test files. `--target-url` is not carried into the sign job yet, so split-mode receipts record `target` as null.

## Verify pinned to the attesting run

Review found that `verify/verify.sh` took `.[0]` of the attestations for the subject digest, and `--signer-workflow` matches the workflow path on any ref. A writer could therefore sign PASSED over a red run's `ctrf.json` bytes from a side branch with a modified `attested.yml` (via `workflow_dispatch`, outside any PR), and verify might pick that attestation. Now `verify/required.sh` exports the run id whose artifact it downloaded and `refs/pull/<N>/merge`. `verify.sh` considers every returned attestation and accepts only one whose certificate `runInvocationURI` names that run and whose `sourceRepositoryRef` is that ref; otherwise it fails with `no attestation from run <id> on <ref>`. Fixture tests cover a matching attestation, a forged one from another run and ref, both together in either order, the same run on another ref, and a run-id prefix.

## Exploit tests against the split jobs and the pinned verifier

Run on 2026-10-15 with org ruleset 25127513 pinned to `226831a` (PR #26). No `--admin`, no ruleset changes. Every verify log below begins with `HEAD is now at 226831a` and `verify code from Praxso/attested/.github/workflows/attested-verify.yml@refs/heads/main @ 226831a765176521b81f597fa4146363dd435be7`.

### A. PR test code ([#27](https://github.com/Praxso/attested/pull/27), closed unmerged)

The PR broke the greeting (a real failing test), added `tests/exploit.spec.ts`, and added a reporter listed after the CTRF reporter. Test job `attested run` log:

```
exploit: ACTIONS_ID_TOKEN_REQUEST_URL absent, ACTIONS_ID_TOKEN_REQUEST_TOKEN absent
exploit: no OIDC token can be requested, so nothing can be signed as attested.yml from this job
exploit: candidate tokens: GITHUB_TOKEN=absent, GH_TOKEN=absent, ACTIONS_RUNTIME_TOKEN=absent, git_extraheader=absent
exploit: rewrote attested/ctrf.json, 1 failed test(s) now marked passed
```

- **OIDC signing: failed.** The test job has no `id-token` permission, so the token request variables are not set and nothing can be signed as `attested.yml`.
- **Forged `attested` check: failed.** No token was reachable from test code: `GITHUB_TOKEN` is not in the step environment, `persist-credentials: false` leaves no git credential, and `ACTIONS_RUNTIME_TOKEN` is not exposed to `run` steps. No POST was possible. The only `attested` check on the PR is the one `attested sign` posted.
- **Forged `ctrf.json`: succeeded, the inherent limit.** The reporter flipped the failing test to passed and returned status passed, so `attested run` succeeded. `attested sign` faithfully signed what the suite reported (check title `PASSED: 3 tests: 3 passed, 0 failed, 0 other`), and verify passed: `attested verify: PASS: sha256:da902853... signed by Praxso/attested/.github/workflows/attested.yml in run 38829596455 on refs/pull/27/merge, ... result PASSED; head rule: source.headCommit == c1864bc5...`. The PR was CLEAN, mergeable without bypass. A receipt proves what the commit's own suite reported, not that the suite is honest. The planned mitigations are the test-disappearance check and CODEOWNERS on test and config files (`playwright.config.ts` and reporters included).

### B. Side-branch signing ([#28](https://github.com/Praxso/attested/pull/28), closed unmerged; branch `exploit-side` deleted)

#28 broke the greeting. Its run 38829599048 produced a signed FAILED receipt, and verify failed with `result FAILED`. A branch `exploit-side` then replaced `attested.yml` with a job that downloaded #28's receipt and signed a PASSED predicate over the same `ctrf.json` bytes, keeping #28's `source.commit`, `source.headCommit`, and `ref`. It ran via `workflow_dispatch` (run 38829785671, success, [attestation 56483893](https://github.com/Praxso/attested/attestations/56483893)):

```
exploit: forging PASSED over ctrf.json sha256:a04514d98ef277f467506082d1893923f18633f5b3289b059b1592a5cf5a2da8
{"result":"PASSED","source":{"commit":"e11c62d3...","headCommit":"1d5de8b6...","dirty":null,"ref":"refs/pull/28/merge"}}
```

`gh attestation verify --signer-workflow Praxso/attested/.github/workflows/attested.yml` accepted both, and listed the forgery first, so the pre-#26 `.[0]` selection would have passed this PR:

```
{"run":".../actions/runs/38829785671/attempts/1","ref":"refs/heads/exploit-side","result":"PASSED"}
{"run":".../actions/runs/38829599048/attempts/1","ref":"refs/pull/28/merge","result":"FAILED"}
```

After the forgery, verify was re-run on #28 (attempt 2, job 116745840610): `attested verify: FAIL: result FAILED: the signed receipt for 1d5de8b6... records failing tests (chromium,greeting.spec.ts > home page greets the visitor)`. The pinned verifier selected the attestation from run 38829599048 on `refs/pull/28/merge` and ignored the forgery. `gh pr merge 28 --squash`: `X Pull request Praxso/attested#28 is not mergeable: the base branch policy prohibits the merge.`

The forged attestation stays in the repository's attestation store and the public transparency log. It is harmless to `attested verify`, but a consumer that runs bare `gh attestation verify` without pinning the run and ref would accept it. Verify receipts with `attested verify`, or check `runInvocationURI` and `sourceRepositoryRef` yourself.
