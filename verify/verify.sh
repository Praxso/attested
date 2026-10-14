#!/usr/bin/env bash
# attested verify: the required check. Fails closed; every failure prints one line naming the rule that failed.
# Needs gh (2.49+) and jq, both preinstalled on GitHub-hosted runners. Inputs come from the environment:
#   SUBJECT_PATH     ctrf.json from the attested run's workflow artifact
#   REPO             owner/repo whose attestation store holds the receipt
#   SIGNER_WORKFLOW  owner/repo/.github/workflows/<file>.yml that must have signed it
#   HEAD_SHA         sha being verified (default: PR head from the event payload, else GITHUB_SHA)
#   ALLOW_UNSIGNED   "true" to pass forked PRs (no OIDC token, so no attestation) with a warning instead of failing
set -uo pipefail

PREDICATE_TYPE="https://praxso.ai/attested/v0.1"
SUBJECT_PATH="${SUBJECT_PATH:-attested/ctrf.json}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
SIGNER_WORKFLOW="${SIGNER_WORKFLOW:-$REPO/.github/workflows/attested.yml}"
ALLOW_UNSIGNED="${ALLOW_UNSIGNED:-false}"
EVENT="${GITHUB_EVENT_PATH:-/dev/null}"

ev() { jq -r "$1 // empty" "$EVENT" 2>/dev/null || true; }
PR_HEAD="$(ev '.pull_request.head.sha')"
HEAD_SHA="${HEAD_SHA:-${PR_HEAD:-${GITHUB_SHA:-}}}"
HEAD_REPO="$(ev '.pull_request.head.repo.full_name')"
BASE_REPO="$(ev '.pull_request.base.repo.full_name')"
FORK=false
if [ -n "$HEAD_REPO" ] && [ "$HEAD_REPO" != "${BASE_REPO:-$REPO}" ]; then FORK=true; fi

fail() { echo "::error title=attested verify::$1"; echo "attested verify: FAIL: $1"; exit 1; }
pass() { echo "attested verify: PASS: $1"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "attested verify: PASS: $1" >> "$GITHUB_STEP_SUMMARY"; exit 0; }

unsigned_fork() {
  local msg="unsigned run from fork $HEAD_REPO: forked pull requests get no OIDC token, so the run could not be signed and no attestation exists"
  if [ "$ALLOW_UNSIGNED" = "true" ]; then
    # A job cannot conclude "neutral"; it passes with a warning annotation, which is the closest Actions offers.
    echo "::warning title=attested verify::neutral: $msg (allowed by allow-unsigned: true)"
    echo "attested verify: NEUTRAL: $msg (allowed by allow-unsigned: true)"
    exit 0
  fi
  fail "$msg (set allow-unsigned: true to allow)"
}

[ -n "$REPO" ] || fail "no repository given (REPO or GITHUB_REPOSITORY)"
[ -n "$HEAD_SHA" ] || fail "no head sha to verify against (HEAD_SHA, pull_request.head.sha, or GITHUB_SHA)"
if [ ! -f "$SUBJECT_PATH" ]; then
  [ "$FORK" = true ] && unsigned_fork
  fail "no receipt: $SUBJECT_PATH not found (the attested run uploaded no artifact for this commit)"
fi
DIGEST="$(sha256sum "$SUBJECT_PATH" 2>/dev/null || shasum -a 256 "$SUBJECT_PATH")"; DIGEST="${DIGEST%% *}"

ERRF="$(mktemp)"
OUT="$(gh attestation verify "$SUBJECT_PATH" --repo "$REPO" --predicate-type "$PREDICATE_TYPE" --signer-workflow "$SIGNER_WORKFLOW" --format json 2>"$ERRF")"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  ERR="$(tr '\n' ' ' < "$ERRF")"
  if grep -qiE '404|no attestations? found' "$ERRF"; then
    [ "$FORK" = true ] && unsigned_fork
    # Lookup is by digest and type; ask the store what exists for this digest to tell the cases apart.
    TYPES="$(gh api "repos/$REPO/attestations/sha256:$DIGEST" --jq '[.attestations[].bundle.dsseEnvelope.payload | @base64d | fromjson | .predicateType] | unique | join(", ")' 2>/dev/null || true)"
    [ -n "$TYPES" ] && fail "predicate type mismatch: sha256:$DIGEST is attested only as $TYPES, not $PREDICATE_TYPE"
    fail "no attestation found for sha256:$DIGEST in $REPO (receipt was never signed)"
  fi
  fail "verification failed for sha256:$DIGEST: ${ERR:0:300}"
fi

STMT="$(jq -c '.[0].verificationResult.statement' <<<"$OUT")"
TYPE="$(jq -r '.predicateType' <<<"$STMT")"
COMMIT="$(jq -r '.predicate.source.commit // empty' <<<"$STMT")"
HEADC="$(jq -r '.predicate.source.headCommit // empty' <<<"$STMT")"
RESULT="$(jq -r '.predicate.testResult.result // empty' <<<"$STMT")"

[ "$TYPE" = "$PREDICATE_TYPE" ] || fail "predicate type mismatch: got $TYPE, want $PREDICATE_TYPE"
# Head rule: pull_request runs check out and attest the synthetic merge commit (refs/pull/N/merge), which is not on the
# branch, so `attested run` also records the PR head as source.headCommit. Either one must equal the sha being verified.
if [ "$COMMIT" = "$HEAD_SHA" ]; then RULE="source.commit == $HEAD_SHA (push-style run: the attested commit is the head)"
elif [ -n "$HEADC" ] && [ "$HEADC" = "$HEAD_SHA" ]; then RULE="source.headCommit == $HEAD_SHA (pull_request run: source.commit $COMMIT is the synthetic merge commit)"
else fail "SHA mismatch: receipt source.commit ${COMMIT:-none} and source.headCommit ${HEADC:-none}, but the head being verified is $HEAD_SHA"
fi
[ "$RESULT" = "FAILED" ] && fail "result FAILED: the signed receipt for $HEAD_SHA records failing tests ($(jq -r '.predicate.testResult.failedTests | join("; ")' <<<"$STMT" | cut -c1-200))"
[ "$RESULT" = "PASSED" ] || echo "::warning title=attested verify::result $RESULT (not FAILED, so not blocking)"
pass "sha256:$DIGEST signed by $SIGNER_WORKFLOW, predicate $TYPE, result $RESULT; head rule: $RULE"
