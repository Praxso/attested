# Privacy

attested is software you run yourself: the CLI, the MCP server, the GitHub Action and the Claude Code plugin. It has no hosted service and no telemetry, and Praxso, LLC receives no data from it.

## What it reads

- Your test run's CTRF report (`attested/ctrf.json`) and the evidence files your tests wrote (`test-results/`: traces, videos, screenshots), to hash them and build the receipt and, on a red run, the failure packet.
- Git metadata of the working tree (the commit, whether the tree is dirty, the `origin` remote) and, in GitHub Actions, the workflow's environment variables and event payload.
- Nothing else. It does not read your environment variables into a receipt or packet.

## What it writes, and where it goes

| Data | Where it goes |
|---|---|
| `attested/receipt.json`, `attested/packet.json`, predicates | Your working tree. Add `attested/` to `.gitignore`; nothing is committed for you. |
| Evidence files and receipt in CI | The workflow artifact of your own GitHub Actions run, with your repository's retention. In a public repository any signed-in GitHub user can download it. |
| The signed receipt (in GitHub Actions) | GitHub's attestation store for your repository and, for public repositories, Sigstore's public transparency log (Rekor), whose entries are permanent. |
| The `attested` check | A check run on your commit, through GitHub's API with the workflow's token. Text only, never images. |

Test names, failure messages, console messages and request paths that go into a receipt, packet or check are redacted first (see [SECURITY.md](SECURITY.md#redaction)). Redaction is pattern-based, so keep secrets out of test output.

## Network calls

- **GitHub**: in Actions, the `attested check` step posts the check run, and `actions/attest` signs and stores the attestation. On your machine, the MCP server's `attested_status` tool runs `gh` with your existing GitHub CLI login to read and verify attestations for your repository. attested never reads or stores that credential itself.
- **Your deployment**: only if you pass `--target-url`, a single request to `<url>/healthz` to check the deployed commit.
- **npm**: only when you install or run the packages with `npm` or `npx`.

No other host is contacted, and no analytics or usage data is collected.

## Children

attested is a developer tool and is not directed at children.

## Contact

Questions about this policy: z@praxso.ai. Security reports: see [SECURITY.md](SECURITY.md).
