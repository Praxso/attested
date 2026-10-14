import { PREDICATE_TYPE, STATEMENT_TYPE, SUBJECT_NAME, TOOL_NAME, TOOL_VERSION } from './constants.js';
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
  source: { commit: string | null; headCommit: string | null; dirty: boolean; ref: string | null };
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
    summary?: { tests?: number; passed?: number; failed?: number; skipped?: number; pending?: number; other?: number };
    tests?: Array<{ name: string; status: string; suite?: string; filePath?: string }>;
  };
};

export function testNameOf(t: { name: string; suite?: string; filePath?: string }): string {
  const prefix = t.suite ?? t.filePath;
  return prefix ? `${prefix} > ${t.name}` : t.name;
}

export function testResultFromCtrf(ctrf: Ctrf, configuration: TestResultPredicate['configuration'], url: string | null): TestResultPredicate {
  const tests = ctrf.results.tests ?? [];
  const passedTests = tests.filter((t) => t.status === 'passed').map(testNameOf);
  const failedTests = tests.filter((t) => t.status === 'failed').map(testNameOf);
  // CTRF has no "warned" status; flaky/other/skipped/pending land here so nothing is silently dropped.
  const warnedTests = tests.filter((t) => !['passed', 'failed'].includes(t.status)).map((t) => `${testNameOf(t)} [${t.status}]`);
  const summary = ctrf.results.summary ?? {};
  const failed = (summary.failed ?? failedTests.length) > 0;
  const result: TestResultPredicate['result'] = failed ? 'FAILED' : warnedTests.length > 0 ? 'WARNED' : 'PASSED';
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
