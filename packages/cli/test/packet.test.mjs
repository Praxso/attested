// Failure packet: redaction of every secret shape, grouping, deterministic truncation under 12 KB, trace parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { buildPacket, redact, serializePacket, PACKET_MAX_BYTES } from '../dist/packet.js';

// One fixture string per secret shape the packet must mask.
const FIXTURE = {
  bearer: 'Authorization: Bearer abcDEF123456789.ghi-jkl',
  key: 'calling https://api.example.test/v1/items?api_key=AAAA1111BBBB#section failed; key=k3y-value-123',
  token: 'retry with token=tok_live_1234567890 now',
  email: 'notify jane.doe+ci@example.co.uk about it',
  ghToken: 'push used ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  json: '{"password": "hunter2-very-secret"}',
  ansi: '\u001b[31mExpected\u001b[39m: "a"',
};

test('redaction masks every shape in the fixture', () => {
  const out = Object.fromEntries(Object.entries(FIXTURE).map(([k, v]) => [k, redact(v)]));
  assert.equal(out.bearer, 'Authorization: Bearer [REDACTED]');
  assert.equal(out.key, 'calling https://api.example.test/v1/items failed; key=[REDACTED]');
  assert.equal(out.token, 'retry with token=[REDACTED] now');
  assert.equal(out.email, 'notify [EMAIL] about it');
  assert.equal(out.ghToken, 'push used [REDACTED]');
  assert.equal(out.jwt, 'cookie [REDACTED]');
  assert.equal(out.json, '{"password": "[REDACTED]"}');
  assert.equal(out.ansi, 'Expected: "a"');
  const all = JSON.stringify(out);
  for (const secret of ['abcDEF123456789', 'AAAA1111BBBB', 'section', 'k3y-value-123', 'tok_live', 'jane.doe', 'ghp_', 'eyJhbG', 'hunter2']) {
    assert.equal(all.includes(secret), false, `${secret} leaked`);
  }
});

// Minimal stored-or-deflated zip writer, enough for the packet's reader.
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text)); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'attested-packet-'));
  mkdirSync(join(dir, 'test-results', 't'), { recursive: true });
  const trace = [
    { type: 'console', messageType: 'warning', text: 'deprecated api' },
    { type: 'console', messageType: 'error', text: `boom for ${FIXTURE.email}` },
    { type: 'console', messageType: 'error', text: `boom for ${FIXTURE.email}` },
    { type: 'console', messageType: 'log', text: 'not included' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const network = [
    { type: 'resource-snapshot', snapshot: { request: { method: 'POST', url: 'https://api.example.test/login?token=abc#x' }, response: { status: 401 } } },
    { type: 'resource-snapshot', snapshot: { request: { method: 'GET', url: 'https://api.example.test/ok' }, response: { status: 200 } } },
  ].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(dir, 'test-results', 't', 'trace.zip'), zip({ '0-trace.trace': trace, '0-trace.network': network }));
  return dir;
}

function failing(dir, name, message) {
  return {
    name, status: 'failed', suite: ['chromium', 'a.spec.ts'], filePath: join(dir, 'tests/a.spec.ts'), message,
    trace: `${message}\n${Array.from({ length: 30 }, (_, i) => `    at fn${i} (${join(dir, 'tests/a.spec.ts')}:${i + 3}:5)`).join('\n')}`,
    attachments: [{ name: 'trace', path: join(dir, 'test-results/t/trace.zip') }],
  };
}

test('packet: grouped, redacted, trace console/network, relative paths, no env', () => {
  const dir = fixtureDir();
  process.env.ATTESTED_TEST_ENV_SECRET = 'env-value-must-not-appear';
  const tests = Array.from({ length: 50 }, (_, i) => failing(dir, `flaky ${String(i).padStart(2, '0')}`, `Error: ${FIXTURE.bearer} ${FIXTURE.key}`));
  const artifacts = [{ path: 'test-results/t/trace.zip', sha256: 'f'.repeat(64), bytes: 1, kind: 'trace' }];
  const p = buildPacket({ results: { tests } }, artifacts, dir, 'attested run -- pnpm exec playwright test');
  const text = serializePacket(p);
  assert.equal(p.failingTests.length, 1, '50 identical failures collapse into one group');
  assert.equal(p.failingTests[0].count, 50);
  assert.equal(p.failingTests[0].name, 'chromium,a.spec.ts > flaky 00');
  assert.equal(p.failingTests[0].file, 'tests/a.spec.ts');
  assert.equal(p.failingTests[0].line, 3);
  assert.equal(p.failingTests[0].stack.length, 20);
  assert.equal(p.failingTests[0].stack[0], 'at fn0 (tests/a.spec.ts:3:5)');
  assert.deepEqual(p.failingTests[0].evidence, [{ kind: 'trace', path: 'test-results/t/trace.zip', sha256: 'f'.repeat(64) }]);
  assert.deepEqual(p.console, [{ level: 'error', message: 'boom for notify [EMAIL] about it', count: 2 }, { level: 'warning', message: 'deprecated api', count: 1 }]);
  assert.deepEqual(p.network, [{ method: 'POST', path: '/login', status: 401, count: 1 }]);
  assert.equal(p.truncated, false);
  for (const leak of ['abcDEF123456789', 'AAAA1111BBBB', 'jane.doe', 'token=abc', dir, 'env-value-must-not-appear']) {
    assert.equal(text.includes(leak), false, `${leak} leaked`);
  }
});

test('packet: distinct failures over 12 KB truncate alphabetically and record the cut', () => {
  const dir = fixtureDir();
  const tests = Array.from({ length: 40 }, (_, i) => failing(dir, `case ${String(i).padStart(2, '0')}`, `Error: distinct failure ${i} ${'x'.repeat(600)}`));
  const p = buildPacket({ results: { tests: [...tests].reverse() } }, [], dir, 'attested run -- t');
  const bytes = Buffer.byteLength(serializePacket(p));
  assert.ok(bytes <= PACKET_MAX_BYTES, `${bytes} bytes`);
  assert.equal(p.truncated.frames, true);
  assert.ok(p.truncated.tests > 0);
  assert.equal(p.failingTests.length + p.truncated.tests, 40);
  assert.deepEqual(p.failingTests.map((t) => t.name), tests.slice(0, p.failingTests.length).map((t) => `chromium,a.spec.ts > ${t.name}`));
  // Deterministic: same input, same bytes.
  assert.equal(serializePacket(buildPacket({ results: { tests: [...tests].reverse() } }, [], dir, 'attested run -- t')), serializePacket(p));
});
