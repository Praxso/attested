# @praxso/attested

Signed, verifiable test receipts for agent-authored pull requests.

`attested` wraps an ordinary Playwright run, or any test run that writes a [CTRF](https://ctrf.io) report, and turns it into an [in-toto](https://github.com/in-toto/attestation) receipt: the result, the failing tests, the exact commit, and the sha256 of every trace, video, and screenshot. In GitHub Actions the receipt is signed with Sigstore keyless signing through `actions/attest`, and anyone can check it with `gh attestation verify`.

No custom runner, no hosted service, no images posted anywhere. Evidence stays in the workflow artifact of the run that produced it; only digests travel in the receipt.

## Install

```bash
npm install --save-dev @praxso/attested
```

Requires Node 22 or newer.

## Use

```bash
npx attested run -- npx playwright test
```

```bash
npx attested attest
```

`run` executes your test command, requires a CTRF report, and writes `attested/receipt.json`. On a red run it also writes `attested/packet.json`, a redacted failure packet under 12 KB that a coding agent can act on. `attest` prepares the predicate for the `actions/attest` step in your workflow. `check` posts a text-only GitHub check run.

Workflow setup, the `attested verify` required check, and the organization ruleset that makes it unforgeable are documented in the repository: https://github.com/Praxso/attested

## Agents

The MCP server is a separate package, [`@praxso/attested-mcp`](https://www.npmjs.com/package/@praxso/attested-mcp).

## License

Apache-2.0
