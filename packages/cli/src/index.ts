#!/usr/bin/env node
import { attest, defaultAttestOptions } from './attest.js';
import { defaultRunOptions, run } from './run.js';
import { ProveError } from './util.js';
import { TOOL_VERSION } from './constants.js';

const USAGE = `prove ${TOOL_VERSION}

Usage:
  prove run [options] -- <test command>
  prove attest [options]

run options:
  --ctrf <path>          CTRF report the test command writes (default prove/ctrf.json)
  --output-dir <dir>     Playwright output dir to hash (default test-results)
  --config <path>        test config file to record (default: playwright.config.*)
  --expect-sha <sha>     refuse to run unless HEAD equals <sha>
  --allow-dirty          allow a dirty working tree
  --target-url <url>     probe <url>/healthz and record the result
  --health-path <path>   health path for --target-url (default /healthz)
  --receipt <path>       where to write the receipt (default prove/receipt.json)

attest options:
  --receipt <path>, --ctrf <path>
`;

function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ProveError(`${flag} needs a value`);
  return v;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(USAGE); return cmd ? 0 : 2; }
  if (cmd === '--version') { process.stdout.write(TOOL_VERSION + '\n'); return 0; }

  if (cmd === 'run') {
    const o = defaultRunOptions();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--') { o.command = rest.slice(i + 1); break; }
      else if (a === '--ctrf') o.ctrf = takeValue(rest, i++, a);
      else if (a === '--output-dir') o.outputDir = takeValue(rest, i++, a);
      else if (a === '--config') o.config = takeValue(rest, i++, a);
      else if (a === '--expect-sha') o.expectSha = takeValue(rest, i++, a);
      else if (a === '--allow-dirty') o.allowDirty = true;
      else if (a === '--target-url') o.targetUrl = takeValue(rest, i++, a);
      else if (a === '--health-path') o.healthPath = takeValue(rest, i++, a);
      else if (a === '--receipt') o.receipt = takeValue(rest, i++, a);
      else throw new ProveError(`unknown option ${a}`);
    }
    return run(o);
  }
  if (cmd === 'attest') {
    const o = defaultAttestOptions();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--receipt') o.receipt = takeValue(rest, i++, a);
      else if (a === '--ctrf') o.ctrf = takeValue(rest, i++, a);
      else throw new ProveError(`unknown option ${a}`);
    }
    return attest(o);
  }
  throw new ProveError(`unknown command ${cmd}\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`prove: error: ${err instanceof ProveError ? err.message : (err as Error).stack}\n`);
    process.exit(err instanceof ProveError ? 2 : 1);
  },
);
