// Drives the MCP server over stdio: handshake, tool list, and attested_run green then red in a throwaway git repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attested-mcp.js');

const children = [];
process.on('exit', () => children.forEach((c) => c.kill()));

function client() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  let id = 0;
  const call = (method, params) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { call, close: () => child.kill() };
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'attested-mcp-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  // Fake test command: passes unless BROKEN exists.
  writeFileSync(join(dir, 'fake-test.mjs'), `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const red = existsSync('BROKEN');
mkdirSync('attested', { recursive: true });
writeFileSync('attested/ctrf.json', JSON.stringify({ results: { summary: { tests: 1, passed: red ? 0 : 1, failed: red ? 1 : 0 },
  tests: [{ name: 'greets', status: red ? 'failed' : 'passed', message: red ? 'Expected "Hello", got "Bye" token=abc123secret' : undefined }] } }));
process.exit(red ? 1 : 0);
`);
  return dir;
}

test.after(() => children.forEach((c) => c.kill()));

test('handshake and tool list', async () => {
  const c = client();
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'attested');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const list = await c.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['attested_run', 'attested_packet', 'attested_status']);
  const bad = await c.call('nope', {});
  assert.equal(bad.error.code, -32601);
  c.close();
});

test('attested_run red returns the packet, then green after the fix; attested_packet and attested_status', async () => {
  const dir = repo();
  const c = client();
  const command = `${process.execPath} fake-test.mjs`;
  writeFileSync(join(dir, 'BROKEN'), '');
  const red = JSON.parse((await c.call('tools/call', { name: 'attested_run', arguments: { command, cwd: dir } })).result.content[0].text);
  assert.equal(red.result, 'FAILED');
  assert.equal(red.exitCode, 1);
  assert.equal(red.packet.failingTests[0].message, 'Expected "Hello", got "Bye" token=[REDACTED]');
  assert.match(red.packet.rerun, /^attested run --allow-dirty -- sh -c /);
  const packet = JSON.parse((await c.call('tools/call', { name: 'attested_packet', arguments: { cwd: dir } })).result.content[0].text);
  assert.deepEqual(packet, red.packet);
  execFileSync('rm', [join(dir, 'BROKEN')]);
  const green = JSON.parse((await c.call('tools/call', { name: 'attested_run', arguments: { command, cwd: dir } })).result.content[0].text);
  assert.equal(green.result, 'PASSED');
  assert.equal(green.packet, undefined);
  assert.match(green.subject.sha256, /^[0-9a-f]{64}$/);
  const none = (await c.call('tools/call', { name: 'attested_packet', arguments: { cwd: dir } })).result.content[0].text;
  assert.equal(none, 'No failure packet: the last run was PASSED.');
  const status = JSON.parse((await c.call('tools/call', { name: 'attested_status', arguments: { cwd: dir } })).result.content[0].text);
  assert.equal(status.result, 'PASSED');
  assert.equal(status.attestation.checked, false);
  c.close();
});

test('fail-closed refusal is reported as a tool error', async () => {
  const dir = repo();
  const c = client();
  const r = (await c.call('tools/call', { name: 'attested_run', arguments: { command: 'true', cwd: dir, allow_dirty: false } })).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree is dirty/);
  c.close();
});
