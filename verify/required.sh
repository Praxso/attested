#!/usr/bin/env bash
# Run by .github/workflows/attested-verify.yml, the workflow an org ruleset requires. It never runs PR code: it blocks
# PRs that change the attesting workflow, waits for the `attested` run on the PR head, and downloads that run's receipt
# for the verify action. Writes `subject-path` to $GITHUB_OUTPUT.
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

CHANGED="$(gh api --paginate "repos/$REPO/pulls/$PR/files" --jq '.[] | .filename, (.previous_filename // empty)')" \
  || fail "could not list the files changed in PR #$PR"
for p in "${PROTECTED_PATHS[@]}"; do
  if grep -qxF "$p" <<<"$CHANGED"; then
    fail "attesting workflow changed in this PR; merge requires an explicit admin bypass after review ($p)"
  fi
done

deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  RUN="$(gh api "repos/$REPO/actions/workflows/attested.yml/runs?head_sha=$HEAD&event=pull_request&per_page=1" \
    --jq '.workflow_runs[0] // empty | "\(.id) \(.status)"' 2>/dev/null)"
  ID="${RUN%% *}"; STATUS="${RUN#* }"
  [ -n "$RUN" ] && [ "$STATUS" = completed ] && break
  [ "$(date +%s)" -ge "$deadline" ] && fail "no receipt: no attested run for $HEAD finished within $((WAIT_SECONDS / 60)) minutes (last seen: ${RUN:-none})"
  sleep "$POLL_SECONDS"
done
echo "attested verify: attested run $ID for head $HEAD is complete"

NAME="$(gh api "repos/$REPO/actions/runs/$ID/artifacts" --jq '[.artifacts[] | select(.name | startswith("attested-")) | .name][0] // empty')"
[ -n "$NAME" ] || fail "no receipt: attested run $ID uploaded no attested-* artifact"
gh run download "$ID" --repo "$REPO" --name "$NAME" --dir "$OUT" >/dev/null || fail "no receipt: could not download $NAME from run $ID"
echo "subject-path=$OUT/attested/ctrf.json" >> "${GITHUB_OUTPUT:-/dev/stdout}"
