// Static checks that the docs describe the merged sign-job checkout, not the replaced base-commit checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docs = ['README.md', 'SECURITY.md', 'M2-REPORT.md', ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

test('no doc describes the sign job checking out the PR-chosen base commit', () => {
  for (const f of docs) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.equal(text.includes('github.event.pull_request.base.sha'), false, f);
    assert.equal(/separate PR, pending review/.test(text), false, f);
  }
  assert.match(readFileSync(join(ROOT, '.github/workflows/attested.yml'), 'utf8'), /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});
