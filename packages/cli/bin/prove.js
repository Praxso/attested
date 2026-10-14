#!/usr/bin/env node
// Committed launcher so the bin shim exists before `pnpm build` runs.
// Without it, `pnpm exec prove` falls through to Perl's TAP harness /usr/bin/prove.
import('../dist/index.js').catch((err) => {
  process.stderr.write(`prove: not built (${err.message}); run \`pnpm build\` first\n`);
  process.exit(1);
});
