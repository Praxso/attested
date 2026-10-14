import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULTS } from './constants.js';
import { buildReceipt, testResultFromCtrf, toolInfo, type Artifact, type Ctrf, type ReceiptPredicate } from './receipt.js';
import { ProveError, classify, gitDirty, gitHead, gitRef, info, relPath, runUrl, sha256File, walk, warn } from './util.js';

export type RunOptions = {
  command: string[];
  ctrf: string;
  outputDir: string;
  receipt: string;
  predicate: string;
  testResultPredicate: string;
  config: string | null;
  expectSha: string | null;
  allowDirty: boolean;
  targetUrl: string | null;
  healthPath: string;
};

export function defaultRunOptions(): RunOptions {
  return {
    command: [],
    ctrf: DEFAULTS.ctrf,
    outputDir: DEFAULTS.outputDir,
    receipt: DEFAULTS.receipt,
    predicate: DEFAULTS.predicate,
    testResultPredicate: DEFAULTS.testResultPredicate,
    config: null,
    expectSha: null,
    allowDirty: false,
    targetUrl: null,
    healthPath: DEFAULTS.healthPath,
  };
}

async function probeTarget(url: string, healthPath: string): Promise<{ buildSha: string | null; url: string; health: unknown }> {
  const target = new URL(healthPath, url).toString();
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const buildSha = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).sha === 'string'
      ? ((body as Record<string, string>).sha) : null;
    return { buildSha, url, health: { probed: target, status: res.status, body } };
  } catch (err) {
    warn(`target probe of ${target} failed: ${(err as Error).message}`);
    return { buildSha: null, url, health: { probed: target, error: (err as Error).message } };
  }
}

export async function run(opts: RunOptions): Promise<number> {
  const cwd = process.cwd();
  if (opts.command.length === 0) throw new ProveError('prove run: no test command given (use `prove run -- <command>`)');

  // Fail-closed checks happen before any test runs.
  const head = gitHead(cwd);
  if (opts.expectSha) {
    if (!head) throw new ProveError('prove run: --expect-sha given but HEAD could not be resolved');
    if (head !== opts.expectSha) throw new ProveError(`prove run: HEAD is ${head}, expected ${opts.expectSha}; refusing to run tests`);
  }
  const dirty = gitDirty(cwd);
  if (dirty && !opts.allowDirty) {
    throw new ProveError('prove run: working tree is dirty; commit or pass --allow-dirty');
  }

  const ctrfPath = resolve(cwd, opts.ctrf);
  rmSync(ctrfPath, { force: true });
  mkdirSync(dirname(ctrfPath), { recursive: true });

  info(`running: ${opts.command.join(' ')}`);
  const started = new Date().toISOString();
  const child = spawnSync(opts.command[0], opts.command.slice(1), { stdio: 'inherit', cwd, env: process.env });
  const exitCode = child.status ?? 1;
  info(`test command exited with ${exitCode}`);

  if (!existsSync(ctrfPath)) {
    throw new ProveError(`prove run: CTRF report not found at ${opts.ctrf} (configure the CTRF reporter or pass --ctrf)`);
  }
  const ctrf = JSON.parse(readFileSync(ctrfPath, 'utf8')) as Ctrf;
  if (!ctrf.results) throw new ProveError(`prove run: ${opts.ctrf} is not a CTRF report (missing "results")`);

  const subject = sha256File(ctrfPath);
  const artifacts: Artifact[] = [{ path: relPath(cwd, ctrfPath), ...subject, kind: 'report' }];
  for (const file of walk(resolve(cwd, opts.outputDir))) {
    artifacts.push({ path: relPath(cwd, file), ...sha256File(file), kind: classify(file) });
  }

  const configuration: ReceiptPredicate['testResult']['configuration'] = [];
  const configPath = opts.config ?? ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find((p) => existsSync(resolve(cwd, p))) ?? null;
  if (configPath) configuration.push({ name: configPath, digest: { sha256: sha256File(resolve(cwd, configPath)).sha256 } });
  if (process.env.GITHUB_WORKFLOW_REF) configuration.push({ name: process.env.GITHUB_WORKFLOW_REF, digest: { gitCommit: process.env.GITHUB_SHA ?? '' } });

  const url = runUrl();
  const testResult = testResultFromCtrf(ctrf, configuration, url);
  const target = opts.targetUrl ? await probeTarget(opts.targetUrl, opts.healthPath) : { buildSha: null, url: null };

  const predicate: ReceiptPredicate = {
    testResult,
    source: { commit: head, dirty, ref: gitRef(cwd) },
    target,
    artifacts,
    tool: toolInfo(),
    ctrf: { specVersion: ctrf.specVersion ?? null, tool: ctrf.results.tool ?? null, summary: ctrf.results.summary ?? null },
    createdAt: started,
  };
  const receipt = buildReceipt(subject.sha256, predicate);

  const receiptPath = resolve(cwd, opts.receipt);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(resolve(cwd, opts.predicate), JSON.stringify(predicate, null, 2) + '\n');
  // Second, pure in-toto Test Result statement for interoperability.
  writeFileSync(resolve(cwd, opts.testResultPredicate), JSON.stringify(testResult, null, 2) + '\n');

  info(`receipt: ${opts.receipt} (${testResult.result}, ${testResult.passedTests.length} passed, ${testResult.failedTests.length} failed, ${artifacts.length} artifacts)`);
  if (testResult.failedTests.length) info(`failed: ${testResult.failedTests.join('; ')}`);
  return exitCode;
}
