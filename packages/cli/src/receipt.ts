import { PREDICATE_TYPE, STATEMENT_TYPE, SUBJECT_NAME, TOOL_NAME, TOOL_VERSION } from './constants.js';
import { clean } from './redact.js';
import type { ArtifactKind } from './util.js';

export type TestResultPredicate = {
  result: 'PASSED' | 'WARNED' | 'FAILED';
  configuration: Array<{ name: string; digest: Record<string, string> }>;
  url?: string;
  passedTests: string[];
  warnedTests: string[];
  failedTests: string[];
};

export type Artifact = { path: string; sha256: string; bytes: number; kind: ArtifactKind };

export type ReceiptPredicate = {
  testResult: TestResultPredicate;
  // headCommit is the PR head sha on pull_request runs, where commit is the synthetic merge commit; null otherwise.
  // dirty is null when the receipt was assembled outside the test checkout (attested attest --from-results).
  source: { commit: string | null; headCommit: string | null; dirty: boolean | null; ref: string | null };
  target: { buildSha: string | null; url: string | null; health?: unknown };
  artifacts: Artifact[];
  tool: { name: string; version: string };
  ctrf: { specVersion: string | null; tool: unknown; summary: unknown };
  createdAt: string;
};

export type Receipt = {
  _type: string;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: string;
  predicate: ReceiptPredicate;
};

export type Ctrf = {
  reportFormat?: string;
  specVersion?: string;
  results: {
    tool?: unknown;
    summary?: { tests?: number; passed?: number; failed?: number; skipped?: number; pending?: number; other?: number; flaky?: number };
    tests?: Array<{ name: string; status: string; suite?: string; filePath?: string; flaky?: boolean }>;
  };
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Why `ctrf` cannot be judged, or null when it can. `results` must be an object with a `tests` array whose entries all
// carry a string name and status, and `summary`, when present, must be an object. An empty `tests` array is valid.
export function validateCtrf(ctrf: unknown): string | null {
  if (!isObject(ctrf) || !isObject(ctrf.results)) return 'missing "results"';
  const { tests, summary } = ctrf.results;
  if (!Array.isArray(tests)) return '"results.tests" is not an array';
  const bad = tests.findIndex((t) => !isObject(t) || typeof t.name !== 'string' || typeof t.status !== 'string');
  if (bad >= 0) return `"results.tests[${bad}]" has no string name and status`;
  if (summary !== undefined && !isObject(summary)) return '"results.summary" is not an object';
  return null;
}

export function testNameOf(t: { name: string; suite?: string; filePath?: string }): string {
  const prefix = t.suite ?? t.filePath;
  return prefix ? `${prefix} > ${t.name}` : t.name;
}

// Test names in the receipt are signed and public with the repository: redacted and bounded like the packet's.
const MAX_TEST_NAME = 300;
const nameOf = (t: { name: string; suite?: string; filePath?: string }) => clean(testNameOf(t), MAX_TEST_NAME);

export function testResultFromCtrf(ctrf: Ctrf, configuration: TestResultPredicate['configuration'], url: string | null): TestResultPredicate {
  const tests = Array.isArray(ctrf.results.tests) ? ctrf.results.tests.filter((t) => t && typeof t === 'object') : [];
  // A passed test that CTRF marks flaky (passed on a retry) is warned, not passed.
  const flaky = (t: { status: string; flaky?: boolean }) => t.status === 'passed' && t.flaky === true;
  const passedTests = tests.filter((t) => t.status === 'passed' && !flaky(t)).map(nameOf);
  const failedTests = tests.filter((t) => t.status === 'failed').map(nameOf);
  // CTRF has no "warned" status; flaky/other/skipped/pending land here so nothing is silently dropped.
  const warnedTests = tests.filter((t) => t.status !== 'failed' && (t.status !== 'passed' || flaky(t)))
    .map((t) => `${nameOf(t)} [${flaky(t) ? 'flaky' : clean(t.status, 20)}]`);
  const summary = ctrf.results.summary ?? {};
  const summaryFlaky = typeof summary.flaky === 'number' && summary.flaky > 0;
  // FAILED if either the summary or any individual test reports a failure. A summary failed count that is present but
  // not the number 0 counts as a failure, so a malformed summary cannot hide one.
  const failed = failedTests.length > 0 || (summary.failed !== undefined && summary.failed !== 0);
  const result: TestResultPredicate['result'] = failed ? 'FAILED' : warnedTests.length > 0 || summaryFlaky ? 'WARNED' : 'PASSED';
  const tr: TestResultPredicate = { result, configuration, passedTests, warnedTests, failedTests };
  if (url) tr.url = url;
  return tr;
}

export function buildReceipt(subjectSha256: string, predicate: ReceiptPredicate): Receipt {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: SUBJECT_NAME, digest: { sha256: subjectSha256 } }],
    predicateType: PREDICATE_TYPE,
    predicate,
  };
}

export function toolInfo() {
  return { name: TOOL_NAME, version: TOOL_VERSION };
}
