import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildPacket, serializePacket, type Packet } from './packet.js';
import { buildReceipt, testResultFromCtrf, toolInfo, validateCtrf, type Artifact, type Ctrf, type Receipt, type ReceiptPredicate } from './receipt.js';
import { clean } from './redact.js';
import { AttestedError, checkInside, classify, info, readInside, relPath, runUrl, sha256File, walk } from './util.js';

// Largest ctrf.json that is parsed. CTRF for tens of thousands of tests is a few MB.
export const MAX_CTRF_BYTES = 32 * 1024 * 1024;
const SUMMARY_FIELDS = ['tests', 'passed', 'failed', 'skipped', 'pending', 'other', 'flaky', 'start', 'stop', 'duration'] as const;

// The CTRF metadata copied into the receipt: allowlisted fields only, strings redacted and bounded, counts numeric.
// The ctrf.json subject itself is never rewritten; only these copies are.
export function ctrfMeta(ctrf: Ctrf): ReceiptPredicate['ctrf'] {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? clean(v, max) : null);
  const t = ctrf.results.tool;
  const tool = t && typeof t === 'object' ? { name: str((t as Record<string, unknown>).name, 100), version: str((t as Record<string, unknown>).version, 50) } : null;
  const s = ctrf.results.summary;
  let summary: Record<string, number> | null = null;
  if (s && typeof s === 'object') {
    summary = {};
    for (const k of SUMMARY_FIELDS) {
      const v = (s as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) summary[k] = v;
    }
  }
  return { specVersion: str(ctrf.specVersion, 32), tool, summary };
}

// Longest file path or configuration name written into the signed predicate.
const MAX_PUBLIC_PATH = 1000;

// A path as it is written into the signed, public predicate. Paths must stay exact so the evidence can be checked
// against them, so a path that redaction would change (it looks like it holds a secret or an email) or that is too
// long is refused rather than rewritten.
export function publicPath(root: string, file: string, who: string): string {
  const path = relPath(root, file);
  if (clean(path, MAX_PUBLIC_PATH) !== path) throw new AttestedError(`${who}: refusing to publish the path ${clean(path, 200)}: it is over ${MAX_PUBLIC_PATH} characters or looks like it contains a secret or an email; rename it`);
  return path;
}

export type Assembled = {
  ctrf: Ctrf;
  subject: { sha256: string; bytes: number };
  artifacts: Artifact[];
  testResult: ReceiptPredicate['testResult'];
  packet: Packet | null;
};

// Everything the receipt says about the run, computed from files under `root` only: the CTRF report, the output dir,
// and the test config. Used by `attested run` (root = the project) and by `attested attest --from-results`
// (root = a downloaded results directory, which is treated strictly as data).
export function assemble(root: string, o: { ctrf: string; outputDir: string; config: string | null; rerun: string; who: string }): Assembled {
  const ctrfPath = resolve(root, o.ctrf);
  if (!checkInside(root, ctrfPath, 'CTRF report')) throw new AttestedError(`${o.who}: CTRF report not found at ${o.ctrf} (configure the CTRF reporter or pass --ctrf)`);
  const size = statSync(ctrfPath).size;
  if (size > MAX_CTRF_BYTES) throw new AttestedError(`${o.who}: ${o.ctrf} is ${size} bytes, over the ${MAX_CTRF_BYTES}-byte limit for CTRF reports`);
  // One descriptor: the bytes parsed are the bytes hashed into the subject, whatever happens to the path meanwhile.
  const bytes = readInside(root, ctrfPath, MAX_CTRF_BYTES, 'CTRF report');
  if (!bytes) throw new AttestedError(`${o.who}: CTRF report not found at ${o.ctrf}`);
  let ctrf: Ctrf;
  try { ctrf = JSON.parse(bytes.toString('utf8')) as Ctrf; } catch { throw new AttestedError(`${o.who}: ${o.ctrf} is not valid JSON`); }
  const invalid = validateCtrf(ctrf);
  if (invalid) throw new AttestedError(`${o.who}: ${o.ctrf} is not a CTRF report (${invalid})`);

  const subject = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const artifacts: Artifact[] = [{ path: publicPath(root, ctrfPath, o.who), ...subject, kind: 'report' }];
  const outputDir = resolve(root, o.outputDir);
  if (checkInside(root, outputDir, 'output directory')) {
    for (const file of walk(outputDir)) artifacts.push({ path: publicPath(root, file, o.who), ...sha256File(file), kind: classify(file) });
  }

  const configuration: ReceiptPredicate['testResult']['configuration'] = [];
  const configPath = o.config ?? ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find((p) => checkInside(root, resolve(root, p), 'test config')) ?? null;
  if (configPath && checkInside(root, resolve(root, configPath), 'test config')) configuration.push({ name: publicPath(root, resolve(root, configPath), o.who), digest: { sha256: sha256File(resolve(root, configPath)).sha256 } });
  if (process.env.GITHUB_WORKFLOW_REF) configuration.push({ name: clean(process.env.GITHUB_WORKFLOW_REF, MAX_PUBLIC_PATH), digest: { gitCommit: process.env.GITHUB_SHA ?? '' } });

  const testResult = testResultFromCtrf(ctrf, configuration, runUrl());
  const packet = testResult.result === 'FAILED' ? buildPacket(ctrf, artifacts, root, o.rerun) : null;
  return { ctrf, subject, artifacts, testResult, packet };
}

export type Outputs = { receipt: string; predicate: string; testResultPredicate: string; packet: string; packetArtifactPath: string };

// Write the packet (on red), the receipt, the predicate, and the in-toto Test Result predicate.
export function writeReceipt(a: Assembled, out: Outputs, rest: Pick<ReceiptPredicate, 'source' | 'target' | 'createdAt'>): Receipt {
  const artifacts = [...a.artifacts];
  rmSync(out.packet, { force: true });
  if (a.packet) {
    mkdirSync(dirname(out.packet), { recursive: true });
    writeFileSync(out.packet, serializePacket(a.packet));
    // The packet's digest sits next to the evidence it points at.
    artifacts.push({ path: out.packetArtifactPath, ...sha256File(out.packet), kind: 'packet' });
    info(`failure packet: ${out.packetArtifactPath} (${a.packet.failingTests.length} failure groups${a.packet.truncated ? ', truncated' : ''})`);
  }
  const predicate: ReceiptPredicate = {
    testResult: a.testResult,
    source: rest.source,
    target: rest.target,
    artifacts,
    tool: toolInfo(),
    ctrf: ctrfMeta(a.ctrf),
    createdAt: rest.createdAt,
  };
  const receipt = buildReceipt(a.subject.sha256, predicate);
  mkdirSync(dirname(out.receipt), { recursive: true });
  writeFileSync(out.receipt, JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(out.predicate, JSON.stringify(predicate, null, 2) + '\n');
  // Second, pure in-toto Test Result statement for interoperability.
  writeFileSync(out.testResultPredicate, JSON.stringify(a.testResult, null, 2) + '\n');
  const tr = a.testResult;
  info(`receipt: ${relPath(process.cwd(), out.receipt)} (${tr.result}, ${tr.passedTests.length} passed, ${tr.failedTests.length} failed, ${artifacts.length} artifacts)`);
  if (tr.failedTests.length) info(`failed: ${tr.failedTests.join('; ')}`);
  return receipt;
}
