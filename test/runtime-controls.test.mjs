import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
const timeout = 60000;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_')));
const sql = { name: 'oc_sql', arguments: { sql: 'SELECT 42' } };
// Every operation receives its own caller signal; no global request state.
const calls = [
  { name: 'SQL', run: (client, options) => client.callTool(sql, undefined, options) },
  { name: 'Ask', run: (client, options) => client.callTool({ name: 'oc_ask', arguments: { nl: 'fixture' } }, undefined, options) },
  { name: 'vector', run: (client, options) => client.callTool({ name: 'oc_vector_topk', arguments: { table: 'fixture', vector: [1, 2] } }, undefined, options) },
  { name: 'FTS', run: (client, options) => client.callTool({ name: 'oc_fts_search', arguments: { table: 'fixture', field: 'body', query: 'fixture' } }, undefined, options) },
  { name: 'schemas tool', run: (client, options) => client.callTool({ name: 'oc_list_schemas', arguments: {} }, undefined, options) },
  { name: 'schemas resource', run: (client, options) => client.readResource({ uri: 'originchain://schemas' }, options) },
];

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t, handler = (_request, res) => res.end('{"ok":true}')) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const request = { method: req.method, url: req.url, headers: req.headers, closed: false };
    requests.push(request);
    res.on('close', () => { request.closed = true; });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    request.body = raw ? JSON.parse(raw) : undefined;
    handler(request, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

async function connect(t, origin, overrides = {}, expectFailure = false) {
  const env = { ...cleanEnv(), OC_HOST: origin, OC_TENANT: 'fixture tenant', OC_TOKEN: 'fixture-token', ...overrides };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  const client = new Client({ name: 'runtime-controls-fixture', version: '1.0.0' });
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
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, version);
  }
  return { client, diagnostics: () => diagnostics };
}

test('paired database credentials reach all five tools and the schema resource', { timeout }, async t => {
  const http = await fixture(t);
  const { client, diagnostics } = await connect(t, http.origin, { OC_DB_USER: 'fixture-user', OC_DB_KEY: 'fixture-key' });
  for (const call of calls) await call.run(client);
  assert.equal(http.requests.length, 6);
  for (const request of http.requests) {
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    assert.equal(request.headers['x-oc-db-user'], 'fixture-user');
    assert.equal(request.headers['x-oc-db-key'], 'fixture-key');
    assert.ok(request.url.startsWith('/v1/tenants/fixture%20tenant/'));
  }
  for (const value of ['fixture-token', 'fixture-key', 'fixture-user', 'fixture tenant', http.origin]) {
    assert.ok(!diagnostics().includes(value), 'configuration values must not appear in diagnostics');
  }
  assert.match(diagnostics(), /request timeout=60000ms/);
});

test('bearer-only configuration omits both database identity headers', { timeout }, async t => {
  const http = await fixture(t);
  const { client } = await connect(t, http.origin);
  await client.callTool(sql);
  assert.equal(http.requests[0].headers['x-oc-db-user'], undefined);
  assert.equal(http.requests[0].headers['x-oc-db-key'], undefined);
});

for (const [label, settings, expected] of [
  ['user without key', { OC_DB_USER: 'fixture-user' }, /supplied together/],
  ['key without user', { OC_DB_KEY: 'fixture-key' }, /supplied together/],
  ['empty key', { OC_DB_USER: 'fixture-user', OC_DB_KEY: '' }, /OC_DB_KEY/],
  ['header injection', { OC_DB_USER: 'fixture-user', OC_DB_KEY: 'secret\r\nInjected:true' }, /visible ASCII/],
  ['invalid bearer', { OC_TOKEN: 'secret token' }, /OC_TOKEN/],
  ['URL userinfo', { OC_HOST: 'https://secret-user:secret-key@example.com' }, /without credentials/],
  ['empty URL userinfo', { OC_HOST: 'https://@example.com' }, /without credentials/],
  ['URL path', { OC_HOST: 'https://example.com/proxy' }, /without credentials/],
  ['normalized URL path', { OC_HOST: 'https://example.com/.' }, /without credentials/],
  ['backslash authority', { OC_HOST: 'https://example.com\\other' }, /without credentials/],
  ['URL query', { OC_HOST: 'https://example.com?token=secret-key' }, /without credentials/],
  ['URL fragment', { OC_HOST: 'https://example.com#secret-key' }, /without credentials/],
  ['URL scheme', { OC_HOST: 'file:///tmp/fixture' }, /HTTP\(S\)/],
  ['remote cleartext HTTP', { OC_HOST: 'http://example.com' }, /must use HTTPS/],
  ['loopback suffix spoof', { OC_HOST: 'http://localhost.example.com' }, /must use HTTPS/],
  ['IPv4 suffix spoof', { OC_HOST: 'http://127.0.0.1.example.com' }, /must use HTTPS/],
  ['insecure opt-in typo', { OC_HOST: 'http://example.com', OC_ALLOW_INSECURE_HTTP: 'TRUE' }, /must use HTTPS/],
  ['tenant dot segment', { OC_TENANT: '..' }, /dot segment/],
  ...['0', '-1', '1.5', 'NaN', 'Infinity', '2147483648', ' 100', ''].map(value =>
    [`invalid timeout ${JSON.stringify(value)}`, { OC_MCP_TIMEOUT_MS: value }, /integer from 1/]),
]) {
  test(`startup rejects ${label} before HTTP without exposing secrets`, { timeout }, async t => {
    const http = await fixture(t);
    const { diagnostics } = await connect(t, http.origin, settings, true);
    assert.match(diagnostics(), expected);
    assert.deepEqual(http.requests, []);
    for (const secret of ['secret-key', 'secret-user', 'secret token', 'Injected:true']) {
      assert.ok(!diagnostics().includes(secret));
    }
  });
}

test('explicit insecure HTTP opt-in permits startup for a remote origin without connecting', { timeout }, async t => {
  const { client } = await connect(t, 'http://example.com', { OC_ALLOW_INSECURE_HTTP: 'true' });
  assert.equal((await client.listTools()).tools.length, 5);
});

for (const origin of ['http://localhost:8123/', 'http://[::1]:8123/']) {
  test(`loopback origin ${origin} permits startup without an insecure opt-in`, { timeout }, async t => {
    const { client } = await connect(t, origin);
    assert.equal((await client.listTools()).tools.length, 5);
  });
}

for (const bodyStarted of [false, true]) {
  test(`deadline aborts HTTP ${bodyStarted ? 'body read' : 'before headers'} and keeps MCP usable`, { timeout }, async t => {
    let stall = true;
    const http = await fixture(t, (_request, res) => {
      if (!stall) { res.end('{"ok":true}'); return; }
      if (bodyStarted) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    });
    const { client } = await connect(t, http.origin, { OC_MCP_TIMEOUT_MS: '250' });
    const result = await client.callTool(sql);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out after 250 ms/);
    assert.match(result.content[0].text, /completion.*unknown/);
    await waitFor(() => http.requests[0]?.closed, 'HTTP connection closes on timeout');
    assert.equal(http.requests.length, 1, 'timed out requests must not be retried');
    stall = false;
    assert.notEqual((await client.callTool(sql)).isError, true);
  });
}

test('schema resource deadline aborts HTTP and returns a protocol error', { timeout }, async t => {
  const http = await fixture(t, (_request, res) => { res.writeHead(200); res.write('['); });
  const { client } = await connect(t, http.origin, { OC_MCP_TIMEOUT_MS: '250' });
  await assert.rejects(client.readResource({ uri: 'originchain://schemas' }), /timed out after 250 ms/);
  await waitFor(() => http.requests[0]?.closed, 'resource HTTP connection closes on timeout');
  assert.equal(http.requests.length, 1);
});

for (const call of calls) {
  test(`MCP cancellation aborts ${call.name} HTTP without affecting another request`, { timeout }, async t => {
    let stall = true;
    const http = await fixture(t, (_request, res) => {
      if (!stall) res.end('{"ok":true}');
    });
    const { client, diagnostics } = await connect(t, http.origin, { OC_MCP_TIMEOUT_MS: '10000' });
    const controller = new AbortController();
    const pending = call.run(client, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await waitFor(() => http.requests.length === 1, 'request reached fixture');
    stall = false;
    assert.notEqual((await client.callTool(sql)).isError, true);
    controller.abort(new Error('private cancellation reason'));
    await rejected;
    await waitFor(() => http.requests[0].closed, 'HTTP connection closes on MCP cancellation');
    assert.equal(http.requests.length, 2, 'cancelled request is not replayed');
    assert.ok(!diagnostics().includes('private cancellation reason'));
    assert.notEqual((await client.callTool(sql)).isError, true);
  });
}

test('MCP cancellation aborts an in-progress response body', { timeout }, async t => {
  const http = await fixture(t, (_request, res) => { res.writeHead(200); res.write('{'); });
  const { client } = await connect(t, http.origin);
  const controller = new AbortController();
  const pending = client.callTool(sql, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await waitFor(() => http.requests.length === 1, 'streaming response began');
  controller.abort();
  await rejected;
  await waitFor(() => http.requests[0].closed, 'streaming HTTP closes on cancellation');
  assert.equal(http.requests.length, 1);
});

for (const status of [301, 302, 303, 307, 308]) {
  for (const paired of [false, true]) {
    test(`HTTP ${status} never forwards ${paired ? 'paired' : 'bearer'} credentials to another origin`, { timeout }, async t => {
      const sink = await fixture(t);
      const http = await fixture(t, (_request, res) => {
        res.writeHead(status, { location: `${sink.origin}/private-target?key=secret-location` });
        res.end('secret redirect body');
      });
      const { client } = await connect(t, http.origin, paired ? { OC_DB_USER: 'fixture-user', OC_DB_KEY: 'fixture-key' } : {});
      const result = await client.callTool(sql);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /redirect.*refused/);
      assert.ok(!result.content[0].text.includes('secret'));
      assert.equal(http.requests.length, 1);
      assert.deepEqual(sink.requests, [], 'redirect target must never receive a request');
    });
  }
}

test('same-origin redirects are also refused without replaying a write', { timeout }, async t => {
  const http = await fixture(t, (_request, res) => { res.writeHead(307, { location: '/retry' }); res.end(); });
  const { client } = await connect(t, http.origin);
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql: 'DELETE FROM fixture_only' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /redirect.*refused/);
  assert.equal(http.requests.length, 1);
});

test('HTTP 503 preserves the tool error without retrying an unsafe SQL write', { timeout }, async t => {
  const http = await fixture(t, (_request, res) => res.writeHead(503).end('{"error":{"code":"busy"}}'));
  const { client } = await connect(t, http.origin);
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql: 'DELETE FROM fixture_only' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /503.*busy/);
  assert.equal(http.requests.length, 1);
});
