# attested

Signed, verifiable test receipts for agent-authored pull requests.

`attested` wraps an ordinary Playwright run, or any test run that writes a [CTRF](https://ctrf.io) report, and turns it into a receipt: an [in-toto Statement](https://github.com/in-toto/attestation) whose subject is the CTRF report and whose predicate records the result, the failing tests, the commit, and the sha256 of every trace, video, and screenshot. In GitHub Actions the receipt is signed with Sigstore keyless signing through `actions/attest`. A pull request then carries two things:

- the **`attested` check**, which a human reads: verdict, commit, counts, the command to verify it, a link to the evidence, and on red a redacted failure packet;
- the **`attested verify` check**, which a ruleset requires: it fails closed unless a signed receipt exists for the PR head and says the tests passed.

No custom runner, no hosted service, no images posted anywhere.

Status: M2. See [docs/spikes/m2-brief.md](docs/spikes/m2-brief.md), [M2-REPORT.md](M2-REPORT.md), and for M1 [SPIKE-REPORT.md](SPIKE-REPORT.md).

## Why not just screenshots

On 2026-09-30 Help Net Security reported [PixelLeak](https://www.helpnetsecurity.com/2026/09/30/ai-coding-agents-github-screenshot-leak/): Glow Labs found more than 13,000 internal screenshots that AI coding agents had pushed to public GitHub repositories while trying to show reviewers a UI fix. Pull request image upload only works in the browser, so command-line agents put the images somewhere they could link to.

A screenshot is also weak evidence: it shows one moment, says nothing about which commit produced it, and can be produced by anything. `attested` gives reviewers a signed statement of which tests ran against which commit and what happened. The traces, videos, and screenshots stay in the workflow artifact of the run that produced them, and only their sha256 digests travel in the receipt. `attested check` never uses the check-run `images` field and posts text only. See [SECURITY.md](SECURITY.md).

## From a fresh clone to a passing `attested verify` on a PR

Prerequisites: Node 22, pnpm 10, [GitHub CLI](https://cli.github.com) 2.49 or newer, logged in (`gh auth login`), and write access to this repository (for your own repository, use [Use it in your repository](#use-it-in-your-repository) instead).

1. Clone and build.

   ```bash
   git clone https://github.com/Praxso/attested.git && cd attested && pnpm install --frozen-lockfile && pnpm build
   ```

2. Run the sample tests locally and produce an unsigned receipt.

   ```bash
   cd examples/sample-app && pnpm exec playwright install chromium && pnpm exec attested run --allow-dirty -- pnpm exec playwright test && cd ../..
   ```

   `examples/sample-app/attested/receipt.json` now holds the statement. Run it with `ATTESTED_SAMPLE_BREAK=1` in front to see a red run and `attested/packet.json`.

3. Open a pull request and wait for the checks.

   ```bash
   git checkout -b try-attested-$(date +%s) && git commit --allow-empty -m "try attested" && git push -u origin HEAD && gh pr create --fill --draft
   ```

   ```bash
   gh pr checks --watch --required
   ```

   `attested verify` passes with a line like `PASS: sha256:... signed by Praxso/attested/.github/workflows/attested.yml ... head rule: source.headCommit == <your head sha> (pull_request run: source.commit <merge sha> is the synthetic merge commit)`. The `attested` check on the PR has the paste-able verify command. Close the PR with `gh pr close --delete-branch` when done.

4. Optional: verify a receipt yourself, online or offline.

   ```bash
   gh run download --repo Praxso/attested --name "attested-$(gh api repos/Praxso/attested/commits/main -q .sha)" --dir /tmp/attested-receipt
   ```

   ```bash
   gh attestation verify /tmp/attested-receipt/attested/ctrf.json --repo Praxso/attested --predicate-type https://praxso.ai/attested/v0.1 --signer-workflow Praxso/attested/.github/workflows/attested.yml
   ```

   For offline verification, `gh attestation download` the bundle and `gh attestation trusted-root > trusted_root.jsonl` while online, then add `--bundle sha256:*.jsonl --custom-trusted-root trusted_root.jsonl`.

## Use it in your repository

1. Add the CLI and the CTRF reporter. The packages are not on npm yet, so until they are, build this repo and depend on `packages/cli` by path.

   ```bash
   pnpm add -D playwright-ctrf-json-reporter
   ```

   Add `['playwright-ctrf-json-reporter', { outputDir: 'attested', outputFile: 'ctrf.json' }]` to `reporter` in `playwright.config.ts`, and turn on `trace`, `video`, and `screenshot` as you like. Add `attested/` and `test-results/` to `.gitignore`.

2. Copy [`.github/workflows/attested.yml`](.github/workflows/attested.yml). It needs `contents: read`, `id-token: write`, `attestations: write`, and `checks: write`, and has two jobs: `attested run` (tests, receipt, signing, artifact upload, `attested check`) and `attested verify`. Replace `uses: ./` in the verify job with `uses: Praxso/attested@<full commit sha>`.

3. Require the check with a ruleset pinned to the `github-actions` app. [docs/ruleset.md](docs/ruleset.md) has the exact JSON, the reason for the head rule, and the limits of a required status check.

## Commands

```
attested run [--expect-sha <sha>] [--allow-dirty] [--target-url <url>] [--health-path /healthz] [--ctrf attested/ctrf.json] [--output-dir test-results] [--packet attested/packet.json] -- <test command>
attested attest [--receipt attested/receipt.json] [--ctrf attested/ctrf.json]
attested check [--artifact-url <url>] [--artifact-name <name>] [--attestation-url <url>]
```

- **`attested run`** refuses to start tests when `HEAD` differs from `--expect-sha`, when the tree is dirty without `--allow-dirty`, or, with `--target-url`, when `<url>/healthz` does not report a `sha` equal to the expected one. It writes `attested/receipt.json` and exits with the test command's exit code. It records `source.commit` and, on `pull_request`, `source.headCommit` (the PR head; `source.commit` is the synthetic merge commit there). On red it writes the failure packet.
- **`attested attest`** re-checks the subject digest and hands the predicate to the `actions/attest` steps that sign it. Outside Actions it warns that the receipt is unsigned.
- **`attested check`** posts one check run named `attested`: `PASSED` is success, `FAILED` is failure, anything else is neutral. On a forked PR, or when the token cannot create check runs (HTTP 403), it prints the same summary to the job log and step summary with a one-line notice and exits 0.
- **`attested verify`** is the GitHub Action at the root of this repo (`action.yml`). It fails closed, one line per rule: `no receipt`, `no attestation found`, `predicate type mismatch`, `verification failed`, `SHA mismatch`, `result FAILED`, `unsigned run from fork`. Inputs: `subject-path`, `repo`, `signer-workflow`, `head-sha`, `allow-unsigned` (forks pass with a `neutral:` warning).

### Failure packet

On red, `attested run` writes `attested/packet.json` (at most 12 KB, digest recorded in the receipt with kind `packet`, embedded in the `attested` check). It holds the failing tests grouped by file, line, and message (ANSI stripped, first 20 stack frames, evidence paths and digests), console errors and warnings grouped with counts, failed requests (method, path, status), and the exact rerun command. Console and network data come from the Playwright trace. URLs lose their query strings and fragments; bearer tokens, `key=`/`token=`/`password=` values, common token formats, and emails are masked; environment variables are never read into it. Over 12 KB, stacks are cut to five frames and then lists are cut from the tail (tests alphabetically, console and network most recent first) and `truncated` says what was cut.

## Agents: MCP server and skills

`@praxso/attested-mcp` is a stdio MCP server with three tools: `attested_run` (test command, optional `target_url`, `expected_sha`; returns the receipt summary and, on red, the packet), `attested_packet`, and `attested_status` (last receipt, and whether an attestation exists for it, via `gh attestation verify`). The skill tells the agent to run `attested_run` before opening a PR, read the packet on red, fix, rerun, and put the receipt digest in the PR body.

The npm packages are not published yet. Until they are, replace `npx -y @praxso/attested-mcp@0.1.0` below with `node /path/to/attested/packages/mcp/bin/attested-mcp.js` after `pnpm build`.

**Claude Code**: install the plugin (MCP server plus skill) from this repo's marketplace.

```
/plugin marketplace add Praxso/attested
/plugin install attested@praxso
```

**Codex**: add the server to `~/.codex/config.toml` and copy the skill.

```toml
[mcp_servers.attested]
command = "npx"
args = ["-y", "@praxso/attested-mcp@0.1.0"]
```

```bash
mkdir -p ~/.codex/skills && cp -R codex/skills/attested ~/.codex/skills/
```

**Cursor**: `.cursor/mcp.json` in the project.

```json
{ "mcpServers": { "attested": { "command": "npx", "args": ["-y", "@praxso/attested-mcp@0.1.0"] } } }
```

**GitHub Copilot** in VS Code: `.vscode/mcp.json` in the project. Paste the steps of the skill file into `.github/copilot-instructions.md`.

```json
{ "servers": { "attested": { "type": "stdio", "command": "npx", "args": ["-y", "@praxso/attested-mcp@0.1.0"] } } }
```

## What gets signed

Two attestations per run, both with subject `ctrf.json`:

- `https://praxso.ai/attested/v0.1`: the receipt (`testResult`, `source`, `target`, `artifacts`, `tool`, `ctrf`, `createdAt`). **This predicate is authoritative.**
- `https://in-toto.io/attestation/test-result/v0.1`: the plain in-toto Test Result predicate, a projection of `testResult`.

The receipt file carries no `signed` field. `gh attestation verify` is the only answer to whether a receipt is signed.

## License

Apache-2.0.
