#!/usr/bin/env node
// Committed launcher so the bin shim exists before `pnpm build` runs (same reason as packages/cli/bin/attested.js).
import('../dist/index.js').catch((err) => {
  process.stderr.write(`attested-mcp: not built (${err.message}); run \`pnpm build\` first\n`);
  process.exit(1);
});
