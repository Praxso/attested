import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assemble, writeReceipt } from './assemble.js';
import { DEFAULTS, PREDICATE_TYPE, TEST_RESULT_PREDICATE_TYPE } from './constants.js';
import type { Receipt } from './receipt.js';
import { AttestedError, inActions, info, readEvent, relPath, sha256File, warn } from './util.js';

export type AttestOptions = {
  receipt: string; ctrf: string; predicate: string; testResultPredicate: string;
  // --from-results mode: build the receipt in a job that runs no PR code, from a downloaded results directory.
  fromResults: string | null; out: string; outputDir: string; config: string | null; rerun: string | null;
};

export function defaultAttestOptions(): AttestOptions {
  return {
    receipt: DEFAULTS.receipt, ctrf: DEFAULTS.ctrf, predicate: DEFAULTS.predicate, testResultPredicate: DEFAULTS.testResultPredicate,
    fromResults: null, out: 'signed/attested', outputDir: DEFAULTS.outputDir, config: null, rerun: null,
  };
}

function emitOutputs(subjectPath: string, sha256: string, predicatePath: string, testResultPath: string): void {
  setOutput('subject-path', subjectPath);
  setOutput('subject-sha256', sha256);
  setOutput('predicate-path', predicatePath);
  setOutput('predicate-type', PREDICATE_TYPE);
  setOutput('test-result-predicate-path', testResultPath);
  setOutput('test-result-predicate-type', TEST_RESULT_PREDICATE_TYPE);
  info(`prepared predicate for actions/attest: subject ctrf.json sha256:${sha256}, type ${PREDICATE_TYPE}`);
}

// The results directory (attested/ctrf.json, test-results/, the test config) was written by PR code and is only read
// and hashed here. Everything about the source comes from the event context of this job, never from those files.
export function attestFromResults(opts: AttestOptions): number {
  const root = resolve(opts.fromResults!);
  if (!existsSync(root) && !isSymlink(root)) throw new AttestedError(`attested attest: results directory ${opts.fromResults} not found`);
  if (isSymlink(root)) throw new AttestedError(`attested attest: results directory ${opts.fromResults} is a symlink; refusing to read it`);
  if (!statSync(root).isDirectory()) throw new AttestedError(`attested attest: results directory ${opts.fromResults} is not a directory`);
  const commit = process.env.GITHUB_SHA;
  if (!commit) throw new AttestedError('attested attest: --from-results needs GITHUB_SHA (the commit the test job checked out) from the workflow context');
  const a = assemble(root, { ctrf: opts.ctrf, outputDir: opts.outputDir, config: opts.config, rerun: opts.rerun ?? 'see the attested run job', who: 'attested attest' });

  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const subjectPath = join(out, 'ctrf.json');
  copyFileSync(resolve(root, opts.ctrf), subjectPath);
  if (sha256File(subjectPath).sha256 !== a.subject.sha256) throw new AttestedError('attested attest: ctrf.json changed while copying; refusing to attest');
  const paths = { receipt: join(out, 'receipt.json'), predicate: join(out, 'predicate.json'), testResultPredicate: join(out, 'test-result.json'), packet: join(out, 'packet.json') };
  writeReceipt(a, { ...paths, packetArtifactPath: relPath(dirname(out), paths.packet) }, {
    source: { commit, headCommit: readEvent()?.pull_request?.head?.sha ?? null, dirty: null, ref: process.env.GITHUB_REF ?? null },
    target: { buildSha: null, url: null },
    createdAt: new Date().toISOString(),
  });
  if (!inActions()) warn('not running in GitHub Actions: receipt is UNSIGNED and no attestation was created.');
  emitOutputs(subjectPath, a.subject.sha256, paths.predicate, paths.testResultPredicate);
  return 0;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  else info(`output ${name}=${value}`);
}

export function attest(opts: AttestOptions): number {
  if (opts.fromResults) return attestFromResults(opts);
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

  emitOutputs(ctrfPath, actual, resolve(cwd, opts.predicate), resolve(cwd, opts.testResultPredicate));
  return 0;
}
