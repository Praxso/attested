import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, PREDICATE_TYPE, TOOL_NAME } from './constants.js';
import type { Receipt } from './receipt.js';
import { AttestedError, info, readEvent, runUrl, signerWorkflow } from './util.js';

export type CheckOptions = {
  receipt: string;
  packet: string;
  artifactUrl: string | null;
  artifactName: string | null;
  evidenceName: string | null;
  attestationUrl: string | null;
};

export function defaultCheckOptions(): CheckOptions {
  return { receipt: DEFAULTS.receipt, packet: DEFAULTS.packet, artifactUrl: null, artifactName: null, evidenceName: null, attestationUrl: null };
}

type Conclusion = 'success' | 'failure' | 'neutral';

export function conclusionFor(result: string | undefined): Conclusion {
  if (result === 'PASSED') return 'success';
  if (result === 'FAILED') return 'failure';
  return 'neutral';
}

// The sha the check run is attached to: the PR head on pull_request (GITHUB_SHA is the synthetic merge commit there).
export function checkHeadSha(): string | null {
  const ev = readEvent();
  return ev?.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? null;
}

// On a pull_request from a fork, GITHUB_TOKEN is read-only and cannot create check runs.
export function isForkPullRequest(): boolean {
  const ev = readEvent();
  const head = ev?.pull_request?.head?.repo?.full_name;
  const base = ev?.pull_request?.base?.repo?.full_name ?? process.env.GITHUB_REPOSITORY;
  return Boolean(head && base && head !== base);
}

export function buildSummary(receipt: Receipt, packet: string | null, opts: CheckOptions): { title: string; summary: string } {
  const p = receipt.predicate;
  const tr = p.testResult;
  const s = (p.ctrf.summary ?? {}) as Record<string, number | undefined>;
  const repo = process.env.GITHUB_REPOSITORY ?? '<owner>/<repo>';
  const signer = signerWorkflow() ?? `${repo}/.github/workflows/attested.yml`;
  const digest = receipt.subject[0]?.digest.sha256 ?? '';
  const lines: string[] = [];
  const counts = `${s.tests ?? tr.passedTests.length + tr.failedTests.length + tr.warnedTests.length} tests: ${tr.passedTests.length} passed, ${tr.failedTests.length} failed, ${tr.warnedTests.length} other`;
  const title = `${tr.result}: ${counts}`;
  lines.push(`### ${TOOL_NAME}: ${tr.result}`, '', '| | |', '|---|---|');
  lines.push(`| Verdict | **${tr.result}** |`);
  const head = p.source.headCommit;
  lines.push(`| Commit tested | \`${p.source.commit ?? 'unknown'}\`${head && head !== p.source.commit ? ` (PR head \`${head}\`)` : ''} |`);
  lines.push(`| Target build | ${p.target.buildSha ? `\`${p.target.buildSha}\` at ${p.target.url}` : 'none (no --target-url)'} |`);
  lines.push(`| Tests | ${counts} |`);
  lines.push(`| Subject | \`ctrf.json\` sha256 \`${digest}\` |`);
  lines.push(`| Evidence | ${opts.artifactUrl ? `[workflow artifact](${opts.artifactUrl})` : 'workflow artifact'} (traces, videos, screenshots; access follows this repository's visibility; never posted to the PR) |`);
  if (opts.attestationUrl) lines.push(`| Attestation | ${opts.attestationUrl} |`);
  const url = runUrl();
  if (url) lines.push(`| Run | ${url} |`);
  lines.push('', 'Verify this receipt yourself:', '', '```bash');
  const runId = process.env.GITHUB_RUN_ID;
  if (runId && opts.artifactName) lines.push(`gh run download ${runId} --repo ${repo} --name ${opts.artifactName} --dir attested-receipt`);
  lines.push(`gh attestation verify attested-receipt/attested/ctrf.json --repo ${repo} --predicate-type ${PREDICATE_TYPE} --signer-workflow ${signer}`);
  lines.push('```');
  // The evidence travels in its own artifact. Its name defaults to the bundled workflow's (results-<sha> beside
  // attested-<sha>), as the signer workflow above defaults to the bundled attested.yml.
  const evidence = opts.evidenceName ?? (opts.artifactName?.startsWith('attested-') ? `results-${opts.artifactName.slice('attested-'.length)}` : null);
  if (runId && evidence) {
    lines.push('', 'Get the evidence (screenshots, videos, traces) and check that each file is the one this receipt fingerprints:', '', '```bash');
    lines.push(`gh run download ${runId} --repo ${repo} --name ${evidence} --dir attested-evidence`);
    lines.push(`cd attested-evidence && jq -r '.predicate.artifacts[] | "\\(.sha256)  \\(.path)"' ../attested-receipt/attested/receipt.json | shasum -a 256 -c`);
    lines.push('```');
    lines.push('', "Artifacts follow this repository's artifact retention (90 days by default); the receipt's digests and signature outlast them.");
  }
  if (tr.failedTests.length && packet) {
    lines.push('', 'Failure packet (`attested/packet.json`):', '', '```json', packet.trimEnd(), '```');
  } else if (tr.failedTests.length) {
    lines.push('', 'Failed tests:', '', ...tr.failedTests.map((t) => `- ${t}`));
  }
  return { title, summary: lines.join('\n') + '\n' };
}

function toLogAndSummary(summary: string): void {
  process.stdout.write(summary);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, summary);
}

export async function check(opts: CheckOptions): Promise<number> {
  const cwd = process.cwd();
  const receiptPath = resolve(cwd, opts.receipt);
  if (!existsSync(receiptPath)) throw new AttestedError(`attested check: receipt not found at ${opts.receipt}; run \`attested run\` first`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  const packetPath = resolve(cwd, opts.packet);
  const packet = existsSync(packetPath) ? readFileSync(packetPath, 'utf8') : null;
  const conclusion = conclusionFor(receipt.predicate.testResult.result);
  const { title, summary } = buildSummary(receipt, packet, opts);

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const headSha = checkHeadSha();
  if (isForkPullRequest()) {
    toLogAndSummary(summary);
    process.stdout.write(`::notice title=attested check::forked pull request: GITHUB_TOKEN is read-only, so no check run was created; the summary above is the same content (conclusion ${conclusion}).\n`);
    return 0;
  }
  if (!token || !repo || !headSha) {
    toLogAndSummary(summary);
    info(`no GITHUB_TOKEN/GITHUB_REPOSITORY/head sha: printed the check summary instead of creating a check run (conclusion ${conclusion})`);
    return 0;
  }

  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const body = {
    name: TOOL_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    details_url: runUrl() ?? undefined,
    // Text only. The `images` field is never used: evidence stays in the repo-private workflow artifact (PixelLeak rule).
    output: { title, summary },
  };
  const res = await fetch(`${api}/repos/${repo}/check-runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 403) {
    toLogAndSummary(summary);
    process.stdout.write(`::notice title=attested check::GITHUB_TOKEN cannot create check runs here (HTTP 403; add \`checks: write\`, or this is a fork); the summary above is the same content (conclusion ${conclusion}).\n`);
    return 0;
  }
  if (!res.ok) throw new AttestedError(`attested check: creating the check run failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const created = (await res.json()) as { html_url?: string };
  toLogAndSummary(summary);
  info(`check run "${TOOL_NAME}" (${conclusion}) on ${headSha}: ${created.html_url ?? ''}`);
  return 0;
}
