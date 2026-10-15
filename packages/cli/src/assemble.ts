import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildPacket, serializePacket, type Packet } from './packet.js';
import { buildReceipt, testResultFromCtrf, toolInfo, type Artifact, type Ctrf, type Receipt, type ReceiptPredicate } from './receipt.js';
import { AttestedError, classify, info, relPath, runUrl, sha256File, walk } from './util.js';

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
  if (!existsSync(ctrfPath)) throw new AttestedError(`${o.who}: CTRF report not found at ${o.ctrf} (configure the CTRF reporter or pass --ctrf)`);
  let ctrf: Ctrf;
  try { ctrf = JSON.parse(readFileSync(ctrfPath, 'utf8')) as Ctrf; } catch { throw new AttestedError(`${o.who}: ${o.ctrf} is not valid JSON`); }
  if (!ctrf || typeof ctrf !== 'object' || !ctrf.results) throw new AttestedError(`${o.who}: ${o.ctrf} is not a CTRF report (missing "results")`);

  const subject = sha256File(ctrfPath);
  const artifacts: Artifact[] = [{ path: relPath(root, ctrfPath), ...subject, kind: 'report' }];
  for (const file of walk(resolve(root, o.outputDir))) artifacts.push({ path: relPath(root, file), ...sha256File(file), kind: classify(file) });

  const configuration: ReceiptPredicate['testResult']['configuration'] = [];
  const configPath = o.config ?? ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find((p) => existsSync(resolve(root, p))) ?? null;
  if (configPath && existsSync(resolve(root, configPath))) configuration.push({ name: configPath, digest: { sha256: sha256File(resolve(root, configPath)).sha256 } });
  if (process.env.GITHUB_WORKFLOW_REF) configuration.push({ name: process.env.GITHUB_WORKFLOW_REF, digest: { gitCommit: process.env.GITHUB_SHA ?? '' } });

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
    ctrf: { specVersion: a.ctrf.specVersion ?? null, tool: a.ctrf.results.tool ?? null, summary: a.ctrf.results.summary ?? null },
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
