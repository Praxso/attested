# prove

Signed, verifiable test receipts for agent-authored changes.

`prove` wraps an ordinary Playwright run and turns it into a receipt: an
[in-toto Statement](https://github.com/in-toto/attestation) whose subject is the
[CTRF](https://ctrf.io) test report and whose predicate records the result, the
failing tests, the source commit, and the sha256 of every trace, video, and
screenshot. In GitHub Actions the receipt is signed with Sigstore keyless
signing through `actions/attest`, so anyone can verify it with `gh attestation verify`.
No custom runner, no custom signing, no hosted service.

Status: M1 spike. See [docs/spikes/m1-brief.md](docs/spikes/m1-brief.md) and
[SPIKE-REPORT.md](SPIKE-REPORT.md).

## From clone to a verified receipt

Prerequisites: Node 22, pnpm 10, [GitHub CLI](https://cli.github.com) 2.49 or newer, logged in (`gh auth login`).

1. Clone and build.

   ```bash
   git clone https://github.com/Praxso/prove.git && cd prove && pnpm install --frozen-lockfile && pnpm build
   ```

2. Run the sample tests locally and produce an unsigned receipt.

   ```bash
   cd examples/sample-app && pnpm exec playwright install chromium && pnpm exec prove run --allow-dirty -- pnpm exec playwright test && pnpm exec prove attest
   ```

   `prove/receipt.json` now holds the statement with `"signed": false` and a warning was printed. Signing needs the workflow OIDC identity, so it only happens in Actions.

3. Verify a signed receipt from the latest run on `main`. Download the workflow artifact, which contains the exact `ctrf.json` that was signed, then verify it against GitHub's attestation store.

   ```bash
   gh run download --repo Praxso/prove --name "prove-$(gh api repos/Praxso/prove/commits/main -q .sha)" --dir /tmp/prove-receipt
   ```

   ```bash
   gh attestation verify /tmp/prove-receipt/prove/ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1 --signer-workflow Praxso/prove/.github/workflows/prove.yml
   ```

   Add `--format json` to see the full predicate, including `predicate.source.commit` and the list of failed tests.

4. Optional: verify offline. Download the bundle and the trusted root while online, then verify with the network off.

   ```bash
   cd /tmp/prove-receipt && gh attestation download prove/ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1 && gh attestation trusted-root > trusted_root.jsonl
   ```

   ```bash
   gh attestation verify prove/ctrf.json --repo Praxso/prove --predicate-type https://Praxso/prove/receipt/v0.1 --bundle sha256:*.jsonl --custom-trusted-root trusted_root.jsonl
   ```

## Commands

```
prove run [--expect-sha <sha>] [--allow-dirty] [--ctrf prove/ctrf.json] [--output-dir test-results] [--target-url <url>] -- <test command>
prove attest [--receipt prove/receipt.json] [--ctrf prove/ctrf.json]
```

`prove run` refuses to start tests when `HEAD` differs from `--expect-sha`, or when the working tree is dirty without `--allow-dirty`. It exits with the test command's exit code after writing the receipt, so a red run fails the job but still gets a receipt. `prove attest` refuses to attest if `ctrf.json` changed since `prove run`.

## What gets signed

Two attestations are produced per run, both with subject `ctrf.json`:

- `https://Praxso/prove/receipt/v0.1`: the prove receipt (`testResult`, `source`, `target`, `artifacts`, `tool`, `ctrf`, `createdAt`).
- `https://in-toto.io/attestation/test-result/v0.1`: the plain in-toto Test Result predicate, for tools that already understand it.

Traces, videos, and screenshots are never committed. They are uploaded as a workflow artifact with 90-day retention; their hashes live in the receipt.

## License

Apache-2.0.
