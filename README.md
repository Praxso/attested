# attested

Signed, verifiable test receipts for agent-authored pull requests.

https://github.com/user-attachments/assets/4b61bbe8-6c4f-4132-aee0-f8cb9aede34f

`attested` wraps an ordinary Playwright run, or any test run that writes a [CTRF](https://ctrf.io) report, and turns it into a receipt: an [in-toto Statement](https://github.com/in-toto/attestation) whose subject is the CTRF report and whose predicate records the result, the failing tests, the commit, and the sha256 of every trace, video, and screenshot. In GitHub Actions the receipt is signed with Sigstore keyless signing through `actions/attest`. A pull request then carries two things:

- the **`attested` check**, which a human reads: verdict, commit, counts, the command to verify it, a link to the evidence, and on red a redacted failure packet;
- the **`attested verify` check**, which an organization ruleset requires as a workflow: it runs from a pinned default-branch commit, never runs PR code, and fails closed unless a signed receipt exists for the PR head and says the tests passed.

No custom runner, no hosted service, no images posted anywhere.

## Swap screenshots for receipts

Your tests already record proof that your app works: screenshots, videos, and traces of every click. attested keeps that proof in the CI run that produced it and gives the pull request a signed receipt instead. With the receipt you can:

- **read the verdict** for this exact commit in the `attested` check;
- **fetch the originals**: the check prints the `gh run download` command for the run's screenshots, videos and traces;
- **confirm nothing changed**: the signed receipt holds every file's sha256. The check's commands run `gh attestation verify`, keep only the statement signed in that run, on that ref, for that head, and compare every downloaded file against that statement's digests with `shasum -a 256 -c`, never against the unsigned `receipt.json` in the download;
- **block merges without one**: the required `attested verify` check fails unless a signed receipt for the PR head says the tests passed.

A receipt proves the commit's own tests reported the result, not that the change is correct; see [What a receipt proves](#what-a-receipt-proves).

## Quickstart

In a repository with Playwright tests, add the CTRF reporter:

```bash
npm i -D playwright-ctrf-json-reporter
```

In `playwright.config.ts`, add the CTRF reporter to `reporter`; the default `reporter: 'html'` becomes a list:

```ts
reporter: [['html'], ['playwright-ctrf-json-reporter', { outputDir: 'attested', outputFile: 'ctrf.json' }]],
```

Add `attested/` to `.gitignore`, commit, then run your tests through `attested`:

```bash
npx @praxso/attested run -- npx playwright test
```

`attested/receipt.json` now holds the receipt, and on a red run `attested/packet.json` holds the failure packet. `attested run` refuses a dirty working tree, so commit first or pass `--allow-dirty` while you try it. Outside GitHub Actions the receipt is unsigned; to sign receipts and require them on pull requests, see [Use it in your repository](#use-it-in-your-repository). To give an agent the same loop, add the [MCP server](#agents-mcp-server-and-skills).

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
   until gh pr checks 2>/dev/null | grep -q "attested verify"; do sleep 5; done; gh pr checks --watch --required
   ```

   The loop waits for the checks to register; `gh pr checks --watch` exits with "no checks reported" if it runs in the first seconds after the PR opens.

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

1. Add the CLI and the CTRF reporter, both from npm.

   ```bash
   pnpm add -D @praxso/attested playwright-ctrf-json-reporter
   ```

   Add `['playwright-ctrf-json-reporter', { outputDir: 'attested', outputFile: 'ctrf.json' }]` to `reporter` in `playwright.config.ts`, and turn on `trace`, `video`, and `screenshot` as you like. Add `attested/` and `test-results/` to `.gitignore`.

2. Copy [`.github/workflows/attested.yml`](.github/workflows/attested.yml). It has two jobs. `attested run` runs your tests with a read-only token and uploads the results. `attested sign` has `id-token: write`, `attestations: write`, and `checks: write`; it runs only attested from the default branch head, never your PR's code, rebuilds the receipt from the results (`attested attest --from-results`), signs it, and posts the `attested` check.

3. Require verification. The hardened form is [`.github/workflows/attested-verify.yml`](.github/workflows/attested-verify.yml) required by an organization ruleset ([docs/rulesets/README.md](docs/rulesets/README.md)); it is written for this repository, so adjust the repository names. The minimal form, a job plus a repository ruleset that requires the check name, is in [docs/ruleset.md](docs/ruleset.md) with the reason for the head rule and why a required check name alone is weak.

## What a receipt proves

A receipt proves this commit's own test suite reported this result, signed by a job that ran no PR code; it does not prove the change is correct. A pull request can still weaken its own tests: delete them, skip them, change the config, or make a test write a passing `ctrf.json`. Review test changes like any other code. Planned follow-ups: a check that fails when tests disappear compared with the base branch's last receipt, and CODEOWNERS review for test files.

## What the required check guarantees

- The verify decision runs from a pinned default-branch commit through an organization ruleset. A pull request cannot replace it, remove it, or satisfy it with a same-named job.
- A pull request that edits the attesting workflow (`attested.yml`) or the verify workflow is blocked with `attesting workflow changed in this PR; merge requires an explicit admin bypass after review`.
- Limits: test files are PR-controlled by nature, so review test changes. Anyone with admin rights can bypass rulesets, including an agent running under an admin's account. Give agents a separate, non-admin bot identity; that is the real boundary.

## Commands

```
attested run [--expect-sha <sha>] [--allow-dirty] [--target-url <url>] [--health-path /healthz] [--ctrf attested/ctrf.json] [--output-dir test-results] [--packet attested/packet.json] -- <test command>
attested attest [--receipt attested/receipt.json] [--ctrf attested/ctrf.json]
attested attest --from-results <dir> [--out signed/attested] [--rerun <command>]
attested check [--artifact-url <url>] [--artifact-name <name>] [--attestation-url <url>]
```

- **`attested run`** refuses to start tests when `HEAD` differs from `--expect-sha`, when the tree is dirty without `--allow-dirty`, or, with `--target-url`, when `<url>/healthz` does not report a `sha` equal to the expected one; the receipt records only the build sha, the URL without credentials, query, or fragment, and the probe's status, never the health body. It writes `attested/receipt.json` and exits with the test command's exit code. It records `source.commit` and, on `pull_request`, `source.headCommit` (the PR head; `source.commit` is the synthetic merge commit there). On red it writes the failure packet.
- **`attested attest`** re-checks the subject digest and hands the predicate to the `actions/attest` steps that sign it. Outside Actions it warns that the receipt is unsigned. With `--from-results <dir>` it builds the receipt itself from a downloaded results directory (`attested/ctrf.json`, `test-results/`, the test config), treating every file as data: digests are recomputed, `source.commit` comes from `GITHUB_SHA`, `source.headCommit` from the event payload, `source.dirty` is `null`, and nothing the test job wrote about itself is read. This is what the sign job runs.
- **`attested check`** posts one check run named `attested`: `PASSED` is success, `FAILED` is failure, anything else is neutral. On a forked PR, or when the token cannot create check runs (HTTP 403), it prints the same summary to the job log and step summary with a one-line notice and exits 0.
- **`attested verify`** is the GitHub Action at the root of this repo (`action.yml`). It fails closed, one line per rule: `no receipt`, `no attestation found`, `predicate type mismatch`, `verification failed`, `no attestation from run`, `SHA mismatch`, `result FAILED`, `result missing`, `result unknown`, `test command failed`, `unsigned run from fork`. `WARNED` (skipped, pending, or other non-failed tests, passed tests that CTRF marks `flaky`, or a summary `flaky` count above zero) passes with a warning annotation. Inputs: `subject-path`, `repo`, `signer-workflow`, `head-sha`, `allow-unsigned` (forks pass with a `neutral:` warning).

### Failure packet

On red, `attested run` writes `attested/packet.json` (at most 12 KB, digest recorded in the receipt with kind `packet`, embedded in the `attested` check). It holds the failing tests grouped by file, line, and message (ANSI stripped, first 20 stack frames, evidence paths and digests), console errors and warnings grouped with counts, failed requests (method, path, status), and the exact rerun command. Console and network data come from the Playwright trace. URLs lose their query strings and fragments; bearer tokens, `key=`/`token=`/`password=` values, common token formats, and emails are masked; environment variables are never read into it. Over 12 KB, stacks are cut to five frames and then lists are cut from the tail (tests alphabetically, console and network most recent first) and `truncated` says what was cut.

## Agents: MCP server and skills

A real Claude Code session with the attested MCP server: a test fails, the failure packet says what broke, the agent fixes it and reruns, and the receipt's evidence checks out (about a minute):

https://github.com/user-attachments/assets/372ac548-e303-449f-98c0-5166b7a361f3

`@praxso/attested-mcp` is a stdio MCP server with three tools: `attested_run` (test command, optional `target_url`, `expected_sha`; returns the receipt summary and, on red, the packet), `attested_packet`, and `attested_status` (`verified`: the verdict from the signed attestation accepted under the same run, ref, and head policy as `attested verify`; `localReceipt`: the project's own receipt fields, labelled unverified). The server runs the attested CLI bundled with it; `ATTESTED_BIN` in the server's configuration is the only override. The skill tells the agent to run `attested_run` before opening a PR, and instead of taking or posting screenshots to show a change works; to read the packet on red, fix, rerun, and put the receipt digest in the PR body.

Both packages are on npm: [`@praxso/attested`](https://www.npmjs.com/package/@praxso/attested) 0.1.1 and [`@praxso/attested-mcp`](https://www.npmjs.com/package/@praxso/attested-mcp) 0.1.2, published from [release.yml](.github/workflows/release.yml) with npm provenance. To run a local build instead, replace `npx -y @praxso/attested-mcp@0.1.2` below with `node /path/to/attested/packages/mcp/bin/attested-mcp.js` after `pnpm build`.

**Claude Code**: install the plugin (MCP server plus skill) from this repo's marketplace.

```
/plugin marketplace add Praxso/attested
/plugin install attested@praxso
```

**Codex**: add the server to `~/.codex/config.toml` and copy the skill.

```toml
[mcp_servers.attested]
command = "npx"
args = ["-y", "@praxso/attested-mcp@0.1.2"]
```

```bash
mkdir -p ~/.codex/skills && cp -R codex/skills/attested ~/.codex/skills/
```

**Cursor**: `.cursor/mcp.json` in the project.

```json
{ "mcpServers": { "attested": { "command": "npx", "args": ["-y", "@praxso/attested-mcp@0.1.2"] } } }
```

**GitHub Copilot** in VS Code: `.vscode/mcp.json` in the project. Paste the steps of the skill file into `.github/copilot-instructions.md`.

```json
{ "servers": { "attested": { "type": "stdio", "command": "npx", "args": ["-y", "@praxso/attested-mcp@0.1.2"] } } }
```

**Any agent, through repository instructions.** Codex, Cursor, Copilot, and Claude Code read a repository's `AGENTS.md` or `CLAUDE.md`. Paste this in so the rule applies to every agent in the repository, with or without the plugin:

```markdown
## Showing that a change works

Never upload screenshots, recordings, or traces of this app to a public place, including a
new repository, a gist, or an image host. To show a reviewer that a change works, run the
tests through attested (the `attested_run` MCP tool, or
`npx @praxso/attested run -- <test command>`), fix and rerun until the result is PASSED,
and put the receipt digest in the pull request body. The traces and screenshots stay in the
workflow run's artifact.
```

## What gets signed

Two attestations per run, both with subject `ctrf.json`:

- `https://praxso.ai/attested/v0.1`: the receipt (`testResult`, `source`, `target`, `artifacts`, `tool`, `ctrf`, `createdAt`). **This predicate is authoritative.**
- `https://in-toto.io/attestation/test-result/v0.1`: the plain in-toto Test Result predicate, a projection of `testResult`.

The receipt file carries no `signed` field. `gh attestation verify` is the only answer to whether a receipt is signed.

## License

Apache-2.0.
