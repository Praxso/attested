# @praxso/attested-mcp

MCP server for [attested](https://github.com/Praxso/attested): coding agents run your tests into a signed, verifiable receipt and read a redacted failure packet before they open a pull request.

## Tools

- `attested_run`: runs a test command through attested and returns the receipt summary; on red, the failure packet.
- `attested_packet`: returns the last failure packet, after checking its shape. A packet that is a symlink or resolves outside the project is refused.
- `attested_status`: returns `verified`, the verdict from the signed attestation that `gh attestation verify` accepts under the required check's policy (the attesting run and its ref, from the GitHub API or `run_id`/`source_ref`, and the head commit), and `localReceipt`, the project's own receipt fields, labelled unverified.

The server runs the attested CLI bundled with it. To run a different build, set `ATTESTED_BIN` in the server's own MCP configuration; a `node_modules/.bin/attested` in the project is never used. If the bundled CLI cannot be resolved, `attested_run` fails with an error saying so; it never falls back to another version.

## Set up

Claude Code:

```bash
claude mcp add attested -- npx -y @praxso/attested-mcp@0.1.1
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.attested]
command = "npx"
args = ["-y", "@praxso/attested-mcp@0.1.1"]
```

Cursor and Copilot configuration, the Claude Code plugin, and the Codex skill are in the repository README: https://github.com/Praxso/attested#agents-mcp-server-and-skills

Requires Node 22 or newer.

## License

Apache-2.0
