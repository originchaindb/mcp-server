// Proves how retired connection settings behave. This file and src/config.ts are the
// only places the retired names may appear (enforced by test/access-terms.test.mjs).
//
// - The two-part address of 0.2.x and earlier is refused at startup: alone, empty,
//   or beside OC_URL. The error names OC_URL as the replacement.
// - Database-user settings are refused at startup; identity headers are never sent.
// - No refusal points to an earlier release, and none prints a configured value.
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
    await waitFor(() => diagnostics.includes('ready; request timeout='), 'ready diagnostic');
  }
  return { client, diagnostics: () => diagnostics };
}

test('positive control: the fixture records retired identity headers when a client sends them', { timeout }, async t => {
  const http = await fixture(t);
  await fetch(`${http.origin}/probe`, { headers: { 'X-OC-DB-User': 'u', 'X-OC-DB-Key': 'k', 'X-OC-Tenant': 't' } });
  assert.deepEqual(retiredHeaders(http.requests[0].headers), RETIRED_HEADERS);
});

test('positive control: OC_URL and OC_TOKEN alone start, and requests carry no retired header', { timeout }, async t => {
  // The refusals below can fail: this configuration, through the same helper, does start.
  const http = await fixture(t);
  const { client, diagnostics } = await start(t, { OC_URL: `${http.origin}/db/current` });
  assert.notEqual((await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT 1' } })).isError, true);
  assert.deepEqual(http.requests.map(r => r.url), ['/db/current/sql']);
  assert.equal(http.requests[0].headers.authorization, 'Bearer fixture-token');
  assert.deepEqual(retiredHeaders(http.requests[0].headers), []);
  assert.doesNotMatch(diagnostics(), /WARNING|FATAL/);
});

const BOTH = /OC_HOST and OC_TENANT are retired; set OC_URL to your database's address from Connect and remove them\./;
for (const [label, settings, expected] of [
  ['the retired two-part address', h => ({ OC_HOST: h, OC_TENANT: 'legacy-secret-id' }), BOTH],
  ['the retired two-part address beside OC_URL', h => ({ OC_URL: `${h}/db/current`, OC_HOST: h, OC_TENANT: 'legacy-secret-id' }), BOTH],
  ['the retired two-part address beside an empty OC_URL', h => ({ OC_URL: '', OC_HOST: h, OC_TENANT: 'legacy-secret-id' }), BOTH],
  ['empty retired address settings beside OC_URL', h => ({ OC_URL: `${h}/db/current`, OC_HOST: '', OC_TENANT: '' }), BOTH],
  ['a retired host alone', h => ({ OC_HOST: h }), /OC_HOST is retired; set OC_URL to your database's address from Connect and remove it\./],
  ['a retired host beside OC_URL', h => ({ OC_URL: `${h}/db/current`, OC_HOST: 'https://legacy-host.invalid' }), /OC_HOST is retired; set OC_URL/],
  ['a retired database id alone', () => ({ OC_TENANT: 'legacy-secret-id' }), /OC_TENANT is retired; set OC_URL to your database's address from Connect and remove it\./],
  ['a retired database id beside OC_URL', h => ({ OC_URL: `${h}/db/current`, OC_TENANT: 'legacy-secret-id' }), /OC_TENANT is retired; set OC_URL/],
  ['a database-user name', h => ({ OC_URL: `${h}/v1`, OC_DB_USER: 'secret-user' }), /OC_DB_USER is no longer supported; create an access token/],
  ['a database-user key', h => ({ OC_URL: `${h}/v1`, OC_DB_KEY: 'secret-key' }), /OC_DB_KEY is no longer supported; create an access token/],
  ['a database-user pair', h => ({ OC_URL: `${h}/v1`, OC_DB_USER: 'secret-user', OC_DB_KEY: 'secret-key' }), /OC_DB_USER and OC_DB_KEY are no longer supported/],
  ['an empty database-user pair', h => ({ OC_URL: `${h}/v1`, OC_DB_USER: '', OC_DB_KEY: '' }), /OC_DB_USER and OC_DB_KEY are no longer supported/],
  ['a database-user pair with the retired address', h => ({ OC_HOST: h, OC_TENANT: 'legacy-secret-id', OC_DB_USER: 'secret-user', OC_DB_KEY: 'secret-key' }), BOTH],
]) {
  test(`startup refuses ${label} before HTTP without exposing values`, { timeout }, async t => {
    const http = await fixture(t);
    const { diagnostics } = await start(t, settings(http.origin), true);
    assert.match(diagnostics(), expected);
    assert.doesNotMatch(diagnostics(), /WARNING|0\.2\.|keep using/, 'no warning and no pointer to an earlier release');
    assert.deepEqual(http.requests, []);
    for (const value of ['secret-user', 'secret-key', 'legacy-secret-id', 'legacy-host.invalid', '/db/current', http.origin]) {
      assert.ok(!diagnostics().includes(value), 'diagnostics must not print configured values');
    }
  });
}
