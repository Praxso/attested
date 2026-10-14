
import { attest, defaultAttestOptions } from './attest.js';
import { check, defaultCheckOptions } from './check.js';
import { defaultRunOptions, run } from './run.js';
import { AttestedError } from './util.js';
import { TOOL_VERSION } from './constants.js';

const USAGE = `attested ${TOOL_VERSION}

Usage:
  attested run [options] -- <test command>
  attested attest [options]
  attested check [options]

run options:
  --ctrf <path>          CTRF report the test command writes (default attested/ctrf.json)
  --output-dir <dir>     Playwright output dir to hash (default test-results)
  --config <path>        test config file to record (default: playwright.config.*)
  --expect-sha <sha>     refuse to run unless HEAD equals <sha>
  --allow-dirty          allow a dirty working tree
  --target-url <url>     fail before tests unless <url>/healthz reports sha == --expect-sha (or HEAD)
  --health-path <path>   health path for --target-url (default /healthz)
  --receipt <path>       where to write the receipt (default attested/receipt.json)
  --packet <path>        where to write the failure packet on red (default attested/packet.json)

attest options:
  --receipt <path>, --ctrf <path>

check options (posts the "attested" check run; needs GITHUB_TOKEN with checks: write):
  --artifact-url <url>       link to the uploaded workflow artifact
  --artifact-name <name>     workflow artifact name, for the paste-able verify command
  --attestation-url <url>    link to the receipt attestation
  --receipt <path>, --packet <path>
`;

function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new AttestedError(`${flag} needs a value`);
  return v;
}

// Like takeValue, but an empty string (an unset workflow output) means "not given".
function optValue(args: string[], i: number, flag: string): string | null {
  const v = args[i + 1];
  if (v === undefined) throw new AttestedError(`${flag} needs a value`);
  return v === '' ? null : v;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(USAGE); return cmd ? 0 : 2; }
  if (cmd === '--version') { process.stdout.write(TOOL_VERSION + '\n'); return 0; }

  if (cmd === 'run') {
    const o = defaultRunOptions();
    o.argv = argv;
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
      else if (a === '--packet') o.packet = takeValue(rest, i++, a);
      else throw new AttestedError(`unknown option ${a}`);
    }
    return run(o);
  }
  if (cmd === 'attest') {
    const o = defaultAttestOptions();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--receipt') o.receipt = takeValue(rest, i++, a);
      else if (a === '--ctrf') o.ctrf = takeValue(rest, i++, a);
      else throw new AttestedError(`unknown option ${a}`);
    }
    return attest(o);
  }
  if (cmd === 'check') {
    const o = defaultCheckOptions();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--receipt') o.receipt = takeValue(rest, i++, a);
      else if (a === '--packet') o.packet = takeValue(rest, i++, a);
      else if (a === '--artifact-url') o.artifactUrl = optValue(rest, i++, a);
      else if (a === '--artifact-name') o.artifactName = optValue(rest, i++, a);
      else if (a === '--attestation-url') o.attestationUrl = optValue(rest, i++, a);
      else throw new AttestedError(`unknown option ${a}`);
    }
    return check(o);
  }
  throw new AttestedError(`unknown command ${cmd}\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`attested: error: ${err instanceof AttestedError ? err.message : (err as Error).stack}\n`);
    process.exit(err instanceof AttestedError ? 2 : 1);
  },
);
