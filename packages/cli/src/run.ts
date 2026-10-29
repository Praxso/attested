import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULTS } from './constants.js';
import { assemble, writeReceipt } from './assemble.js';
import { clean, stripUrl } from './redact.js';
import { rerunCommand } from './packet.js';
import { AttestedError, gitDirty, gitHead, gitRef, info, readEvent, relPath } from './util.js';

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
  packet: string;
  argv: string[];
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
    packet: DEFAULTS.packet,
    argv: [],
  };
}

type Target = { buildSha: string | null; url: string | null; health?: unknown };

// A target URL as written into the receipt: no credentials, query, or fragment; redacted and bounded.
export function publicUrl(u: string): string {
  return clean(stripUrl(u).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1'), 300);
}

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
  // Allowlisted fields only: the health body can carry anything, so it is never copied into the receipt.
  return { buildSha, url: publicUrl(url), health: { probed: publicUrl(target), status: res.status } };
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

  const a = assemble(cwd, { ctrf: opts.ctrf, outputDir: opts.outputDir, config: opts.config, rerun: rerunCommand(opts.argv), who: 'attested run' });
  const packet = resolve(cwd, opts.packet);
  writeReceipt(a, {
    receipt: resolve(cwd, opts.receipt),
    predicate: resolve(cwd, opts.predicate),
    testResultPredicate: resolve(cwd, opts.testResultPredicate),
    packet,
    packetArtifactPath: relPath(cwd, packet),
  }, {
    source: { commit: head, headCommit: readEvent()?.pull_request?.head?.sha ?? null, dirty, ref: gitRef(cwd) },
    target,
    createdAt: started,
  });
  return exitCode;
}
