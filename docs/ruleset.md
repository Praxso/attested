# Requiring `attested verify` with a ruleset

`attested verify` is a composite action (`action.yml` at the root of this repo) that a repository runs as its own job and then requires in a branch ruleset. It passes only when all of these hold, and otherwise fails with one line naming the rule that failed:

| Rule | Failure line starts with |
|---|---|
| The receipt (`ctrf.json` from the attested run's workflow artifact) exists | `no receipt:` |
| An attestation exists for its sha256 digest | `no attestation found for sha256:...` |
| The attestation has predicate type `https://praxso.ai/attested/v0.1` | `predicate type mismatch:` |
| `gh attestation verify` accepts it, with `--signer-workflow` set to the attesting workflow | `verification failed for sha256:...` |
| Head rule: `source.commit` or `source.headCommit` equals the head being verified | `SHA mismatch:` |
| `testResult.result` is not `FAILED` | `result FAILED:` |
| The run is not an unsigned fork run (unless `allow-unsigned: true`) | `unsigned run from fork` |

## Workflow

The verify job lives in the same workflow as the job that runs `attested run` and signs the receipt. See [`.github/workflows/attested.yml`](../.github/workflows/attested.yml) for the full file; the verify job is:

```yaml
  verify:
    name: attested verify          # this is the status check context the ruleset requires
    needs: run
    if: ${{ !cancelled() }}        # runs after a red test job too, so a red receipt is reported as red
    runs-on: ubuntu-latest
    permissions:
      contents: read
      attestations: read
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        continue-on-error: true    # a missing artifact becomes the "no receipt" rule, not an obscure error
        with:
          name: attested-${{ github.sha }}
          path: receipt
      - uses: Praxso/attested@<full commit sha>
        with:
          subject-path: receipt/attested/ctrf.json
          # signer-workflow: <owner>/<repo>/.github/workflows/attested.yml   (default)
          # allow-unsigned: true                                             (forks pass as neutral)
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

The required check is satisfied by any job named `attested verify` in a workflow run by the `github-actions` app on the PR head. A pull request, from a same-repository branch or from a fork, runs the workflow files as they are in the PR, so it can replace that job with one that always passes. Pinning to the app stops other apps and tokens, not the PR's own workflow. Close the gap with one of:

- an organization ruleset with "Require workflows to pass before merging" pointing at the verify workflow on the default branch, which runs the workflow file from the default branch rather than from the PR;
- a `CODEOWNERS` entry for `.github/workflows/` plus "Require review from Code Owners" in the same ruleset, and for forks, Settings → Actions → "Require approval for all external contributors".

Forked pull requests get a read-only `GITHUB_TOKEN` and no OIDC token, so they produce no attestation; `attested verify` fails them with `unsigned run from fork` unless `allow-unsigned: true`. An Actions job cannot conclude `neutral`; with `allow-unsigned: true` the job passes with a `neutral:` warning annotation.
