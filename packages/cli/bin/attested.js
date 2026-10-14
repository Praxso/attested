#!/usr/bin/env node
// Committed launcher so the bin shim exists before `pnpm build` runs.
// pnpm does not create a bin shim for a workspace package whose bin target is
// missing at install time, and dist/ only exists after the build.
import('../dist/index.js').catch((err) => {
  process.stderr.write(`attested: not built (${err.message}); run \`pnpm build\` first\n`);
  process.exit(1);
});
