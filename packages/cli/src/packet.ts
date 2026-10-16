import { existsSync, readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { isAbsolute, relative, resolve } from 'node:path';
import { TOOL_NAME } from './constants.js';
import type { Artifact, Ctrf } from './receipt.js';
import { testNameOf } from './receipt.js';
import { ANSI, clean, clip, stripUrl } from './redact.js';
import { relPath, warn } from './util.js';

export { redact, stripUrl } from './redact.js';

// The failure packet: deterministic, model-free, at most 12 KB. Written on red so an agent can fix without opening traces.
export const PACKET_MAX_BYTES = 12 * 1024;
const MAX_FRAMES = 20;
const MAX_MESSAGE = 1500;
// Bounds on every other string in the packet, so that after capPacket drops every list entry the rest always fits.
const MAX_NAME = 300;
const MAX_PATH = 300;
const MAX_FRAME = 300;
const MAX_METHOD = 16;
const MAX_RERUN = 500;
const MAX_EVIDENCE = 10;
// Trace zips come from an untrusted results directory: bound what is read and what is inflated.
export const MAX_TRACE_ZIP_BYTES = 256 * 1024 * 1024;
export const MAX_TRACE_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_TRACE_TOTAL_BYTES = 128 * 1024 * 1024;

type CtrfTest = NonNullable<Ctrf['results']['tests']>[number] & {
  message?: string; trace?: string; line?: number; attachments?: Array<{ name?: string; contentType?: string; path?: string }>;
};

export type PacketTest = { name: string; file: string | null; line: number | null; message: string; stack: string[]; count: number; evidence: Array<{ kind: string; path: string; sha256: string }> };
export type ConsoleEntry = { level: 'error' | 'warning'; message: string; count: number; lastSeen: number };
export type NetworkEntry = { method: string; path: string; status: number; count: number; lastSeen: number };
export type Packet = {
  tool: string;
  result: 'FAILED';
  failingTests: PacketTest[];
  console: Array<Omit<ConsoleEntry, 'lastSeen'>>;
  network: Array<Omit<NetworkEntry, 'lastSeen'>>;
  rerun: string;
  truncated: false | { tests: number; console: number; network: number; frames: boolean };
};

// --- minimal zip reader (Playwright trace.zip), stored and deflate entries only --------------

// `budget.left` is the number of inflated bytes still allowed across all traces; entries past it are skipped with a warning.
export function readZip(path: string, want: (name: string) => boolean, budget = { left: MAX_TRACE_TOTAL_BYTES }): Map<string, string> {
  const out = new Map<string, string>();
  let buf: Buffer;
  try {
    if (statSync(path).size > MAX_TRACE_ZIP_BYTES) { warn(`trace ${path} is larger than ${MAX_TRACE_ZIP_BYTES} bytes; skipped`); return out; }
    buf = readFileSync(path);
  } catch { return out; }
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const limit = Math.min(MAX_TRACE_ENTRY_BYTES, budget.left);
    try {
      let text: Buffer;
      if (method === 0) text = data;
      else if (method === 8) text = inflateRawSync(data, { maxOutputLength: limit + 1 });
      else continue;
      if (text.length > limit) throw new RangeError('limit');
      budget.left -= text.length;
      out.set(name, text.toString('utf8'));
    } catch (err) {
      // Over the limit (zlib reports ERR_BUFFER_TOO_LARGE) or unreadable: skip the entry.
      if (err instanceof RangeError || (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        warn(`trace ${path}: entry ${clean(name, MAX_PATH)} inflates past ${limit} bytes (per entry ${MAX_TRACE_ENTRY_BYTES}, all traces ${MAX_TRACE_TOTAL_BYTES}); skipped`);
      }
    }
  }
  return out;
}

function jsonl(text: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// Console errors/warnings and failed requests from Playwright trace zips. Order of `seq` is trace order across traces.
export function readTraces(paths: string[]): { console: ConsoleEntry[]; network: NetworkEntry[] } {
  const cons = new Map<string, ConsoleEntry>();
  const net = new Map<string, NetworkEntry>();
  let seq = 0;
  const budget = { left: MAX_TRACE_TOTAL_BYTES };
  for (const path of paths) {
    let files: Map<string, string>;
    // Trace zips can come from an untrusted results artifact: a malformed one is skipped, never fatal.
    try { files = readZip(path, (n) => n.endsWith('.trace') || n.endsWith('.network'), budget); } catch { continue; }
    for (const name of [...files.keys()].sort()) {
      for (const ev of jsonl(files.get(name)!)) {
        seq++;
        if (ev.type === 'console' && (ev.messageType === 'error' || ev.messageType === 'warning')) {
          const level = ev.messageType as 'error' | 'warning';
          const message = clean(ev.text ?? '', 300);
          const key = `${level}\u0000${message}`;
          const e = cons.get(key) ?? { level, message, count: 0, lastSeen: 0 };
          e.count++; e.lastSeen = seq; cons.set(key, e);
        } else if (ev.type === 'event' && ev.method === 'pageError') {
          const err = ev.params?.error?.error ?? ev.params?.error ?? {};
          const message = clean(`${err.name ?? 'Error'}: ${err.message ?? ''}`, 300);
          const key = `error\u0000${message}`;
          const e = cons.get(key) ?? { level: 'error' as const, message, count: 0, lastSeen: 0 };
          e.count++; e.lastSeen = seq; cons.set(key, e);
        } else if (ev.type === 'resource-snapshot' && ev.snapshot?.request) {
          const raw = Number(ev.snapshot.response?.status ?? -1);
          const status = Number.isInteger(raw) && raw >= -1 && raw < 1000 ? raw : -1;
          const failed = status >= 400 || status <= 0 || Boolean(ev.snapshot.response?._failureText);
          if (!failed) continue;
          let path = String(ev.snapshot.request.url ?? '');
          try { path = new URL(path).pathname; } catch { path = stripUrl(path); }
          const method = clean(ev.snapshot.request.method ?? 'GET', MAX_METHOD);
          path = clean(path, MAX_PATH);
          const key = `${method} ${path} ${status}`;
          const e = net.get(key) ?? { method, path, status, count: 0, lastSeen: 0 };
          e.count++; e.lastSeen = seq; net.set(key, e);
        }
      }
    }
  }
  return { console: [...cons.values()], network: [...net.values()] };
}

// --- packet ------------------------------------------------------------------------------------

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function rerunCommand(argv: string[]): string {
  return clean(['attested', ...argv].map(shellQuote).join(' '), MAX_RERUN);
}

function lineOf(t: CtrfTest, file: string | null, stack: string[]): number | null {
  if (typeof t.line === 'number') return Number.isInteger(t.line) && t.line >= 0 && t.line < 1e9 ? t.line : null;
  if (!file) return null;
  for (const f of stack) {
    const m = f.includes(file) ? /:(\d{1,9}):\d+\)?$/.exec(f) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

// Attachments with a string path; anything else in an untrusted CTRF report is ignored.
function attachmentsOf(t: CtrfTest): Array<{ path: string }> {
  return Array.isArray(t.attachments) ? t.attachments.filter((a): a is { path: string } => typeof a?.path === 'string' && a.path !== '') : [];
}

export function buildPacket(ctrf: Ctrf, artifacts: Artifact[], cwd: string, rerun: string): Packet {
  const tests = ((ctrf.results.tests ?? []) as CtrfTest[]).filter((t) => t.status === 'failed');
  const byPath = new Map(artifacts.map((a) => [a.path, a]));
  const rel = (p: string) => relPath(cwd, isAbsolute(p) ? p : resolve(cwd, p));
  // Attachment paths are absolute on the machine that ran the tests. When the packet is built elsewhere (the sign job,
  // from a downloaded results directory), match them to artifacts by suffix and infer that machine's project root.
  const lookup = (p: string): Artifact | undefined => byPath.get(rel(p)) ?? artifacts.find((a) => p.split('\\').join('/').endsWith('/' + a.path));
  let srcRoot = cwd;
  find: for (const t of tests) {
    for (const a of attachmentsOf(t)) {
      if (!byPath.has(rel(a.path))) { const art = lookup(a.path); if (art) srcRoot = a.path.slice(0, a.path.length - art.path.length - 1); }
      break find;
    }
  }
  const traces: string[] = [];
  const groups = new Map<string, PacketTest>();
  for (const t of tests) {
    const raw = String(t.trace ?? t.message ?? '').replace(ANSI, '');
    const stack = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, MAX_FRAMES)
      .map((f) => clean(f.split(srcRoot + '/').join(''), MAX_FRAME));
    const message = clean(t.message ?? '', MAX_MESSAGE);
    const file = typeof t.filePath === 'string' && t.filePath ? clean(relative(srcRoot, t.filePath).split('\\').join('/'), MAX_PATH) : null;
    const evidence: PacketTest['evidence'] = [];
    for (const a of attachmentsOf(t)) {
      const art = lookup(a.path);
      if (!art || !['trace', 'video', 'screenshot'].includes(art.kind)) continue;
      if (evidence.length < MAX_EVIDENCE) evidence.push({ kind: art.kind, path: clean(art.path, MAX_PATH), sha256: art.sha256 });
      if (art.kind === 'trace' && existsSync(resolve(cwd, art.path))) traces.push(resolve(cwd, art.path));
    }
    const name = clean(testNameOf(t), MAX_NAME);
    // Identical failures (same file, line, and message) collapse into one entry with a count.
    const key = `${file}\u0000${lineOf(t, file, stack)}\u0000${message}`;
    const g = groups.get(key);
    if (g) { g.count++; continue; }
    groups.set(key, { name, file, line: lineOf(t, file, stack), message, stack, count: 1, evidence });
  }
  const { console: cons, network } = readTraces([...new Set(traces)]);
  const byRecent = <T extends { lastSeen: number }>(xs: T[]) => xs.sort((a, b) => b.lastSeen - a.lastSeen).map(({ lastSeen, ...rest }) => rest);
  const packet: Packet = {
    tool: TOOL_NAME,
    result: 'FAILED',
    failingTests: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    console: byRecent(cons),
    network: byRecent(network),
    rerun: clean(rerun, MAX_RERUN),
    truncated: false,
  };
  return capPacket(packet);
}

export function serializePacket(p: Packet): string {
  return JSON.stringify(p, null, 2) + '\n';
}

// Enforce the 12 KB cap: cut stacks to 5 frames, then drop from the end of the longest list
// (tests are alphabetical, console and network most recent first), recording what was cut.
export function capPacket(p: Packet): Packet {
  if (Buffer.byteLength(serializePacket(p)) <= PACKET_MAX_BYTES) return p;
  const cut = { tests: 0, console: 0, network: 0, frames: false };
  p.truncated = cut;
  for (const t of p.failingTests) if (t.stack.length > 5) { t.stack = t.stack.slice(0, 5); cut.frames = true; }
  while (Buffer.byteLength(serializePacket(p)) > PACKET_MAX_BYTES) {
    const lists = [['tests', p.failingTests], ['console', p.console], ['network', p.network]] as const;
    const [name, list] = [...lists].sort((a, b) => b[1].length - a[1].length)[0];
    if (list.length === 0) break;
    (list as unknown[]).pop();
    cut[name]++;
  }
  // Every remaining field is bounded above, so this only trims the rerun command if a caller passed an unbounded one.
  if (Buffer.byteLength(serializePacket(p)) > PACKET_MAX_BYTES) p.rerun = clip(p.rerun, 200);
  return p;
}
