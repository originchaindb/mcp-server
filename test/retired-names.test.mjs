// Proves how retired connection settings behave. This file and src/config.ts are the
// only places the retired names may appear (enforced by test/access-terms.test.mjs).
//
// - The two-part address of 0.2.x and earlier is read for one release, only when
//   OC_URL is unset, with exactly one warning on stderr naming OC_URL.
// - Database-user settings are refused at startup; identity headers are never sent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const timeout = 60000;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_')));
const RETIRED_HEADERS = ['x-oc-db-user', 'x-oc-db-key', 'x-oc-tenant'];
const retiredHeaders = headers => RETIRED_HEADERS.filter(name => name in headers);
const countOf = (text, needle) => text.split(needle).length - 1;

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

async function start(t, settings, expectFailure = false) {
  const env = { ...cleanEnv(), OC_TOKEN: 'fixture-token', ...settings };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  const client = new Client({ name: 'retired-names-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.env.MCP_SERVER_PACKAGE ? 'npx' : process.execPath,
    args: process.env.MCP_SERVER_PACKAGE
      ? ['--yes', '--package', resolve(process.env.MCP_SERVER_PACKAGE), 'originchain-mcp']
      : [resolve('dist/index.js')],
    env, stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  t.after(() => client.close());
  if (expectFailure) {
    await assert.rejects(client.connect(transport));
    await waitFor(() => diagnostics.includes('FATAL:'), 'startup diagnostic');
  } else {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`MCP startup failed: ${diagnostics}`, { cause: error });
    }
    // The ready line is written after any warning, so absence checks below are not vacuous.
    await waitFor(() => diagnostics.includes('ready; request timeout='), 'ready diagnostic');
  }
  return { client, diagnostics: () => diagnostics };
}

test('positive control: the fixture records retired identity headers when a client sends them', { timeout }, async t => {
  const http = await fixture(t);
  await fetch(`${http.origin}/probe`, { headers: { 'X-OC-DB-User': 'u', 'X-OC-DB-Key': 'k', 'X-OC-Tenant': 't' } });
  assert.deepEqual(retiredHeaders(http.requests[0].headers), RETIRED_HEADERS);
});

test('the retired two-part address still works for one release, with exactly one warning', { timeout }, async t => {
  const http = await fixture(t);
  const { client, diagnostics } = await start(t, { OC_HOST: http.origin, OC_TENANT: 'legacy fixture' });
  for (let i = 0; i < 3; i++) assert.notEqual((await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT 1' } })).isError, true);
  await client.callTool({ name: 'oc_list_schemas', arguments: {} });
  assert.deepEqual(http.requests.map(r => r.url), [
    '/v1/tenants/legacy%20fixture/sql', '/v1/tenants/legacy%20fixture/sql', '/v1/tenants/legacy%20fixture/sql',
    '/v1/tenants/legacy%20fixture/schemas',
  ]);
  for (const request of http.requests) {
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(retiredHeaders(request.headers), []);
  }
  assert.equal(countOf(diagnostics(), 'WARNING'), 1, diagnostics());
  assert.match(diagnostics(), /WARNING: OC_HOST and OC_TENANT are deprecated .*set OC_URL to your database's address from Connect/);
  for (const value of [http.origin, 'legacy fixture', 'legacy%20fixture', 'fixture-token']) {
    assert.ok(!diagnostics().includes(value), 'warnings must not print configured values');
  }
});

test('an empty OC_URL counts as unset, so the retired address still works for one release', { timeout }, async t => {
  const http = await fixture(t);
  const { client, diagnostics } = await start(t, { OC_URL: '', OC_HOST: http.origin, OC_TENANT: 'legacy' });
  assert.notEqual((await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT 1' } })).isError, true);
  assert.deepEqual(http.requests.map(r => r.url), ['/v1/tenants/legacy/sql']);
  assert.equal(countOf(diagnostics(), 'WARNING'), 1, diagnostics());
  assert.match(diagnostics(), /OC_HOST and OC_TENANT are deprecated/);
  assert.doesNotMatch(diagnostics(), /ignored because OC_URL is set/);
});

test('OC_URL wins over the retired address settings, which are reported as ignored', { timeout }, async t => {
  const http = await fixture(t);
  const { client, diagnostics } = await start(t, {
    OC_URL: `${http.origin}/db/current`, OC_HOST: 'https://legacy-host.invalid', OC_TENANT: 'legacy-secret-id',
  });
  await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT 1' } });
  assert.deepEqual(http.requests.map(r => r.url), ['/db/current/sql']);
  assert.equal(countOf(diagnostics(), 'WARNING'), 1, diagnostics());
  assert.match(diagnostics(), /OC_HOST and OC_TENANT are ignored because OC_URL is set/);
  for (const value of ['legacy-host.invalid', 'legacy-secret-id', '/db/current']) assert.ok(!diagnostics().includes(value));
});

for (const [label, settings, expected] of [
  ['a retired host without its database id', h => ({ OC_HOST: h }), /OC_URL is required and missing/],
  ['a retired database id without its host', () => ({ OC_TENANT: 'legacy' }), /OC_URL is required and missing/],
  ['a retired dot-segment database id', h => ({ OC_HOST: h, OC_TENANT: '..' }), /dot segment/],
  ['a retired host with a path', () => ({ OC_HOST: 'https://example.com/proxy', OC_TENANT: 'legacy' }), /OC_HOST is retired .*without credentials/],
  ['a retired host with userinfo', () => ({ OC_HOST: 'https://secret-user:secret-key@example.com', OC_TENANT: 'legacy' }), /OC_HOST is retired/],
  ['a retired remote cleartext host', () => ({ OC_HOST: 'http://example.com', OC_TENANT: 'legacy' }), /must use HTTPS/],
  ['a database-user name', h => ({ OC_URL: `${h}/v1`, OC_DB_USER: 'secret-user' }), /OC_DB_USER is no longer supported; create an access token/],
  ['a database-user key', h => ({ OC_URL: `${h}/v1`, OC_DB_KEY: 'secret-key' }), /OC_DB_KEY is no longer supported; create an access token/],
  ['a database-user pair', h => ({ OC_URL: `${h}/v1`, OC_DB_USER: 'secret-user', OC_DB_KEY: 'secret-key' }), /OC_DB_USER and OC_DB_KEY are no longer supported/],
  ['an empty database-user pair', h => ({ OC_URL: `${h}/v1`, OC_DB_USER: '', OC_DB_KEY: '' }), /OC_DB_USER and OC_DB_KEY are no longer supported/],
  ['a database-user pair with the retired address', h => ({ OC_HOST: h, OC_TENANT: 'legacy', OC_DB_USER: 'secret-user', OC_DB_KEY: 'secret-key' }), /no longer supported/],
]) {
  test(`startup refuses ${label} before HTTP without exposing values`, { timeout }, async t => {
    const http = await fixture(t);
    const { diagnostics } = await start(t, settings(http.origin), true);
    assert.match(diagnostics(), expected);
    if (/OC_DB_/.test(label + JSON.stringify(settings('')))) {
      // Databases without access tokens have no token to create; the message says what to do there.
      assert.match(diagnostics(), /If this database does not support access tokens yet, keep using 0\.2\.0-rc\.1 until it does\./);
    }
    assert.deepEqual(http.requests, []);
    for (const value of ['secret-user', 'secret-key', 'example.com', http.origin]) assert.ok(!diagnostics().includes(value));
  });
}
