// Redaction and bounds for every string that leaves the machine in a receipt, packet, or check summary.
// Kept separate from packet.ts so receipt.ts can use it without an import cycle.

export const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM / OpenSSH private keys, including a block cut off before its END line.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  // Credentials in any URL's userinfo (postgres://u:pw@, redis://:pw@, https://u:pw@), before the email pattern sees them.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@"'<>]*:[^\s\/@"'<>]*@/gi, '$1[REDACTED]@'],
  // Webhook URLs whose path is the secret.
  [/\bhttps?:\/\/(?:hooks\.slack\.com\/services|(?:discord|discordapp)\.com\/api\/webhooks)\/[^\s"'<>)\]]+/gi, '[REDACTED WEBHOOK]'],
  [/\b(set-cookie|cookie)(\s*:\s*)[^\r\n]+/gi, '$1$2[REDACTED]'],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9\-._~+\/]{8,}=*/gi, '$1 [REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]'],
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd|auth|session|signature|credential)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*["']?)(?!(?:bearer|basic|token)\s|\[REDACTED)[^\s"'&,;)}\]]+/gi, '$1$2[REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
];
// Control characters (newlines included) would let an untrusted string start a new log line, and with it a GitHub
// Actions workflow command such as ::add-mask:: or ::warning::. Every bounded string is one line.
const CONTROL = /[\u0000-\u001f\u007f]+/g;
// The one exception: a failure message keeps its newlines (an expected/received diff), because it is only ever
// serialized as JSON, never printed to a log.
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]+/g;
const URL_RE = /\b(https?|wss?):\/\/[^\s"'<>)\]]+/gi;

// Drop the query string and fragment of a URL.
export function stripUrl(u: string): string {
  return u.replace(/[?#].*$/, '');
}

// Strip ANSI, URL queries and fragments, and anything shaped like a secret or an email.
export function redact(text: string): string {
  let out = text.replace(ANSI, '');
  // Private keys span lines, so they go before URL stripping and the line-bounded patterns.
  out = out.replace(SECRET_PATTERNS[0][0], SECRET_PATTERNS[0][1]).replace(URL_RE, (u) => stripUrl(u));
  for (const [re, rep] of SECRET_PATTERNS.slice(1)) out = out.replace(re, rep);
  return out;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars cut]` : text;
}

// Redact, then clip: the bounded form of an untrusted string. A huge input is cut to a little over `max` before the
// patterns run, so their cost stays bounded; everything past `max` is dropped either way.
export function clean(text: unknown, max: number, keepNewlines = false): string {
  const s = String(text ?? '');
  const line = (t: string) => t.replace(keepNewlines ? CONTROL_EXCEPT_NEWLINE : CONTROL, ' ');
  if (s.length <= max + 256) return clip(line(redact(s)), max);
  return `${line(redact(s.slice(0, max + 256))).slice(0, max)}… [${s.length - max} chars cut]`;
}
