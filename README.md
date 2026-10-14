# attested

Signed, verifiable test receipts for agent-authored changes.

`attested` wraps an ordinary Playwright run and turns it into a receipt: an
[in-toto Statement](https://github.com/in-toto/attestation) whose subject is the
[CTRF](https://ctrf.io) test report and whose predicate records the result, the
failing tests, the source commit, and the sha256 of every trace, video, and
screenshot. In GitHub Actions the receipt is signed with Sigstore keyless
signing through `actions/attest`, so anyone can verify it with `gh attestation verify`.
No custom runner, no custom signing, no hosted service.

Status: M1 spike complete. See [docs/spikes/m1-brief.md](docs/spikes/m1-brief.md) and
[SPIKE-REPORT.md](SPIKE-REPORT.md).

## From clone to a verified receipt

Prerequisites: Node 22, pnpm 10, [GitHub CLI](https://cli.github.com) 2.49 or newer, logged in (`gh auth login`).

1. Clone and build.

   ```bash
   git clone https://github.com/Praxso/attested.git && cd attested && pnpm install --frozen-lockfile && pnpm build
   ```

2. Run the sample tests locally and produce an unsigned receipt.

   ```bash
   cd examples/sample-app && pnpm exec playwright install chromium && pnpm exec attested run --allow-dirty -- pnpm exec playwright test && pnpm exec attested attest
   ```

   `attested/receipt.json` now holds the statement and a warning was printed. Signing needs the workflow OIDC identity, so it only happens in Actions.

3. Verify a signed receipt from the latest run on `main`. Download the workflow artifact, which contains the exact `ctrf.json` that was signed, then verify it against GitHub's attestation store.

   ```bash
   gh run download --repo Praxso/attested --name "attested-$(gh api repos/Praxso/attested/commits/main -q .sha)" --dir /tmp/attested-receipt
   ```

   ```bash
   gh attestation verify /tmp/attested-receipt/attested/ctrf.json --repo Praxso/attested --predicate-type https://praxso.ai/attested/v0.1 --signer-workflow Praxso/attested/.github/workflows/attested.yml
   ```

   Add `--format json` to see the full predicate, including `predicate.source.commit` and the list of failed tests.

4. Optional: verify offline. Download the bundle and the trusted root while online, then verify with the network off.

   ```bash
   cd /tmp/attested-receipt && gh attestation download attested/ctrf.json --repo Praxso/attested --predicate-type https://praxso.ai/attested/v0.1 && gh attestation trusted-root > trusted_root.jsonl
   ```

   ```bash
   gh attestation verify attested/ctrf.json --repo Praxso/attested --predicate-type https://praxso.ai/attested/v0.1 --bundle sha256:*.jsonl --custom-trusted-root trusted_root.jsonl
   ```

## Commands

```
attested run [--expect-sha <sha>] [--allow-dirty] [--ctrf attested/ctrf.json] [--output-dir test-results] [--target-url <url>] [--health-path /healthz] -- <test command>
attested attest [--receipt attested/receipt.json] [--ctrf attested/ctrf.json]
```

`attested run` refuses to start tests when `HEAD` differs from `--expect-sha`, or when the working tree is dirty without `--allow-dirty`. It exits with the test command's exit code after writing the receipt, so a red run fails the job but still gets a receipt. `attested attest` refuses to attest if `ctrf.json` changed since `attested run`.

### `--target-url` is fail-closed

When `--target-url <url>` is given, `attested run` fetches `<url>/healthz` (or `--health-path`) before any test starts and requires a JSON body with a `sha` field equal to `--expect-sha`, or to `HEAD` when `--expect-sha` is absent. A target that is unreachable, returns a non-2xx status, reports no `sha`, or reports a different `sha` fails the run with exit code 2 and a message naming the target and both shas; no tests execute. The matching sha is recorded as `predicate.target.buildSha`. When the flag is absent, no probe runs and `target` is `{ "buildSha": null, "url": null }`.

Both branches are covered by `packages/cli/test/target-url.test.mjs` (`pnpm build && pnpm --filter @praxso/attested test`), which the workflow runs on every push. Manual check against the sample app, whose `/healthz` reports `GITHUB_SHA`:

```bash
cd examples/sample-app && GITHUB_SHA=$(git rev-parse HEAD) node server.mjs & sleep 1; pnpm exec attested run --allow-dirty --target-url http://localhost:4173 -- true; echo "exit $?"; kill $!
```

Expected: `attested: target http://localhost:4173 reports build <HEAD>` and then `true` runs (it writes no CTRF report, so the run ends with the "CTRF report not found" error). Replace `$(git rev-parse HEAD)` with `deadbeef` and the run stops before `true` with `is built from deadbeef, expected <HEAD>; refusing to run tests` and exit 2.

## What gets signed

Two attestations are produced per run, both with subject `ctrf.json`:

- `https://praxso.ai/attested/v0.1`: the attested receipt (`testResult`, `source`, `target`, `artifacts`, `tool`, `ctrf`, `createdAt`). **This predicate is authoritative.**
- `https://in-toto.io/attestation/test-result/v0.1`: the plain in-toto Test Result predicate, for tools that already understand it. It is a projection of `testResult` from the receipt and carries no extra claims.

Traces, videos, and screenshots are never committed. They are uploaded as a workflow artifact with 90-day retention; their hashes live in the receipt.

### Is a receipt signed?

The receipt file does not say. It carries no `signed` field, because `attested attest` runs before the `actions/attest` step that does the signing and cannot know whether that step succeeded. The only answer to "is this receipt signed?" is `gh attestation verify` against the subject `ctrf.json`, as in step 3 above. The local path (`attested attest` outside Actions) still checks the subject digest and exits 0 with a warning, but it writes no signed claim and creates no attestation.

## License

Apache-2.0.
