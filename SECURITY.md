# Security

## Where evidence lives

| Evidence | Where it is stored | Who can read it |
|---|---|---|
| Traces, videos, screenshots (`test-results/`) | The workflow artifact of the run that produced them (`attested-<sha>`, 90-day retention) | Whoever can download that repository's Actions artifacts. In a private repository, people with read access. In a public repository, any signed-in GitHub user. |
| `ctrf.json`, `receipt.json`, `packet.json` | The same workflow artifact | Same as above |
| The signed receipt (predicate) | GitHub's attestation store for the repository, and the public Sigstore transparency log (Rekor) for public repositories | Anyone who can see the repository |
| The `attested` check summary | The check run on the commit | Anyone who can see the repository |

The receipt and the check summary contain test names, counts, commit shas, artifact paths, sha256 digests, and the CTRF tool name and version and summary counts. They do not contain images, video, trace contents, or environment variables. On red, the check summary embeds the failure packet (below).

If your test names, error messages, or console output can contain sensitive data, treat the check summary and the receipt as being as visible as the repository, and the artifact as being as visible as the repository's Actions artifacts. In a public repository, that is public.

## What is never uploaded

- `attested` never posts images, video, or traces to a pull request, issue, comment, or check run. `attested check` posts text only and never sets the check-run `images` field.
- `attested` never uploads anything to a host other than GitHub. Signing uses GitHub's `actions/attest`, which records the attestation with Sigstore.
- The MCP server runs the attested CLI bundled with it, or `ATTESTED_BIN` from its own configuration, never a binary from the project's `node_modules`.
- The MCP server and the agent skill tell agents not to attach, upload, or paste evidence files anywhere, and to link to the check instead. This is the failure mode reported as PixelLeak on 2026-09-30.
- Nothing is committed to the repository. `attested/` and `test-results/` belong in `.gitignore`.

## Redaction

`attested/packet.json` is built from the CTRF report and the Playwright traces without a model. Every string in it is redacted: test names, file paths, error messages, stack frames, evidence paths, console messages, request methods and paths, and the rerun command. In the receipt, test names are redacted, and the CTRF metadata is allowlisted: the tool's `name` and `version` (redacted strings) and the numeric summary counts; every other CTRF field is dropped. The signed subject, `ctrf.json`, is never rewritten: it is the test job's report, byte for byte, and it holds whatever the tests wrote. Redaction:

- ANSI escape codes are stripped.
- URLs lose their query strings and fragments. Request URLs keep only the path.
- Bearer and basic credentials, `*key*=`, `*token*=`, `*secret*=`, `*password*=`, `*session*=`, `*auth*=`, `*credential*=` values, GitHub, Slack, OpenAI-style, and AWS access key shapes, JWTs, and email addresses are masked.
- Environment variables are never read into it.
- Every field is bounded (names, paths, and frames 300 characters, messages 1,500, the rerun command 500, at most 20 frames and 10 evidence entries per test), so the 12 KB cap always holds.

Input limits: `ctrf.json` 32 MiB, each evidence file 512 MiB, each trace zip 256 MiB, 32 MiB inflated per trace entry and 128 MiB across all traces. Over a limit, the CLI stops with an error naming the file, or skips the trace entry with a warning. A results directory, `ctrf.json`, test config, or output directory that is a symlink or resolves outside the results directory is refused.

Redaction is pattern-based and cannot catch every secret. Do not log secrets in tests. The fixture in `packages/cli/test/packet.test.mjs` lists every shape that is masked; `packages/cli/test/hardening.test.mjs` covers the fields, bounds, limits, and symlinks.

## Verdicts

- `attested verify` accepts only the attestation whose certificate names the attesting run and its ref, requires the head commit to match, and decides on the signed result: `PASSED` passes; `WARNED` (skipped, flaky, or other non-failed tests) passes with a warning annotation; `FAILED` fails; a missing or unknown result fails. The receipt is `FAILED` when either the CTRF summary or any individual test reports a failure.
- In the required workflow, verify also reads the `attested run` job from the Actions API. A test-step failure fails verify even if the receipt says `PASSED`; any other abnormal conclusion fails it.
- The MCP server's `attested_status` builds its `verified` verdict from the signed statement under the same run, ref, and head policy. Fields read from the project's own `attested/receipt.json` are returned under `localReceipt` and labelled unverified. It refuses project files that are symlinks or resolve outside the project, and returns a packet only after checking its shape.

## Trust model and limits

- A receipt proves this commit's own test suite reported this result, signed by a job that ran no PR code; it does not prove the change is correct. The tests run in `attested run`, a job with a read-only token and no OIDC token. Signing (`id-token: write`, `attestations: write`) and the `attested` check (`checks: write`) happen in `attested sign`, which checks out attested from the default branch head, never runs PR code, treats the test results as data, and takes the commit and PR head from the event context.
- A PR can still weaken its own tests, or make a test write a passing `ctrf.json`; the signed receipt then honestly records what that suite reported. Follow-ups, not built yet: a check that fails when tests disappear compared with the base branch, and CODEOWNERS review for test files.
- The verify decision runs from a pinned default-branch commit: `.github/workflows/attested-verify.yml`, required by an organization ruleset ([docs/rulesets/README.md](docs/rulesets/README.md)). It never checks out or runs PR code. A PR cannot replace or remove it, or satisfy it with a same-named job.
- On `pull_request`, the attesting workflow (`attested.yml`) comes from the PR. A PR that changes it, or the verify workflow, is blocked pending an explicit org-admin bypass after review.
- Anyone with admin rights can bypass rulesets, including an agent running under an admin's account or token. Run agents under a separate non-admin bot identity; that is the real boundary.
- Forked pull requests get no OIDC token and are never signed; `attested verify` fails them unless `allow-unsigned: true`.

## Reporting a vulnerability

Report security issues privately through GitHub's private vulnerability reporting: https://github.com/Praxso/attested/security/advisories/new. Do not open a public issue for a vulnerability. Include the affected version or commit, the steps to reproduce, and the impact. Expect an acknowledgement within 5 business days.
