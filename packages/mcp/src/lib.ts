// Pure helpers for the MCP server, kept apart from index.ts (which starts the stdio loop on import) so they can be tested.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;
export const PREDICATE_TYPE = 'https://praxso.ai/attested/v0.1';
export const PACKET_MAX_BYTES = 12 * 1024;
export const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;

// The attested CLI this server runs: the one bundled with this package. A different binary only through the explicit
// ATTESTED_BIN setting in the MCP server's own configuration; never one found in the project (node_modules/.bin there
// is project code). If the bundled CLI cannot be resolved, npx runs exactly this package's version.
export function attestedCommand(env: NodeJS.ProcessEnv = process.env, resolveBundled = () => require.resolve('@praxso/attested/bin/attested.js')): string[] {
  if (env.ATTESTED_BIN) return [env.ATTESTED_BIN];
  try {
    return [process.execPath, resolveBundled()];
  } catch {
    return ['npx', '-y', `@praxso/attested@${VERSION}`];
  }
}

export class ProjectFileError extends Error {}

// Read `rel` under the project `cwd`. Refuses a symlink, a path that resolves outside the project (including through a
// symlinked parent directory), and a file over `max` bytes. Returns null when the file does not exist.
export function readProjectFile(cwd: string, rel: string, max: number): string | null {
  const path = resolve(cwd, rel);
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isSymbolicLink()) throw new ProjectFileError(`${rel} is a symlink; refusing to read it`);
  const inside = relative(realpathSync(cwd), realpathSync(path));
  if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new ProjectFileError(`${rel} resolves outside the project; refusing to read it`);
  if (!st.isFile()) throw new ProjectFileError(`${rel} is not a regular file`);
  if (st.size > max) throw new ProjectFileError(`${rel} is ${st.size} bytes, over the ${max}-byte limit`);
  return readFileSync(path, 'utf8');
}

export function readProjectJson(cwd: string, rel: string, max: number): Json | null {
  const text = readProjectFile(cwd, rel, max);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
  } catch { /* fall through */ }
  throw new ProjectFileError(`${rel} is not a JSON object`);
}

// --- packet shape ------------------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// Validate a failure packet and rebuild it from known fields only. Throws on any field of the wrong shape.
export function validatePacket(p: unknown): Json {
  const bad = (what: string) => { throw new ProjectFileError(`packet.json does not have the failure packet shape (${what})`); };
  if (!isObj(p)) bad('not an object');
  const o = p as Json;
  if (o.tool !== 'attested' || o.result !== 'FAILED') bad('tool or result');
  if (!isArr(o.failingTests) || !isArr(o.console) || !isArr(o.network) || !isStr(o.rerun)) bad('lists or rerun');
  const failingTests = (o.failingTests as unknown[]).map((t) => {
    if (!isObj(t) || !isStr(t.name) || !(t.file === null || isStr(t.file)) || !(t.line === null || isInt(t.line)) || !isStr(t.message)
      || !isArr(t.stack) || !t.stack.every(isStr) || !isInt(t.count) || !isArr(t.evidence)) bad('failingTests entry');
    const x = t as Json;
    const evidence = (x.evidence as unknown[]).map((e) => {
      if (!isObj(e) || !['trace', 'video', 'screenshot'].includes(e.kind as string) || !isStr(e.path) || !isStr(e.sha256) || !/^[0-9a-f]{64}$/.test(e.sha256)) bad('evidence entry');
      const y = e as Json;
      return { kind: y.kind, path: y.path, sha256: y.sha256 };
    });
    return { name: x.name, file: x.file, line: x.line, message: x.message, stack: x.stack, count: x.count, evidence };
  });
  const consoleEntries = (o.console as unknown[]).map((c) => {
    if (!isObj(c) || !['error', 'warning'].includes(c.level as string) || !isStr(c.message) || !isInt(c.count)) bad('console entry');
    const x = c as Json;
    return { level: x.level, message: x.message, count: x.count };
  });
  const network = (o.network as unknown[]).map((n) => {
    if (!isObj(n) || !isStr(n.method) || !isStr(n.path) || !isInt(n.status) || !isInt(n.count)) bad('network entry');
    const x = n as Json;
    return { method: x.method, path: x.path, status: x.status, count: x.count };
  });
  let truncated: unknown = false;
  if (o.truncated !== false) {
    const t = o.truncated;
    if (!isObj(t) || !isInt(t.tests) || !isInt(t.console) || !isInt(t.network) || typeof t.frames !== 'boolean') bad('truncated');
    const x = t as Json;
    truncated = { tests: x.tests, console: x.console, network: x.network, frames: x.frames };
  }
  return { tool: 'attested', result: 'FAILED', failingTests, console: consoleEntries, network, rerun: o.rerun, truncated };
}

// --- verified verdict --------------------------------------------------------------------------

export type Pin = { runId: string; sourceRef: string; head: string };
export type Verdict = { ok: boolean; result: string | null; reason: string; rule?: string; failedTests?: string[] };

// The verdict from `gh attestation verify --format json` output under the same policy as verify/verify.sh: only an
// attestation whose certificate names the pinned run and source ref is accepted, the head must equal source.commit or
// source.headCommit, and the result decides (PASSED passes, WARNED passes with a warning, anything else fails).
export function verdictFromAttestations(out: unknown, pin: Pin): Verdict {
  if (!/^[0-9]+$/.test(pin.runId) || !pin.sourceRef || !/^[0-9a-f]{40}$/.test(pin.head)) return { ok: false, result: null, reason: 'run id, source ref, or head missing' };
  const runRe = new RegExp(`/actions/runs/${pin.runId}(/attempts/[0-9]+)?$`);
  const list = isArr(out) ? out : [];
  let stmt: Json | null = null;
  for (const a of list) {
    const vr = isObj(a) && isObj(a.verificationResult) ? a.verificationResult : null;
    const cert = vr && isObj(vr.signature) && isObj(vr.signature.certificate) ? vr.signature.certificate : null;
    if (cert && cert.sourceRepositoryRef === pin.sourceRef && isStr(cert.runInvocationURI) && runRe.test(cert.runInvocationURI) && isObj(vr!.statement)) {
      stmt = vr!.statement as Json;
      break;
    }
  }
  if (!stmt) return { ok: false, result: null, reason: `no attestation from run ${pin.runId} on ${pin.sourceRef}` };
  if (stmt.predicateType !== PREDICATE_TYPE) return { ok: false, result: null, reason: `predicate type ${String(stmt.predicateType)}, not ${PREDICATE_TYPE}` };
  const pred = isObj(stmt.predicate) ? stmt.predicate : {};
  const source = isObj(pred.source) ? pred.source : {};
  const tr = isObj(pred.testResult) ? pred.testResult : {};
  let rule: string;
  if (source.commit === pin.head) rule = `source.commit == ${pin.head}`;
  else if (isStr(source.headCommit) && source.headCommit === pin.head) rule = `source.headCommit == ${pin.head}`;
  else return { ok: false, result: null, reason: `SHA mismatch: the attested receipt covers ${String(source.commit ?? 'none')} / ${String(source.headCommit ?? 'none')}, not ${pin.head}` };
  const result = isStr(tr.result) ? tr.result : null;
  const failedTests = isArr(tr.failedTests) ? tr.failedTests.filter(isStr) : [];
  if (result === 'PASSED') return { ok: true, result, reason: 'signed receipt passed', rule };
  if (result === 'WARNED') return { ok: true, result, reason: 'signed receipt passed with warnings', rule };
  if (result === 'FAILED') return { ok: false, result, reason: 'signed receipt records failing tests', rule, failedTests };
  return { ok: false, result, reason: result === null ? 'signed receipt records no result' : `unknown result ${result}`, rule };
}
