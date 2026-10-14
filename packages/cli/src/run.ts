import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULTS } from './constants.js';
import { buildReceipt, testResultFromCtrf, toolInfo, type Artifact, type Ctrf, type ReceiptPredicate } from './receipt.js';
import { AttestedError, classify, gitDirty, gitHead, gitRef, info, relPath, runUrl, sha256File, walk } from './util.js';

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

type Target = { buildSha: string | null; url: string | null; health?: unknown };

// Probe <url><healthPath> and require a `sha` field equal to expectedSha. Any failure is fatal:
// a receipt must not claim tests ran against a deployment it cannot identify.
async function probeTarget(url: string, healthPath: string, expectedSha: string): Promise<Target> {
  const target = new URL(healthPath, url).toString();
  let res: Response;
  let text: string;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(5000) });
    text = await res.text();
  } catch (err) {
    throw new AttestedError(`attested run: target ${target} is unreachable (${(err as Error).message}); refusing to run tests`);
  }
  if (!res.ok) throw new AttestedError(`attested run: target ${target} returned HTTP ${res.status}; refusing to run tests`);
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  const buildSha = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).sha === 'string'
    ? ((body as Record<string, string>).sha) : null;
  if (!buildSha) throw new AttestedError(`attested run: target ${target} did not report a build sha (expected JSON with a "sha" field); refusing to run tests`);
  if (buildSha !== expectedSha) {
    throw new AttestedError(`attested run: target ${target} is built from ${buildSha}, expected ${expectedSha}; refusing to run tests`);
  }
  return { buildSha, url, health: { probed: target, status: res.status, body } };
}

export async function run(opts: RunOptions): Promise<number> {
  const cwd = process.cwd();
  if (opts.command.length === 0) throw new AttestedError('attested run: no test command given (use `attested run -- <command>`)');

  // Fail-closed checks happen before any test runs.
  const head = gitHead(cwd);
  if (opts.expectSha) {
    if (!head) throw new AttestedError('attested run: --expect-sha given but HEAD could not be resolved');
    if (head !== opts.expectSha) throw new AttestedError(`attested run: HEAD is ${head}, expected ${opts.expectSha}; refusing to run tests`);
  }
  const dirty = gitDirty(cwd);
  if (dirty && !opts.allowDirty) {
    throw new AttestedError('attested run: working tree is dirty; commit or pass --allow-dirty');
  }
  // --target-url is fail-closed: the deployment must report the sha we are about to test.
  let target: Target = { buildSha: null, url: null };
  if (opts.targetUrl) {
    const expected = opts.expectSha ?? head;
    if (!expected) throw new AttestedError('attested run: --target-url needs --expect-sha or a git HEAD to compare the build sha against');
    target = await probeTarget(opts.targetUrl, opts.healthPath, expected);
    info(`target ${opts.targetUrl} reports build ${target.buildSha}`);
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
    throw new AttestedError(`attested run: CTRF report not found at ${opts.ctrf} (configure the CTRF reporter or pass --ctrf)`);
  }
  const ctrf = JSON.parse(readFileSync(ctrfPath, 'utf8')) as Ctrf;
  if (!ctrf.results) throw new AttestedError(`attested run: ${opts.ctrf} is not a CTRF report (missing "results")`);

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
