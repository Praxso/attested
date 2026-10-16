# Organization ruleset: require `attested verify` as a workflow

A repository ruleset that requires the status check context `attested verify` (see [../ruleset.md](../ruleset.md)) can be satisfied by any job of that name, and a pull request controls the workflow files it runs. The hardened setup requires the verify **workflow** instead, through an organization ruleset. GitHub then runs `.github/workflows/attested-verify.yml` from Praxso/attested at a pinned commit and enforces it by workflow identity, so a PR cannot remove, rewrite, or impersonate it.

## Ruleset

[`org-attested-verify.json`](org-attested-verify.json), with `PIN_TO_MAIN_COMMIT_SHA` replaced by a commit on `main` that contains `attested-verify.yml`:

- `workflows` rule: source repository Praxso/attested (`repository_id` 1419845073), path `.github/workflows/attested-verify.yml`, `ref` `refs/heads/main`, `sha` pinned. Moving the pin is a deliberate org-admin change.
- Targets only the attested repository (`repository_id` condition) and its default branch.
- Bypass: organization admins only, in `pull_request` mode, which means a bypass is an explicit choice on a specific pull request.

Active as org ruleset 25127513, pinned to `2c60bab19fc69af58678058d67da036859334b89`, the verifier hardening in [#31](https://github.com/Praxso/attested/pull/31). Earlier pins: `226831a765176521b81f597fa4146363dd435be7` ([#26](https://github.com/Praxso/attested/pull/26)) and `351af3292fde457e4a12d51a30004b0e3c983b35` ([#17](https://github.com/Praxso/attested/pull/17)). Check the live pin with `gh api orgs/Praxso/rulesets/25127513 --jq '.rules[].parameters.workflows[]?.sha'`. Apply it as an organization admin (`admin:org` scope):

```bash
gh api -X POST orgs/Praxso/rulesets --input docs/rulesets/org-attested-verify.json
```

GitHub runs ruleset workflows on `pull_request`, `pull_request_target`, and `merge_group`, ignoring `branches`/`paths`/`types` filters. `attested-verify.yml` uses `pull_request` only: the `attested` workflow does not run on merge groups, so a merge-group run would never find a receipt. Applying the rule blocks direct pushes to `main`.

## What the workflow does

1. Checks out Praxso/attested at `github.workflow_sha` (the workflow's own commit) into `attested-src/`. It never checks out the PR. The first log line of the receipt step prints the workflow ref and sha it runs from, and says whether it is the PR's own copy (`@refs/pull/...`, informational) or the ruleset/default-branch copy.
2. Reads the PR from the API and fails unless it belongs to this repository, targets the default branch, and still has the event's head.
3. Fails with `attesting workflow changed in this PR; merge requires an explicit admin bypass after review (<path>)` when a protected file's blob sha at the PR head differs from the one at the PR base commit. Each blob sha comes from the contents API (`contents/<path>?ref=<sha>`), not from the PR's file listing, which is capped. An API error, a missing file, or a response without a blob sha fails closed. The list is the `PROTECTED_PATHS` constant in [`verify/required.sh`](../../verify/required.sh): `.github/workflows/attested.yml` and `.github/workflows/attested-verify.yml`. The CLI sources are deliberately not on it: in this repository the CLI is the code under test.
4. Waits up to 10 minutes for the `attested` workflow run on the PR head sha to complete. If the run lists pull requests, it must list this PR with the default branch as base.
5. Reads the `attested run` job of that run from the Actions API. It must have succeeded, or failed at its `attested run` test step only; cancelled, timed out, skipped, missing, or failed at another step fails verify. A test-step failure is passed to the action, which then fails even if the receipt says PASSED.
6. Downloads the run's `attested-*` artifact (`actions: read`).
7. Runs the `attested verify` action from `attested-src/` with `--signer-workflow Praxso/attested/.github/workflows/attested.yml`, enforcing the rules in [../ruleset.md](../ruleset.md): attestation exists and verifies, it comes from the exact `attested` run found in step 4 on `refs/pull/<N>/merge`, predicate type, head rule, result PASSED or WARNED (missing or unknown fails), forks unsigned.

Observed with the ruleset active (PRs #18 to #21): GitHub ran only the ruleset copy of `attested-verify.yml` on each PR (its own workflow id, 384961159, not the repository's 384955763), with `github.workflow_ref` `...attested-verify.yml@refs/heads/main` and `github.workflow_sha` equal to the pinned commit. The PR's own copy did not get a separate run. If it ever does, its log says `mode: this is the PR's own copy` and it is not the enforced one. `gh run view` returns 404 for ruleset workflow runs, because the workflow id is not in the repository's workflow list; read their logs with `gh api repos/OWNER/REPO/actions/jobs/<job id>/logs`.

## What it guarantees, and what it does not

- The verify decision runs from the pinned default-branch commit. A PR cannot replace it, remove it, or satisfy it with a same-named job.
- A PR that edits the attesting workflow, or the verify workflow, is blocked until an org admin bypasses it after review.
- Test files are PR-controlled by nature. A PR can weaken or delete a test, and the receipt will honestly say the remaining tests passed. Review test changes like any other code.
- Anyone with admin rights can bypass rulesets. That includes an agent running under an admin's account or token. The real boundary for agents is a separate, non-admin bot identity (a machine user or GitHub App with write but not admin) that cannot bypass.
