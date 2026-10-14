import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, PREDICATE_TYPE, TEST_RESULT_PREDICATE_TYPE } from './constants.js';
import type { Receipt } from './receipt.js';
import { AttestedError, inActions, info, sha256File, warn } from './util.js';

export type AttestOptions = { receipt: string; ctrf: string; predicate: string; testResultPredicate: string };

export function defaultAttestOptions(): AttestOptions {
  return { receipt: DEFAULTS.receipt, ctrf: DEFAULTS.ctrf, predicate: DEFAULTS.predicate, testResultPredicate: DEFAULTS.testResultPredicate };
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  else info(`output ${name}=${value}`);
}

export function attest(opts: AttestOptions): number {
  const cwd = process.cwd();
  const receiptPath = resolve(cwd, opts.receipt);
  const ctrfPath = resolve(cwd, opts.ctrf);
  if (!existsSync(receiptPath)) throw new AttestedError(`attested attest: receipt not found at ${opts.receipt}; run \`attested run\` first`);
  if (!existsSync(ctrfPath)) throw new AttestedError(`attested attest: CTRF report not found at ${opts.ctrf}`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;

  const actual = sha256File(ctrfPath).sha256;
  const expected = receipt.subject[0]?.digest.sha256;
  if (actual !== expected) {
    throw new AttestedError(`attested attest: ${opts.ctrf} changed since \`attested run\` (sha256 ${actual} != ${expected}); refusing to attest`);
  }

  if (!inActions()) {
    // The receipt carries no signed/unsigned claim; `gh attestation verify` is the only answer to that question.
    warn('not running in GitHub Actions: receipt is UNSIGNED and no attestation was created. Push to GitHub to get a Sigstore-signed attestation.');
    return 0;
  }

  // In Actions, signing is delegated to the actions/attest step that follows.
  // The predicate file was written by `attested run`; we re-emit it from the receipt so the two cannot drift.
  writeFileSync(resolve(cwd, opts.predicate), JSON.stringify(receipt.predicate, null, 2) + '\n');
  writeFileSync(resolve(cwd, opts.testResultPredicate), JSON.stringify(receipt.predicate.testResult, null, 2) + '\n');

  setOutput('subject-path', ctrfPath);
  setOutput('subject-sha256', actual);
  setOutput('predicate-path', resolve(cwd, opts.predicate));
  setOutput('predicate-type', PREDICATE_TYPE);
  setOutput('test-result-predicate-path', resolve(cwd, opts.testResultPredicate));
  setOutput('test-result-predicate-type', TEST_RESULT_PREDICATE_TYPE);
  info(`prepared predicate for actions/attest: subject ctrf.json sha256:${actual}, type ${PREDICATE_TYPE}`);
  return 0;
}
