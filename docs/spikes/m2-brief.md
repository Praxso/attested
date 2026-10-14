# M2 brief: `attested check`, `attested verify`, failure packet, MCP server, and harness listings

Time box: 5 working days of agent execution. Stop at the time box and write the report regardless of state. Commit this brief as `docs/spikes/m2-brief.md` in the first PR.

## Preconditions

- M1 merged and the five decisions applied (rename to `attested`, predicate type `https://praxso.ai/attested/v0.1`, dual attestation kept, `--target-url` fails closed when given, no `signed` field). Read `SPIKE-REPORT.md` first; its "Where a primitive did not do what the design assumed" section is binding input.
- Zach approves any submission to a third-party directory or repository before it is sent. Prepare everything; submit only the items marked "submit" below.

## Goal

Make attested usable by an agent end to end: run, read a failure packet, fix, rerun, open a PR that carries one check a human trusts and one required check a ruleset can enforce. Then put it where agents look.

## Non-goals

No hosted service, no ledger, no UI beyond the GitHub check, no org-wide policy, no billing, no non-GitHub forges, no video narration, no Induct code copied in. The failure packet is written fresh from the contract below; it is small.

## Deliverables

### A. `attested check`

Posts one GitHub check run per attested run, from Actions using `GITHUB_TOKEN` with `checks: write`.

- Name: `attested`. Conclusion maps from the receipt: `PASSED` to success, `FAILED` to failure, anything else to neutral.
- Summary (markdown): verdict, commit tested, target build SHA if any, counts, link to the attestation (the `gh attestation verify` command users can paste), link to the uploaded workflow artifact, and the failure packet inline as a fenced block when red.
- Images: links only. Never use the check-run `images` field and never upload media anywhere public. This is the PixelLeak rule and it is a hard constraint.
- Forked pull requests: `GITHUB_TOKEN` is read-only, so `attested check` must detect that and print the same summary to the job log with a one-line notice instead of failing.

### B. `attested verify` (the required check)

A composite or JavaScript action that other repos add as a required status check, pinned to the `github-actions` app in their ruleset.

- Downloads the attestation for the receipt's subject digest and runs `gh attestation verify` with `--predicate-type https://praxso.ai/attested/v0.1`, `--signer-workflow` set to the attesting workflow, and `--format json`.
- Head rule, from M1 finding 4: on `pull_request` events the attestation's `source.commit` is the synthetic merge commit. `attested run` must therefore also record `source.headCommit` (the PR head SHA from the event payload when present). `attested verify` passes only when the attestation verifies and either `source.commit` or `source.headCommit` equals the PR head SHA being verified. Document why.
- Fail closed on: no attestation found (M1 finding 7: online lookup returns 404), verification failure, SHA mismatch, result `FAILED`, or predicate type mismatch. Each failure prints one line saying which rule failed.
- Forked PRs: no OIDC token means no attestation. `attested verify` must fail with a clear "unsigned run from fork" message rather than an obscure 404. Repos that want to allow forks can set `allow-unsigned: true` to get a neutral conclusion instead; default is fail.
- Document the exact ruleset configuration, including pinning the check to the `github-actions` app.

### C. Failure packet

Written fresh. A deterministic, model-free JSON object produced by `attested run` on red, stored at `attested/packet.json`, digest recorded in the receipt under `artifacts` with kind `packet`, and embedded in the check summary.

- Hard cap 12 KB; truncate lists deterministically (most recent first for logs, alphabetical for tests) and record `truncated: true` with what was cut.
- Contents: failing tests (name, file, line if CTRF provides it, error message with ANSI stripped, first 20 stack frames), console errors and warnings grouped by message with counts, failed network requests (method, URL path only, status), the artifact paths and digests for the relevant trace, video and screenshot, and the exact rerun command.
- Redaction: strip query strings and fragments from URLs, mask anything matching common secret shapes (bearer tokens, `key=`, `token=`, emails), and never include environment variables. Add a test with a fixture containing each shape.
- Group identical failures so a flaky-suite packet is not 50 copies of one error.

### D. MCP server and skill

- `packages/mcp`: a stdio MCP server in TypeScript exposing three tools: `attested_run` (args: test command, optional target URL, optional expected SHA; returns the receipt summary and, on red, the packet), `attested_packet` (returns the last packet), `attested_status` (returns the last receipt and whether an attestation exists for its digest, by calling `gh attestation verify` when `gh` is available).
- Claude Code plugin: a plugin manifest and a skill file whose instructions tell the agent to run `attested_run` before opening a PR, read the packet on red, fix, rerun, and only then open the PR with the receipt digest in the PR body. Keep the skill under 60 lines.
- Codex skill: the same instructions in Codex's skill format. Cursor and Copilot: a config snippet in README only.
- Exit test is behavioral: a Claude Code session with only the plugin installed, pointed at the sample app with `ATTESTED_SAMPLE_BREAK=1`, must call `attested_run`, read the packet, make the fix, rerun green, and open a PR whose check passes, with no human message in between. Record the transcript summary and the PR link.

### E. Listings

Prepare all; submit only where marked.

- MCP registry entry for `@praxso/attested-mcp` (submit after Zach approves the listing text).
- Claude Code plugin marketplace entry (prepare; Zach submits or approves).
- Codex skill directory entry (prepare; Zach approves).
- GitHub Actions Marketplace listing for `attested verify` (submit; it is our own repo's metadata).
- Draft PRs, not opened, adding attested to the CTRF integrations list and the Playwright MCP README's related tools section, saved as patch files under `docs/outreach/` with the exact text. Zach opens them.
- `SECURITY.md` explaining where evidence lives (workflow artifacts, repo-private), what is never uploaded, and how to report an issue.

### F. Docs and report

- README: install, the three commands, ruleset setup, MCP setup for Claude Code, Codex, Cursor, Copilot, and a "why not just screenshots" section citing PixelLeak with the date.
- `M2-REPORT.md`: measured facts in the same format as `SPIKE-REPORT.md`: time per deliverable, exit test outputs, primitives that did not behave, size and dependencies, open decisions.

## Exit tests

1. Green PR in the sample repo shows the `attested` check with success, the verify command, and an artifact link; no image appears anywhere.
2. Red PR shows the check with failure and the packet inline, under 12 KB, with the redaction fixture proving masking.
3. A ruleset requiring `attested verify` blocks a PR with no receipt, blocks a PR whose receipt commit does not match the head, blocks a red receipt, and passes a green one. Show all four with the one-line reason.
4. `pull_request` and `push` both verify, with the head rule explained in the output.
5. Forked PR: `attested check` prints to log without failing; `attested verify` fails with the "unsigned run from fork" message; `allow-unsigned: true` yields neutral.
6. The behavioral MCP test in D passes with a linked PR.
7. Fresh clone to a passing `attested verify` on a PR follows the README verbatim; record the time.
8. Zero runtime dependencies in the CLI are preserved; the MCP package's dependency list is reported with licenses.

## Constraints

- Public repo. Pin every action to a full commit SHA. No secrets, no long-lived keys. Never push images or videos to any repository, never post them to any external host.
- Do not submit anything to a third party without Zach's approval except the Actions Marketplace metadata in our own repo.
- No Induct code. Keep token use low: read each file once, make focused edits, do not explore beyond this brief.

## Stop conditions

Stop early and report if `GITHUB_TOKEN` cannot create check runs from the workflow after two documented attempts; if `gh attestation verify` cannot distinguish the head rule cases; or if the behavioral MCP test cannot complete because a harness blocks tool calls. Each is a finding.

## References

- `SPIKE-REPORT.md` in this repo.
- Checks API: https://docs.github.com/en/rest/checks/runs
- Workflow permissions for forks: https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
- `gh attestation verify`: https://cli.github.com/manual/gh_attestation_verify
- MCP registry: https://registry.modelcontextprotocol.io/
- Claude Code plugins: https://docs.claude.com/en/docs/claude-code/plugins
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- CTRF: https://ctrf.io/
- PixelLeak report, 2026-09-30: https://www.helpnetsecurity.com/2026/09/30/ai-coding-agents-github-screenshot-leak/
