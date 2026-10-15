# Security

## Where evidence lives

| Evidence | Where it is stored | Who can read it |
|---|---|---|
| Traces, videos, screenshots (`test-results/`) | The workflow artifact of the run that produced them (`attested-<sha>`, 90-day retention) | Whoever can download that repository's Actions artifacts. In a private repository, people with read access. In a public repository, any signed-in GitHub user. |
| `ctrf.json`, `receipt.json`, `packet.json` | The same workflow artifact | Same as above |
| The signed receipt (predicate) | GitHub's attestation store for the repository, and the public Sigstore transparency log (Rekor) for public repositories | Anyone who can see the repository |
| The `attested` check summary | The check run on the commit | Anyone who can see the repository |

The receipt and the check summary contain test names, counts, commit shas, artifact paths, and sha256 digests. They do not contain images, video, trace contents, or environment variables. On red, the check summary embeds the failure packet (below).

If your test names, error messages, or console output can contain sensitive data, treat the check summary and the receipt as being as visible as the repository, and the artifact as being as visible as the repository's Actions artifacts. In a public repository, that is public.

## What is never uploaded

- `attested` never posts images, video, or traces to a pull request, issue, comment, or check run. `attested check` posts text only and never sets the check-run `images` field.
- `attested` never uploads anything to a host other than GitHub. Signing uses GitHub's `actions/attest`, which records the attestation with Sigstore.
- The MCP server and the agent skill tell agents not to attach, upload, or paste evidence files anywhere, and to link to the check instead. This is the failure mode reported as PixelLeak on 2026-09-30.
- Nothing is committed to the repository. `attested/` and `test-results/` belong in `.gitignore`.

## The failure packet

`attested/packet.json` is built from the CTRF report and the Playwright traces without a model. Before anything goes in:

- ANSI escape codes are stripped.
- URLs lose their query strings and fragments. Request URLs keep only the path.
- Bearer and basic credentials, `*key*=`, `*token*=`, `*secret*=`, `*password*=`, `*session*=`, `*auth*=`, `*credential*=` values, GitHub, Slack, OpenAI-style, and AWS access key shapes, JWTs, and email addresses are masked.
- Environment variables are never read into it.
- It is capped at 12 KB.

Redaction is pattern-based and cannot catch every secret. Do not log secrets in tests. The fixture in `packages/cli/test/packet.test.mjs` lists every shape that is masked.

## Trust model and limits

- A receipt proves that a specific workflow, at a specific commit, signed a statement about a specific `ctrf.json`. It does not prove the tests are meaningful.
- The verify decision runs from a pinned default-branch commit: `.github/workflows/attested-verify.yml`, required by an organization ruleset ([docs/rulesets/README.md](docs/rulesets/README.md)). It never checks out or runs PR code. A PR cannot replace or remove it, or satisfy it with a same-named job.
- On `pull_request`, the attesting workflow (`attested.yml`) comes from the PR. A PR that changes it, or the verify workflow, is blocked pending an explicit org-admin bypass after review.
- Test files are PR-controlled by nature. A receipt can only say that the tests in the PR passed.
- Anyone with admin rights can bypass rulesets, including an agent running under an admin's account or token. Run agents under a separate non-admin bot identity; that is the real boundary.
- Forked pull requests get no OIDC token and are never signed; `attested verify` fails them unless `allow-unsigned: true`.

## Reporting a vulnerability

Report security issues privately through GitHub's private vulnerability reporting: https://github.com/Praxso/attested/security/advisories/new. Do not open a public issue for a vulnerability. Include the affected version or commit, the steps to reproduce, and the impact. Expect an acknowledgement within 5 business days.
