// attested MCP server: newline-delimited JSON-RPC 2.0 over stdio, no SDK and no runtime dependencies beyond the attested CLI.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  attestedCommand, PACKET_MAX_BYTES, PREDICATE_TYPE, ProjectFileError, readProjectFile, readProjectJson, RECEIPT_MAX_BYTES,
  validatePacket, verdictFromAttestations, VERSION,
} from './lib.js';

const CTRF_MAX_BYTES = 32 * 1024 * 1024;
const RECEIPT = 'attested/receipt.json';
const PACKET = 'attested/packet.json';
const CTRF = 'attested/ctrf.json';

type Json = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const cwdProp = { type: 'string', description: 'Project directory to run in (default: the server working directory).' };
const TOOLS = [
  {
    name: 'attested_run',
    description: 'Use instead of screenshots to show that a change works. Run the test command through `attested run` and write a test receipt (attested/receipt.json). Returns the receipt summary and, when tests fail, the failure packet: failing tests with messages and stack, console errors, failed requests, evidence paths, and the rerun command. Run this before opening a PR; fix and rerun until result is PASSED.',
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
    description: 'Return the signed verdict for the project\'s attested/ctrf.json, built only from the Sigstore attestation that `gh attestation verify` accepts under the same run, ref, and head policy as the required check, plus the local receipt fields labelled unverified. Local runs are never attested; CI runs are.',
    inputSchema: { type: 'object', properties: {
      cwd: cwdProp,
      repo: { type: 'string', description: 'owner/repo (default: from git remote origin).' },
      head_sha: { type: 'string', description: 'Commit the receipt must cover (default: git HEAD).' },
      run_id: { type: 'string', description: 'Workflow run whose attestation is accepted (default: the latest completed run of the signer workflow for head_sha, from the GitHub API).' },
      source_ref: { type: 'string', description: 'Ref that run must have signed on (default: refs/pull/<N>/merge or refs/heads/<branch>, from that run).' },
      signer_workflow: { type: 'string', description: 'owner/repo/.github/workflows/<file>.yml that must have signed it (default: <repo>/.github/workflows/attested.yml).' },
    } },
  },
];

export function receiptSummary(cwd: string): Json | null {
  const r = readProjectJson(cwd, RECEIPT, RECEIPT_MAX_BYTES) as { subject?: Array<{ digest: { sha256: string } }>; predicate?: any } | null;
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
  const [cmd, ...pre] = attestedCommand();
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
  const before = readProjectJson(cwd, RECEIPT, RECEIPT_MAX_BYTES)?.predicate as Json | undefined;
  const { code, log } = await runAttested(cwd, args);
  const summary = receiptSummary(cwd);
  const fresh = summary && summary.createdAt !== before?.createdAt;
  const attestedLines = log.split('\n').filter((l) => l.startsWith('attested:')).slice(-10);
  if (!fresh) {
    // Fail-closed refusals (dirty tree, sha mismatch, target mismatch, no CTRF) write no receipt.
    return text({ ok: false, exitCode: code, error: attestedLines.join('\n') || log.slice(-2000) }, true);
  }
  const out: Json = { exitCode: code, ...summary };
  if (summary.result === 'FAILED') out.packet = readPacket(cwd);
  out.next = summary.result === 'PASSED'
    ? 'Green. Commit, push, and open the PR with the subject sha256 in the body; CI signs the receipt and posts the "attested" check.'
    : 'Red. Read packet.failingTests (message, file, line, stack), packet.console and packet.network, fix the code, then call attested_run again.';
  return text(out);
}

function readPacket(cwd: string): Json | null {
  const packet = readProjectJson(cwd, PACKET, PACKET_MAX_BYTES);
  return packet === null ? null : validatePacket(packet);
}

function attestedPacket(a: Json): ToolResult {
  const cwd = resolve(String(a.cwd ?? process.cwd()));
  const packet = readPacket(cwd);
  if (packet) return text(packet);
  const s = receiptSummary(cwd);
  return text(s ? `No failure packet: the last run was ${s.result}.` : 'No receipt yet: call attested_run first.');
}

function originRepo(cwd: string): string | null {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' });
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(r.stdout ?? '');
  return m ? m[1] : null;
}

function gh(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || `gh exited ${r.status}` };
}

// The run and ref to pin the attestation to, from the GitHub API (never from files in the project): the given run, or
// the latest completed run of the signer workflow for the head. pull_request runs sign on refs/pull/<N>/merge, push
// runs on refs/heads/<branch>; other events are not accepted.
function pinFromApi(cwd: string, repo: string, workflowFile: string, head: string, runId: string | null): { runId: string; sourceRef: string } | string {
  const path = runId ? `repos/${repo}/actions/runs/${runId}` : `repos/${repo}/actions/workflows/${workflowFile}/runs?head_sha=${head}&status=completed&per_page=1`;
  const r = gh(['api', path], cwd);
  if (!r.ok) return `could not read the run from the GitHub API (${r.err})`;
  let run: { id?: unknown; event?: unknown; head_branch?: unknown; pull_requests?: Array<{ number?: unknown }> } | undefined;
  try { const body = JSON.parse(r.out); run = runId ? body : body.workflow_runs?.[0]; } catch { return 'unreadable run from the GitHub API'; }
  if (!run || typeof run.id !== 'number') return `no completed ${workflowFile} run for ${head}`;
  const pr = run.pull_requests?.[0]?.number;
  if (run.event === 'pull_request' && typeof pr === 'number') return { runId: String(run.id), sourceRef: `refs/pull/${pr}/merge` };
  if (run.event === 'push' && typeof run.head_branch === 'string' && run.head_branch) return { runId: String(run.id), sourceRef: `refs/heads/${run.head_branch}` };
  return `run ${run.id} (${String(run.event)}) has no pull request or push ref to pin to; pass run_id and source_ref`;
}

function verifiedVerdict(cwd: string, a: Json): Json {
  if (spawnSync('gh', ['--version'], { encoding: 'utf8' }).status !== 0) return { checked: false, ok: false, reason: 'gh not available' };
  const repo = typeof a.repo === 'string' && a.repo ? a.repo : originRepo(cwd);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { checked: false, ok: false, reason: 'no GitHub repo (pass repo or set git remote origin)' };
  const signer = typeof a.signer_workflow === 'string' && a.signer_workflow ? a.signer_workflow : `${repo}/.github/workflows/attested.yml`;
  const headArg = typeof a.head_sha === 'string' && a.head_sha ? a.head_sha : spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout?.trim();
  const head = headArg ?? '';
  const base = { repo, signerWorkflow: signer, head };
  if (!/^[0-9a-f]{40}$/.test(head)) return { checked: false, ok: false, ...base, reason: 'no head commit (pass head_sha or run in a git checkout)' };
  const ctrf = readProjectFile(cwd, CTRF, CTRF_MAX_BYTES);
  if (ctrf === null) return { checked: false, ok: false, ...base, reason: `${CTRF} not found` };
  const subjectSha256 = createHash('sha256').update(ctrf).digest('hex');
  const runIdArg = typeof a.run_id === 'string' && /^[0-9]+$/.test(a.run_id) ? a.run_id : null;
  let pin: { runId: string; sourceRef: string };
  if (runIdArg && typeof a.source_ref === 'string' && a.source_ref) pin = { runId: runIdArg, sourceRef: a.source_ref };
  else {
    const p = pinFromApi(cwd, repo, basename(signer), head, runIdArg);
    if (typeof p === 'string') return { checked: false, ok: false, ...base, subjectSha256, reason: p };
    pin = typeof a.source_ref === 'string' && a.source_ref ? { ...p, sourceRef: a.source_ref } : p;
  }
  const r = gh(['attestation', 'verify', join(cwd, CTRF), '--repo', repo, '--predicate-type', PREDICATE_TYPE, '--signer-workflow', signer, '--format', 'json'], cwd);
  if (!r.ok) return { checked: true, ok: false, ...base, ...pin, subjectSha256, reason: r.err };
  let out: unknown;
  try { out = JSON.parse(r.out); } catch { return { checked: true, ok: false, ...base, ...pin, subjectSha256, reason: 'unreadable gh attestation verify output' }; }
  return { checked: true, ...base, ...pin, subjectSha256, ...verdictFromAttestations(out, { ...pin, head }) };
}

function attestedStatus(a: Json): ToolResult {
  const cwd = resolve(String(a.cwd ?? process.cwd()));
  const summary = receiptSummary(cwd);
  if (!summary) return text('No receipt yet: call attested_run first.');
  return text({
    verified: verifiedVerdict(cwd, a),
    localReceipt: { unverified: true, note: `Read from ${RECEIPT} in the project. Not signed; any process that can write the project can change it. Only "verified" is a signed verdict.`, ...summary },
  });
}

// Project files are read through readProjectFile: a symlink, a path outside the project, an oversized file, or a
// malformed packet raises ProjectFileError, which is returned as a tool error.
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
    else if (method === 'tools/call') {
      try {
        result = await callTool(String(params.name), (params.arguments ?? {}) as Json);
      } catch (err) {
        if (!(err instanceof ProjectFileError)) throw err;
        result = text(err.message, true);
      }
    }
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
