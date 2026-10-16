#!/usr/bin/env bash
# Run by .github/workflows/attested-verify.yml, the workflow an org ruleset requires. It never runs PR code: it checks
# that the PR targets the default branch, blocks PRs that change the attesting workflow, waits for the `attested` run on
# the PR head, checks how its "attested run" job concluded, and downloads that run's receipt for the verify action. Writes `subject-path` to $GITHUB_OUTPUT.
set -uo pipefail

# Files whose change in a PR would let the PR redefine what gets signed or how it is verified. The CLI sources are not
# listed: in this repository the CLI is the code under test, so PRs must be able to change it.
PROTECTED_PATHS=(".github/workflows/attested.yml" ".github/workflows/attested-verify.yml")

REPO="${GITHUB_REPOSITORY:?}"
WAIT_SECONDS="${WAIT_SECONDS:-600}"
POLL_SECONDS="${POLL_SECONDS:-15}"
OUT="${RECEIPT_DIR:-receipt}"
PR="$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH:?}")"
HEAD="$(jq -r '.pull_request.head.sha // empty' "$GITHUB_EVENT_PATH")"

fail() { echo "::error title=attested verify::$1"; echo "attested verify: FAIL: $1"; exit 1; }

echo "attested verify: verify code from ${WORKFLOW_REF:-unknown} @ ${WORKFLOW_SHA:-unknown}"
case "${WORKFLOW_REF:-}" in
  *@refs/pull/*) echo "attested verify: mode: this is the PR's own copy of the workflow (PR-controlled, informational); the org ruleset run is the enforced one" ;;
  *) echo "attested verify: mode: ruleset or default-branch copy (verify code is not taken from the PR)" ;;
esac

[ -n "$PR" ] && [ -n "$HEAD" ] || fail "not a pull_request event; attested verify only runs on pull requests"
[[ "$PR" =~ ^[0-9]+$ ]] && [[ "$HEAD" =~ ^[0-9a-f]{40}$ ]] || fail "malformed pull_request event (number $PR, head $HEAD)"
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# The PR, as the API reports it now, must target the default branch of this repository and still have this head.
DEFAULT="$(gh api "repos/$REPO" --jq '.default_branch // empty')" && [ -n "$DEFAULT" ] \
  || fail "could not read the default branch of $REPO"
read -r BASE_REF BASE_SHA PR_HEAD BASE_REPO < <(gh api "repos/$REPO/pulls/$PR" \
  --jq '"\(.base.ref // "-") \(.base.sha // "-") \(.head.sha // "-") \(.base.repo.full_name // "-")"' 2>/dev/null) \
  || fail "could not read PR #$PR"
[ "${BASE_REPO:-}" = "$REPO" ] || fail "PR #$PR does not belong to $REPO (base repository ${BASE_REPO:-unknown})"
[ "${BASE_REF:-}" = "$DEFAULT" ] || fail "PR #$PR targets ${BASE_REF:-unknown}, not the default branch $DEFAULT"
is_sha "${BASE_SHA:-}" || fail "could not read the base commit of PR #$PR"
[ "${PR_HEAD:-}" = "$HEAD" ] || fail "PR #$PR head is now ${PR_HEAD:-unknown}, not $HEAD; verify runs again for the new head"

# Compare each protected file's blob at the base commit and at the head commit, one contents API call per file and ref.
# A file listing of the PR is not used: it is capped, so a long PR could hide a change. Any API error, a missing file,
# or a value that is not a blob sha fails closed.
blob() { gh api "repos/$REPO/contents/$1?ref=$2" --jq 'if type == "object" and .type == "file" then .sha else empty end' 2>/dev/null; }
for p in "${PROTECTED_PATHS[@]}"; do
  B="$(blob "$p" "$BASE_SHA")" && is_sha "$B" || fail "could not read $p at the base commit $BASE_SHA; failing closed"
  H="$(blob "$p" "$HEAD")" && is_sha "$H" || fail "could not read $p at the head commit $HEAD; failing closed"
  [ "$B" = "$H" ] || fail "attesting workflow changed in this PR; merge requires an explicit admin bypass after review ($p)"
done

deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  # The newest pull_request run of attested.yml for this head, with the base branch of this PR as the run records it
  # ("-" when the run lists no matching PR, which GitHub does for runs from forks).
  RUN="$(gh api "repos/$REPO/actions/workflows/attested.yml/runs?head_sha=$HEAD&event=pull_request&per_page=1" \
    --jq ".workflow_runs[0] // empty | \"\\(.id) \\(.status) \\([.pull_requests[]? | select(.number == $PR) | .base.ref] | first // \"-\") \\(.pull_requests | length)\"" 2>/dev/null)"
  read -r ID STATUS RUN_BASE RUN_PRS <<<"$RUN"
  [ -n "$RUN" ] && [ "$STATUS" = completed ] && break
  [ "$(date +%s)" -ge "$deadline" ] && fail "no receipt: no attested run for $HEAD finished within $((WAIT_SECONDS / 60)) minutes (last seen: ${ID:-none} ${STATUS:-})"
  sleep "$POLL_SECONDS"
done
[[ "$ID" =~ ^[0-9]+$ ]] || fail "no receipt: malformed attested run id ${ID:-none}"
# The run must belong to this PR into the default branch. A run that lists pull requests must list this one with that base.
if [ "${RUN_PRS:-0}" != 0 ] && [ "$RUN_BASE" != "$DEFAULT" ]; then
  fail "attested run $ID is not a run of PR #$PR into $DEFAULT (recorded base: $RUN_BASE)"
fi
echo "attested verify: attested run $ID for head $HEAD is complete"

# The "attested run" job must have finished normally: success, or failure at its test step only. Anything else
# (cancelled, timed out, skipped, missing, or a failure in another step) fails here. A test failure is passed on to
# verify.sh, which fails with the receipt's failing tests.
JOB="$(gh api "repos/$REPO/actions/runs/$ID/jobs?filter=latest&per_page=100" --jq '
  [.jobs[]? | select(.name == "attested run")]
  | if length != 1 then "missing missing 0" else .[0]
    | "\(.conclusion // "none") \([.steps[]? | select(.name == "attested run") | .conclusion // "none"] | first // "missing") \([.steps[]? | select(.name != "attested run" and .conclusion == "failure")] | length)"
    end' 2>/dev/null)" || fail "could not read the jobs of attested run $ID"
read -r JOB_C STEP_C OTHER_FAILED <<<"$JOB"
if [ "$JOB_C" = success ] && [ "$STEP_C" = success ] && [ "$OTHER_FAILED" = 0 ]; then RUN_CONCLUSION=success
elif [ "$JOB_C" = failure ] && [ "$STEP_C" = failure ] && [ "$OTHER_FAILED" = 0 ]; then RUN_CONCLUSION=failure
else fail "attested run job in run $ID did not finish normally (job ${JOB_C:-none}, test step ${STEP_C:-none}, ${OTHER_FAILED:-?} other failed steps)"
fi
echo "attested verify: attested run job concluded $RUN_CONCLUSION"

NAME="$(gh api "repos/$REPO/actions/runs/$ID/artifacts" --jq '[.artifacts[] | select(.name | startswith("attested-")) | .name][0] // empty')"
[ -n "$NAME" ] || fail "no receipt: attested run $ID uploaded no attested-* artifact"
gh run download "$ID" --repo "$REPO" --name "$NAME" --dir "$OUT" >/dev/null || fail "no receipt: could not download $NAME from run $ID"
echo "subject-path=$OUT/attested/ctrf.json" >> "${GITHUB_OUTPUT:-/dev/stdout}"
# Pin verification to this run and its ref (read by verify.sh from the job environment), so an attestation of the same
# bytes signed anywhere else, for example by workflow_dispatch from a branch with a modified attested.yml, is not accepted.
{ echo "ATTESTED_RUN_ID=$ID"; echo "ATTESTED_SOURCE_REF=refs/pull/$PR/merge"; echo "ATTESTED_RUN_CONCLUSION=$RUN_CONCLUSION"; } >> "${GITHUB_ENV:-/dev/stdout}"
