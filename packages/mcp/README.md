# @praxso/attested-mcp

MCP server for [attested](https://github.com/Praxso/attested): coding agents run your tests into a signed, verifiable receipt and read a redacted failure packet before they open a pull request.

## Tools

- `attested_run`: runs a test command through attested and returns the receipt summary; on red, the failure packet.
- `attested_packet`: returns the last failure packet.
- `attested_status`: returns the last receipt and whether a signed attestation exists for it.

## Set up

Claude Code:

```bash
claude mcp add attested -- npx -y @praxso/attested-mcp@0.1.0
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.attested]
command = "npx"
args = ["-y", "@praxso/attested-mcp@0.1.0"]
```

Cursor and Copilot configuration, the Claude Code plugin, and the Codex skill are in the repository README: https://github.com/Praxso/attested#agents-mcp-server-and-skills

Requires Node 22 or newer.

## License

Apache-2.0
