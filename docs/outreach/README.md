# Listings and outreach (prepared, not submitted)

Nothing in this folder has been sent anywhere. Each item says who submits it and what has to happen first.

Prerequisite for the MCP registry, the Claude Code plugin, and the Codex entry: `@praxso/attested` 0.1.0 and `@praxso/attested-mcp` on npm (`pnpm --filter @praxso/attested-mcp publish --access public` for a new MCP version, from an npm account that owns the `@praxso` scope). The plugin's `.mcp.json` and every config snippet run `npx -y @praxso/attested-mcp@0.1.1`, so publish 0.1.1 before merging the pin.

## 1. MCP registry: `io.github.Praxso/attested` (submit after Zach approves)

File: [`packages/mcp/server.json`](../../packages/mcp/server.json). `package.json` carries the matching `"mcpName": "io.github.Praxso/attested"`, which the registry checks against the npm package. Publish with the registry's `mcp-publisher` CLI: `mcp-publisher login github` (as a member of the Praxso org), then `mcp-publisher publish` from `packages/mcp`. Check the `$schema` date against the registry docs on the day of publishing.

Listing text (the `description` field, 97 characters, under the registry's 100-character limit):

> Run tests into a Sigstore-signed receipt; get a redacted failure packet on red. No images posted.

## 2. Claude Code plugin marketplace (Zach submits or approves)

This repository is already a marketplace (`.claude-plugin/marketplace.json`, name `praxso`). Anyone can install with `/plugin marketplace add Praxso/attested` and `/plugin install attested@praxso`. `claude plugin validate` passes for the plugin and the marketplace.

For Anthropic's plugin directory, submit `plugins/attested` through the form linked from the Claude Code docs ("Submit to Anthropic's directory"). Entry text:

- Name: attested
- One line: Prove the tests pass before the PR opens: a Sigstore-signed test receipt, a redacted failure packet on red, and no screenshots posted anywhere.
- Description: attested gives Claude Code three MCP tools (`attested_run`, `attested_packet`, `attested_status`) and a skill that runs your Playwright or CTRF tests before a pull request is opened. On red, Claude reads a 12 KB failure packet (failing tests, stack frames, console errors, failed requests, secrets masked), fixes the code, and reruns. In GitHub Actions the receipt is signed with Sigstore through `actions/attest`, and the `attested verify` action becomes a required check. Traces, videos, and screenshots stay in the workflow artifact; nothing is uploaded to the PR.
- Category: Testing / Code review
- Repository: https://github.com/Praxso/attested
- License: Apache-2.0

## 3. Codex skill directory (Zach approves)

Skill folder: [`codex/skills/attested/SKILL.md`](../../codex/skills/attested/SKILL.md). Entry text:

- Name: attested
- Description: Run Playwright or CTRF tests through attested before opening a PR, and instead of screenshots to show a change works; read the redacted failure packet on red, fix, rerun until green, and put the signed-receipt digest in the PR body. Needs the `attested` MCP server (`npx -y @praxso/attested-mcp@0.1.1`).
- Install: `cp -R codex/skills/attested ~/.codex/skills/`, plus the `[mcp_servers.attested]` block from the README.

## 4. GitHub Actions Marketplace: `attested verify` (ours to publish)

`action.yml` is at the repository root with `name: attested verify`, a description, and `branding` (icon `check-circle`, color green), which is what the Marketplace requires. Publishing cannot be done from the API or CLI: on github.com, Releases → Draft a new release → tick "Publish this Action to the GitHub Marketplace", pick the primary category "Continuous integration" and secondary "Security", tag `v0.1.0`. The first time, the Praxso org owner must accept the GitHub Marketplace Developer Agreement and have 2FA on. That click needs Zach.

Listing text (from `action.yml`):

> Required check for attested test receipts. Verifies the Sigstore attestation, the head commit, and the result; fails closed.

## 5. CTRF integrations list (Zach opens the PR)

[`ctrf-integrations.patch`](ctrf-integrations.patch) against `ctrf-io/ctrf` `README.md` at `e325eb33c7662a208bfa4d093a41cc55439d6e6a`. The list itself lives on https://ctrf.io/integrations, whose source is not in a public `ctrf-io` repository, so the patch adds a line under the README's "Integrations" heading; the maintainers may prefer to move it to the site. PR title: "Add attested to integrations". PR body:

> attested (https://github.com/Praxso/attested, Apache-2.0) reads a CTRF report and turns it into a Sigstore-signed test receipt through GitHub artifact attestations. The CTRF report is the signed subject, so any CTRF reporter works. Happy to move this to the integrations page if that is the better place.

## 6. Playwright MCP README (Zach opens the PR)

[`playwright-mcp-related-tools.patch`](playwright-mcp-related-tools.patch) against `microsoft/playwright-mcp` `README.md` at `b8b4183e099f136cbec0388a6088d4aa2f6b9685`. The README has no related-tools section today, so the patch adds one above "Security"; maintainers may decline a new section. PR title: "README: add a related tools section". PR body:

> attested (https://github.com/Praxso/attested, Apache-2.0) is an MCP server that turns a Playwright run into a signed test receipt and gives agents a redacted failure packet on red. It keeps traces, videos, and screenshots in the CI workflow artifact rather than posting them to pull requests. Adding a short related-tools section; glad to drop it if you would rather not list third-party tools.
