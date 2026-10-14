// Single place to rename the project or move the predicate URI.
export const TOOL_NAME = 'prove';
export const TOOL_VERSION = '0.1.0';
export const PREDICATE_TYPE = 'https://Praxso/prove/receipt/v0.1';
export const TEST_RESULT_PREDICATE_TYPE = 'https://in-toto.io/attestation/test-result/v0.1';
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const SUBJECT_NAME = 'ctrf.json';

export const DEFAULTS = {
  ctrf: 'prove/ctrf.json',
  outputDir: 'test-results',
  receipt: 'prove/receipt.json',
  predicate: 'prove/predicate.json',
  testResultPredicate: 'prove/test-result.json',
  healthPath: '/healthz',
};
