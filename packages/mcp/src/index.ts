// attested MCP server: newline-delimited JSON-RPC 2.0 over stdio, no SDK and no runtime dependencies beyond the attested CLI.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.1.0';
const PREDICATE_TYPE = 'https://praxso.ai/attested/v0.1';
const RECEIPT = 'attested/receipt.json';
const PACKET = 'attested/packet.json';
const CTRF = 'attested/ctrf.json';

type Json = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const cwdProp = { type: 'string', description: 'Project directory to run in (default: the server working directory).' };
const TOOLS = [
  {
    name: 'attested_run',
    description: 'Run the test command through `attested run` and write a test receipt (attested/receipt.json). Returns the receipt summary and, when tests fail, the failure packet: failing tests with messages and stack, console errors, failed requests, evidence paths, and the rerun command. Run this before opening a PR; fix and rerun until result is PASSED.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Test command, run with sh -c, e.g. "pnpm exec playwright test". It must write a CTRF report to attested/ctrf.json.' },
        target_url: { type: 'string', description: 'Optional deployment URL; its /healthz must report the expected sha or the run stops before tests.' },
        expected_sha: { type: 'string', description: 'Optional commit sha HEAD must equal.' },
        allow_dirty: { type: 'boolean', description: 'Allow uncommitted changes (default true for local iteration; the receipt records dirty: true).' },
        cwd: cwdProp,
      },
      required: ['command'],
    },
  },
  { name: 'attested_packet', description: 'Return the failure packet from the last red `attested run` (attested/packet.json).', inputSchema: { type: 'object', properties: { cwd: cwdProp } } },
  {
    name: 'attested_status',
    description: 'Return the last receipt summary and whether a Sigstore attestation exists for its subject digest (checked with `gh attestation verify` when gh is available). Local runs are never attested; CI runs are.',
    inputSchema: { type: 'object', properties: { cwd: cwdProp, repo: { type: 'string', description: 'owner/repo (default: from git remote origin).' } } },
  },
];

// Prefer the project's own attested (its pinned version), then the one this package depends on.
export function attestedCommand(cwd: string): string[] {
  if (process.env.ATTESTED_BIN) return [process.env.ATTESTED_BIN];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', 'attested');
    if (existsSync(bin)) return [bin];
    if (dirname(dir) === dir) break;
  }
  try {
    return [process.execPath, createRequire(import.meta.url).resolve('@praxso/attested/bin/attested.js')];
  } catch {
    return ['npx', '-y', '@praxso/attested'];
  }
}

function readJson(path: string): Json | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Json; } catch { return null; }
}

export function receiptSummary(cwd: string): Json | null {
  const r = readJson(join(cwd, RECEIPT)) as { subject?: Array<{ digest: { sha256: string } }>; predicate?: any } | null;
  if (!r?.predicate) return null;
  const p = r.predicate;
  const packet = (p.artifacts ?? []).find((a: { kind: string }) => a.kind === 'packet');
  return {
    result: p.testResult?.result,
    passed: p.testResult?.passedTests?.length ?? 0,
    failed: p.testResult?.failedTests?.length ?? 0,
    other: p.testResult?.warnedTests?.length ?? 0,
    failedTests: p.testResult?.failedTests ?? [],
    subject: { path: CTRF, sha256: r.subject?.[0]?.digest.sha256 },
    source: p.source,
    target: p.target,
    receipt: RECEIPT,
    packetArtifact: packet ? { path: packet.path, sha256: packet.sha256 } : null,
    createdAt: p.createdAt,
  };
}

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) };
}

function runAttested(cwd: string, args: string[]): Promise<{ code: number; log: string }> {
  const [cmd, ...pre] = attestedCommand(cwd);
  return new Promise((ok) => {
    // stdout of the test command goes to our stderr, never to the MCP channel on stdout.
    const child = spawn(cmd, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let log = '';
    const keep = (d: Buffer) => { log += d.toString(); if (log.length > 200_000) log = log.slice(-100_000); process.stderr.write(d); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => ok({ code: 127, log: `${log}\n${err.message}` }));
    child.on('close', (code) => ok({ code: code ?? 1, log }));
  });
}

async function attestedRun(a: Json): Promise<ToolResult> {
  const cwd = resolve(String(a.cwd ?? process.cwd()));
  if (typeof a.command !== 'string' || !a.command.trim()) return text('command is required', true);
  const args = ['run'];
  if (a.allow_dirty !== false) args.push('--allow-dirty');
  if (typeof a.expected_sha === 'string' && a.expected_sha) args.push('--expect-sha', a.expected_sha);
  if (typeof a.target_url === 'string' && a.target_url) args.push('--target-url', a.target_url);
  args.push('--', 'sh', '-c', a.command);
  const before = readJson(join(cwd, RECEIPT))?.predicate as Json | undefined;
  const { code, log } = await runAttested(cwd, args);
  const summary = receiptSummary(cwd);
  const fresh = summary && summary.createdAt !== before?.createdAt;
  const attestedLines = log.split('\n').filter((l) => l.startsWith('attested:')).slice(-10);
  if (!fresh) {
    // Fail-closed refusals (dirty tree, sha mismatch, target mismatch, no CTRF) write no receipt.
    return text({ ok: false, exitCode: code, error: attestedLines.join('\n') || log.slice(-2000) }, true);
  }
  const out: Json = { exitCode: code, ...summary };
  if (summary.result === 'FAILED') out.packet = readJson(join(cwd, PACKET));
  out.next = summary.result === 'PASSED'
    ? 'Green. Commit, push, and open the PR with the subject sha256 in the body; CI signs the receipt and posts the "attested" check.'
    : 'Red. Read packet.failingTests (message, file, line, stack), packet.console and packet.network, fix the code, then call attested_run again.';
  return text(out);
}

function attestedPacket(a: Json): ToolResult {
  const cwd = resolve(String(a.cwd ?? process.cwd()));
  const packet = readJson(join(cwd, PACKET));
  if (packet) return text(packet);
  const s = receiptSummary(cwd);
  return text(s ? `No failure packet: the last run was ${s.result}.` : 'No receipt yet: call attested_run first.');
}

function originRepo(cwd: string): string | null {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' });
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(r.stdout ?? '');
  return m ? m[1] : null;
}

function attestedStatus(a: Json): ToolResult {
  const cwd = resolve(String(a.cwd ?? process.cwd()));
  const summary = receiptSummary(cwd);
  if (!summary) return text('No receipt yet: call attested_run first.');
  const repo = typeof a.repo === 'string' && a.repo ? a.repo : originRepo(cwd);
  let attestation: Json;
  if (spawnSync('gh', ['--version'], { encoding: 'utf8' }).status !== 0) {
    attestation = { checked: false, reason: 'gh not available' };
  } else if (!repo) {
    attestation = { checked: false, reason: 'no GitHub repo (pass repo or set git remote origin)' };
  } else {
    const r = spawnSync('gh', ['attestation', 'verify', join(cwd, CTRF), '--repo', repo, '--predicate-type', PREDICATE_TYPE, '--format', 'json'], { cwd, encoding: 'utf8' });
    attestation = r.status === 0
      ? { checked: true, exists: true, repo }
      : { checked: true, exists: false, repo, reason: (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || `gh exited ${r.status}` };
  }
  return text({ ...summary, attestation });
}

async function callTool(name: string, args: Json): Promise<ToolResult> {
  if (name === 'attested_run') return attestedRun(args);
  if (name === 'attested_packet') return attestedPacket(args);
  if (name === 'attested_status') return attestedStatus(args);
  throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
}

function send(msg: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function handle(msg: { id?: string | number; method?: string; params?: Json }): Promise<void> {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // notifications need no reply
  try {
    let result: unknown;
    if (method === 'initialize') {
      result = {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'attested', version: VERSION },
        instructions: 'Call attested_run before opening a PR. On red, read the packet, fix, and rerun until PASSED.',
      };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') result = await callTool(String(params.name), (params.arguments ?? {}) as Json);
    else return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    send({ id, result });
  } catch (err) {
    send({ id, error: { code: (err as { code?: number }).code ?? -32603, message: (err as Error).message } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'parse error' } }); }
  void handle(msg);
});
