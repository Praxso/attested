import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, extname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export class AttestedError extends Error {}

// Largest evidence file (trace, video, screenshot, report) that is hashed into a receipt.
export const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;

// Hashes in chunks, so a large evidence file is never held in memory; refuses files over `max` bytes.
export function sha256File(path: string, max = MAX_EVIDENCE_BYTES): { sha256: string; bytes: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > max) throw new AttestedError(`attested: ${path} is ${size} bytes, over the ${max}-byte limit for evidence files`);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      bytes += n;
      if (bytes > max) throw new AttestedError(`attested: ${path} grew past the ${max}-byte limit for evidence files while hashing`);
      hash.update(chunk.subarray(0, n));
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    closeSync(fd);
  }
}

// `path` (a file or directory under `root`) must not be a symlink and must resolve inside `root`, including through
// symlinked parent directories. Returns false when it does not exist; throws when it escapes.
export function checkInside(root: string, path: string, what: string): boolean {
  let st;
  try { st = lstatSync(path); } catch { return false; }
  if (st.isSymbolicLink()) throw new AttestedError(`attested: ${what} ${path} is a symlink; refusing to read it`);
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new AttestedError(`attested: ${what} ${path} resolves outside ${root}; refusing to read it`);
  return true;
}

export function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    // lstat, not stat: a symlink in a results directory must not pull in files from outside it.
    const st = lstatSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

export type ArtifactKind = 'trace' | 'video' | 'screenshot' | 'report' | 'packet';

export function classify(path: string): ArtifactKind {
  const ext = extname(path).toLowerCase();
  if (ext === '.zip') return 'trace';
  if (ext === '.webm' || ext === '.mp4') return 'video';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return 'screenshot';
  return 'report';
}

export function relPath(root: string, p: string): string {
  return relative(root, p).split('\\').join('/');
}

export function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function gitHead(cwd: string): string | null {
  return git(['rev-parse', 'HEAD'], cwd);
}

export function gitDirty(cwd: string): boolean {
  const out = git(['status', '--porcelain', '--untracked-files=normal'], cwd);
  return out === null ? false : out.length > 0;
}

export function gitRef(cwd: string): string | null {
  if (process.env.GITHUB_REF) return process.env.GITHUB_REF;
  const ref = git(['symbolic-ref', '-q', 'HEAD'], cwd);
  return ref || null;
}

export function inActions(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

export function runUrl(): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  const attempt = GITHUB_RUN_ATTEMPT ? `/attempts/${GITHUB_RUN_ATTEMPT}` : '';
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`;
}

export function warn(msg: string): void {
  process.stderr.write(`attested: warning: ${msg}\n`);
}

export function info(msg: string): void {
  process.stderr.write(`attested: ${msg}\n`);
}

export type GithubEvent = {
  pull_request?: { number?: number; head?: { sha?: string; repo?: { full_name?: string } | null }; base?: { repo?: { full_name?: string } } };
};

// The webhook payload of the current workflow run, or null outside Actions.
export function readEvent(): GithubEvent | null {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GithubEvent;
  } catch {
    return null;
  }
}

// `owner/repo/.github/workflows/x.yml` from GITHUB_WORKFLOW_REF, the form `gh attestation verify --signer-workflow` takes.
export function signerWorkflow(): string | null {
  const ref = process.env.GITHUB_WORKFLOW_REF;
  return ref ? ref.split('@')[0] : null;
}
