// Redaction and bounds for every string that leaves the machine in a receipt, packet, or check summary.
// Kept separate from packet.ts so receipt.ts can use it without an import cycle.

export const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
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

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars cut]` : text;
}

// Redact, then clip: the bounded form of an untrusted string. A huge input is cut to a little over `max` before the
// patterns run, so their cost stays bounded; everything past `max` is dropped either way.
export function clean(text: unknown, max: number): string {
  const s = String(text ?? '');
  if (s.length <= max + 256) return clip(redact(s), max);
  return `${redact(s.slice(0, max + 256)).slice(0, max)}… [${s.length - max} chars cut]`;
}
