---
name: attested
description: Use before opening or updating a pull request in a repo with Playwright or CTRF tests. Runs the tests through attested, reads the failure packet on red, fixes, reruns until green, then opens the PR with the receipt digest.
---

# attested: prove the tests pass before you open the PR

The attested MCP server gives you three tools: `attested_run`, `attested_packet`, `attested_status`.

## Loop

1. Before opening a PR, call `attested_run` with the project's test command, run from the
   directory that holds the test config (pass `cwd`). For Playwright with the CTRF reporter
   that is usually `pnpm exec playwright test` or `npx playwright test`.
2. If `result` is `PASSED`, go to step 5.
3. If `result` is `FAILED`, read `packet` in the response (or call `attested_packet`):
   - `failingTests[].message`, `file`, `line`, `stack`: what failed and where.
   - `console` and `network`: browser errors and failed requests seen during the run.
   - `evidence`: trace, video, and screenshot paths in `test-results/`. Do not open,
     attach, upload, or paste these files anywhere; the packet text is enough.
   Fix the application code, not the test, unless the test is wrong. Do not weaken or
   skip a test to make it pass.
4. Call `attested_run` again. Repeat steps 3 and 4 until `result` is `PASSED`. If the
   same failure survives three attempts, stop and report the packet to the user.
5. Commit the fix and push the branch. Open the PR. Put this in the PR body:

   ```
   attested: PASSED locally, ctrf.json sha256 <subject.sha256 from the last attested_run>
   CI signs the receipt and posts the `attested` check; `attested verify` is the required check.
   ```

6. After CI runs, `attested_status` reports `verified`, the verdict from the signed attestation
   for a downloaded receipt. Its `localReceipt` fields are unverified. Local runs are never signed;
   only CI runs are.

## Rules

- Never post screenshots, videos, or traces to the PR, an issue, or any external host.
  Evidence stays in the workflow artifact. Link to the check, not to images.
- If `attested_run` returns an error instead of a receipt (dirty tree with
  `allow_dirty: false`, sha mismatch, unreachable `target_url`, no CTRF report), fix that
  cause first; do not work around the check.
- Do not paste environment variables, tokens, or `.env` contents into the PR.
