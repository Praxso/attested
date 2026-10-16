# Requiring `attested verify` with a ruleset

> The hardened setup is an organization ruleset that requires the verify **workflow** by identity: see [rulesets/README.md](rulesets/README.md). This page covers the action's rules, the head rule, and the weaker repository-ruleset form, which only requires a check name.

`attested verify` is a composite action (`action.yml` at the root of this repo) that a repository runs as its own job and then requires in a branch ruleset. It passes only when all of these hold, and otherwise fails with one line naming the rule that failed:

| Rule | Failure line starts with |
|---|---|
| The receipt (`ctrf.json` from the attested run's workflow artifact) exists | `no receipt:` |
| An attestation exists for its sha256 digest | `no attestation found for sha256:...` |
| The attestation has predicate type `https://praxso.ai/attested/v0.1` | `predicate type mismatch:` |
| `gh attestation verify` accepts it, with `--signer-workflow` set to the attesting workflow | `verification failed for sha256:...` |
| The accepted attestation's certificate names the exact run that produced the receipt (`runInvocationURI`) and the expected ref (`sourceRepositoryRef`: `refs/pull/<N>/merge`, or `refs/heads/main` on push). Every returned attestation is checked; none is taken by position. | `no attestation from run <id> on <ref>` |
| Head rule: `source.commit` or `source.headCommit` equals the head being verified | `SHA mismatch:` |
| `testResult.result` is `PASSED`, or `WARNED` (passes with a warning annotation: skipped, flaky, or other non-failed tests). `FAILED` fails. | `result FAILED:` |
| A result is present and is one of `PASSED`, `WARNED`, `FAILED` | `result missing:` / `result unknown:` |
| The `attested run` job's test step did not fail (when `required.sh` found the run) | `test command failed:` |
| The run is not an unsigned fork run (unless `allow-unsigned: true`) | `unsigned run from fork` |

## Workflow

In this repository the verify job is [`.github/workflows/attested-verify.yml`](../.github/workflows/attested-verify.yml), which never runs PR code and finds the receipt of the `attested` run on the PR head itself; see [rulesets/README.md](rulesets/README.md). In another repository, the minimal form is a job named `attested verify` that downloads the receipt artifact and runs the action:

```yaml
  verify:
    name: attested verify
    needs: run
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    permissions: { contents: read, attestations: read }
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        continue-on-error: true
        with: { name: "attested-${{ github.sha }}", path: receipt }
      - uses: Praxso/attested@<full commit sha>
        with: { subject-path: receipt/attested/ctrf.json }
```

## Ruleset

Repository → Settings → Rules → Rulesets → New branch ruleset, or with `gh`:

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{
  "name": "attested verify required",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "attested verify", "integration_id": 15368 }
        ]
      }
    }
  ]
}
EOF
```

- `context` is the job's `name:`, `attested verify`. It is not the `attested` check run that `attested check` posts; that one is for humans and is not required.
- `integration_id: 15368` is the `github-actions` app. In the UI this is the "GitHub Actions" source picked next to the check name. Pinning the source means a commit status or check run with the same name from any other app, or from a personal access token through the statuses API, does not satisfy the rule.

## Why the head rule

On `pull_request`, Actions checks out and runs on `refs/pull/N/merge`, a synthetic merge commit of the PR head into the base branch. `GITHUB_SHA` is that merge commit, so the receipt's `source.commit` and the Sigstore certificate's `sourceRepositoryDigest` both name a commit that is not on the branch and changes whenever the base branch moves (M1 finding 4). A rule of "`source.commit` equals the PR head" would therefore fail every pull request.

`attested run` also records `source.headCommit`, the PR head sha from the event payload (`pull_request.head.sha`), and that value is inside the signed predicate. `attested verify` takes the head being verified from the same place (or `github.sha` on `push`) and passes when either `source.commit` (push runs, where the tested commit is the head) or `source.headCommit` (pull_request runs) equals it. A receipt from another commit, for example one replayed from `main`, fails with `SHA mismatch`. The pass line says which branch of the rule matched.

## What this does not protect against

A repository ruleset that requires the context `attested verify` is satisfied by any job of that name run by the `github-actions` app. A pull request runs the workflow files as they are in the PR, so it can remove the verify job, rewrite it, or add a same-named job that always passes. Pinning to the app only stops other apps and tokens. Use the organization ruleset in [rulesets/README.md](rulesets/README.md), which requires the workflow by identity from a pinned commit.

Forked pull requests get a read-only `GITHUB_TOKEN` and no OIDC token, so they produce no attestation; `attested verify` fails them with `unsigned run from fork` unless `allow-unsigned: true`. An Actions job cannot conclude `neutral`; with `allow-unsigned: true` the job passes with a `neutral:` warning annotation.

## Why the run and ref pin

`--signer-workflow` matches the workflow path on any ref. Anyone who can push a branch, including an agent running under a maintainer's account, could run `workflow_dispatch` on a branch whose copy of `attested.yml` signs a PASSED predicate over the exact bytes of a red run's `ctrf.json`. `gh attestation verify` would return both attestations, and the old script took the first. `attested verify` now accepts only an attestation from the run whose artifact it downloaded, on that run's ref. `verify/required.sh` passes both through the job environment (`ATTESTED_RUN_ID`, `ATTESTED_SOURCE_REF`); the action also takes `run-id` and `source-ref` inputs, and defaults to the current run and `github.ref`.
