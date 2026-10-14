import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { isAbsolute, relative, resolve } from 'node:path';
import { TOOL_NAME } from './constants.js';
import type { Artifact, Ctrf } from './receipt.js';
import { testNameOf } from './receipt.js';
import { relPath } from './util.js';

// The failure packet: deterministic, model-free, at most 12 KB. Written on red so an agent can fix without opening traces.
export const PACKET_MAX_BYTES = 12 * 1024;
const MAX_FRAMES = 20;
const MAX_MESSAGE = 1500;

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

// --- redaction ---------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer|basic|token)\s+[A-Za-z0-9\-._~+\/]{8,}=*/gi, '$1 [REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]'],
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|auth|session|signature|credential)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*["']?)(?!(?:bearer|basic|token)\s)[^\s"'&,;)}\]]+/gi, '$1$2[REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
];
const URL_RE = /\b(https?|wss?):\/\/[^\s"'<>)\]]+/gi;

// Drop the query string and fragment of a URL.
export function stripUrl(u: string): string {
  return u.replace(/[?#].*$/, '');
}

// Strip ANSI, URL queries and fragments, and anything shaped like a secret or an email.
export function redact(text: string): string {
  let out = text.replace(ANSI, '').replace(URL_RE, (u) => stripUrl(u));
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars cut]` : text;
}

// --- minimal zip reader (Playwright trace.zip), stored and deflate entries only --------------

export function readZip(path: string, want: (name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return out; }
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
    try {
      if (method === 0) out.set(name, data.toString('utf8'));
      else if (method === 8) out.set(name, inflateRawSync(data).toString('utf8'));
    } catch { /* unreadable entry: skip */ }
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
  for (const path of paths) {
    const files = readZip(path, (n) => n.endsWith('.trace') || n.endsWith('.network'));
    for (const name of [...files.keys()].sort()) {
      for (const ev of jsonl(files.get(name)!)) {
        seq++;
        if (ev.type === 'console' && (ev.messageType === 'error' || ev.messageType === 'warning')) {
          const level = ev.messageType as 'error' | 'warning';
          const message = clip(redact(String(ev.text ?? '')), 300);
          const key = `${level}\u0000${message}`;
          const e = cons.get(key) ?? { level, message, count: 0, lastSeen: 0 };
          e.count++; e.lastSeen = seq; cons.set(key, e);
        } else if (ev.type === 'event' && ev.method === 'pageError') {
          const err = ev.params?.error?.error ?? ev.params?.error ?? {};
          const message = clip(redact(`${err.name ?? 'Error'}: ${err.message ?? ''}`), 300);
          const key = `error\u0000${message}`;
          const e = cons.get(key) ?? { level: 'error' as const, message, count: 0, lastSeen: 0 };
          e.count++; e.lastSeen = seq; cons.set(key, e);
        } else if (ev.type === 'resource-snapshot' && ev.snapshot?.request) {
          const status = Number(ev.snapshot.response?.status ?? -1);
          const failed = status >= 400 || status <= 0 || Boolean(ev.snapshot.response?._failureText);
          if (!failed) continue;
          let path = String(ev.snapshot.request.url ?? '');
          try { path = new URL(path).pathname; } catch { path = stripUrl(path); }
          const method = String(ev.snapshot.request.method ?? 'GET');
          path = redact(path);
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
  return ['attested', ...argv].map(shellQuote).join(' ');
}

function lineOf(t: CtrfTest, file: string | null, stack: string[]): number | null {
  if (typeof t.line === 'number') return t.line;
  if (!file) return null;
  for (const f of stack) {
    const m = f.includes(file) ? /:(\d+):\d+\)?$/.exec(f) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

export function buildPacket(ctrf: Ctrf, artifacts: Artifact[], cwd: string, rerun: string): Packet {
  const tests = ((ctrf.results.tests ?? []) as CtrfTest[]).filter((t) => t.status === 'failed');
  const byPath = new Map(artifacts.map((a) => [a.path, a]));
  const rel = (p: string) => relPath(cwd, isAbsolute(p) ? p : resolve(cwd, p));
  const traces: string[] = [];
  const groups = new Map<string, PacketTest>();
  for (const t of tests) {
    const raw = (t.trace ?? t.message ?? '').replace(ANSI, '');
    const stack = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, MAX_FRAMES)
      .map((f) => redact(f.split(cwd + '/').join('')));
    const message = clip(redact((t.message ?? '').replace(ANSI, '')), MAX_MESSAGE);
    const file = t.filePath ? relative(cwd, t.filePath).split('\\').join('/') : null;
    const evidence: PacketTest['evidence'] = [];
    for (const a of t.attachments ?? []) {
      if (!a.path) continue;
      const art = byPath.get(rel(a.path));
      if (!art || !['trace', 'video', 'screenshot'].includes(art.kind)) continue;
      evidence.push({ kind: art.kind, path: art.path, sha256: art.sha256 });
      if (art.kind === 'trace' && existsSync(resolve(cwd, art.path))) traces.push(resolve(cwd, art.path));
    }
    const name = testNameOf(t);
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
    rerun,
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
  return p;
}
