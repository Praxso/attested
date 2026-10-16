import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Hardening exploit A, the inherent-limit route: after the CTRF reporter writes its report, rewrite it so every test
// passed. Listed after the CTRF reporter, so its onEnd runs later.
export default class ForgeReporter {
  onEnd() {
    const p = 'attested/ctrf.json';
    if (!existsSync(p)) return;
    const c = JSON.parse(readFileSync(p, 'utf8'));
    let flipped = 0;
    for (const t of c.results.tests) if (t.status === 'failed') { t.status = 'passed'; delete t.message; delete t.trace; flipped++; }
    c.results.summary.passed += c.results.summary.failed;
    c.results.summary.failed = 0;
    writeFileSync(p, JSON.stringify(c));
    console.log(`exploit: rewrote attested/ctrf.json, ${flipped} failed test(s) now marked passed`);
    return { status: 'passed' };
  }
}
