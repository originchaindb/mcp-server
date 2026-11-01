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
// Today's address shape. The server must treat it as opaque; other shapes are tested below.
const ADDRESS_PATH = '/v1/tenants/01hzfixtureaddress0000000000';
// Any header with this prefix is an extra identity channel; requests must carry none.
const extraIdentityHeaders = headers => Object.keys(headers).filter(name => name.startsWith('x-oc-'));
// Every operation receives its own caller signal; no global request state.
const calls = [
  { name: 'SQL', run: (client, options) => client.callTool(sql, undefined, options) },
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { requests, origin, url: origin + ADDRESS_PATH };
}

async function connect(t, url, overrides = {}, expectFailure = false) {
  const env = { ...cleanEnv(), OC_URL: url, OC_TOKEN: 'fixture-token', ...overrides };
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
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`MCP startup failed: ${diagnostics}`, { cause: error });
    }
    assert.equal(client.getServerVersion().version, version);
  }
  return { client, diagnostics: () => diagnostics };
}

test('OC_URL and OC_TOKEN alone reach all four tools and the schema resource', { timeout }, async t => {
  const http = await fixture(t);
  // Positive control: the fixture records an extra identity header when one is sent,
  // so the absence check below can fail.
  await fetch(`${http.url}/probe`, { headers: { 'X-OC-Probe': 'control' } });
  assert.deepEqual(extraIdentityHeaders(http.requests[0].headers), ['x-oc-probe']);
  http.requests.length = 0;
  const { client, diagnostics } = await connect(t, http.url);
  for (const call of calls) await call.run(client);
  assert.equal(http.requests.length, 5);
  assert.deepEqual(http.requests.map(r => r.url), [
    `${ADDRESS_PATH}/sql`, `${ADDRESS_PATH}/vector/fixture/topk`, `${ADDRESS_PATH}/fts/fixture/body?q=fixture&limit=20`,
    `${ADDRESS_PATH}/schemas`, `${ADDRESS_PATH}/schemas`,
  ]);
  for (const request of http.requests) {
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(extraIdentityHeaders(request.headers), []);
  }
  for (const value of ['fixture-token', ADDRESS_PATH, http.origin]) {
    assert.ok(!diagnostics().includes(value), 'configuration values must not appear in diagnostics');
  }
  assert.match(diagnostics(), /request timeout=60000ms/);
  assert.doesNotMatch(diagnostics(), /WARNING/);
});

// OC_URL is opaque: whatever path it carries is kept, and only the door path is appended.
for (const [label, path, expected] of [
  ['today\'s address shape', ADDRESS_PATH, `${ADDRESS_PATH}/sql`],
  ['an address without a database id', '/v1', '/v1/sql'],
  ['an arbitrary path prefix', '/custom/prefix/db-7', '/custom/prefix/db-7/sql'],
  ['a bare origin', '', '/sql'],
  ['a trailing slash', `${ADDRESS_PATH}/`, `${ADDRESS_PATH}/sql`],
  ['percent-encoded path characters', '/db/a%20b', '/db/a%20b/sql'],
]) {
  test(`OC_URL with ${label} is used as given`, { timeout }, async t => {
    const http = await fixture(t);
    const { client, diagnostics } = await connect(t, http.origin + path);
    assert.notEqual((await client.callTool(sql)).isError, true);
    assert.deepEqual(http.requests.map(r => [r.method, r.url]), [['POST', expected]]);
    assert.doesNotMatch(diagnostics(), /WARNING/);
  });
}

for (const [label, settings, expected] of [
  ['missing address', { OC_URL: undefined }, /OC_URL is required and missing/],
  ['empty address', { OC_URL: '' }, /OC_URL is required and missing/],
  ['missing token', { OC_TOKEN: undefined }, /OC_TOKEN is required and missing/],
  ['invalid bearer', { OC_TOKEN: 'secret token' }, /OC_TOKEN/],
  ['URL userinfo', { OC_URL: 'https://secret-user:secret-key@example.com/v1' }, /without credentials/],
  ['empty URL userinfo', { OC_URL: 'https://@example.com/v1' }, /without credentials/],
  ['backslash authority', { OC_URL: 'https://example.com\\other' }, /without credentials/],
  ['URL query', { OC_URL: 'https://example.com/v1?token=secret-key' }, /without credentials/],
  ['URL fragment', { OC_URL: 'https://example.com/v1#secret-key' }, /without credentials/],
  ['space in the address', { OC_URL: 'https://example.com/v1 secret-key' }, /without credentials/],
  ['URL scheme', { OC_URL: 'file:///tmp/fixture' }, /HTTP\(S\)/],
  ['relative address', { OC_URL: 'example.com/v1' }, /HTTP\(S\)/],
  ['dot segment', { OC_URL: 'https://example.com/v1/.' }, /rewrite/],
  ['dot-dot segment', { OC_URL: 'https://example.com/v1/db/../admin' }, /rewrite/],
  ['encoded dot-dot segment', { OC_URL: 'https://example.com/v1/%2e%2e/admin' }, /rewrite/],
  ['remote cleartext HTTP', { OC_URL: 'http://example.com/v1' }, /must use HTTPS/],
  ['loopback suffix spoof', { OC_URL: 'http://localhost.example.com/v1' }, /must use HTTPS/],
  ['IPv4 suffix spoof', { OC_URL: 'http://127.0.0.1.example.com/v1' }, /must use HTTPS/],
  ['insecure opt-in typo', { OC_URL: 'http://example.com/v1', OC_ALLOW_INSECURE_HTTP: 'TRUE' }, /must use HTTPS/],
  ...['0', '-1', '1.5', 'NaN', 'Infinity', '2147483648', ' 100', ''].map(value =>
    [`invalid timeout ${JSON.stringify(value)}`, { OC_MCP_TIMEOUT_MS: value }, /integer from 1/]),
]) {
  test(`startup rejects ${label} before HTTP without exposing secrets`, { timeout }, async t => {
    const http = await fixture(t);
    const { diagnostics } = await connect(t, http.url, settings, true);
    assert.match(diagnostics(), expected);
    assert.deepEqual(http.requests, []);
    for (const secret of ['secret-key', 'secret-user', 'secret token', 'example.com', ADDRESS_PATH]) {
      assert.ok(!diagnostics().includes(secret));
    }
  });
}

test('explicit insecure HTTP opt-in permits startup for a remote address without connecting', { timeout }, async t => {
  const { client } = await connect(t, 'http://example.com/v1', { OC_ALLOW_INSECURE_HTTP: 'true' });
  assert.equal((await client.listTools()).tools.length, 4);
});

for (const url of ['http://localhost:8123/v1/', 'http://[::1]:8123/v1']) {
  test(`loopback address ${url} permits startup without an insecure opt-in`, { timeout }, async t => {
    const { client } = await connect(t, url);
    assert.equal((await client.listTools()).tools.length, 4);
  });
}

for (const bodyStarted of [false, true]) {
  test(`deadline aborts HTTP ${bodyStarted ? 'body read' : 'before headers'} and keeps MCP usable`, { timeout }, async t => {
    let stall = true;
    const http = await fixture(t, (_request, res) => {
      if (!stall) { res.end('{"ok":true}'); return; }
      if (bodyStarted) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    });
    const { client } = await connect(t, http.url, { OC_MCP_TIMEOUT_MS: '250' });
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
  const { client } = await connect(t, http.url, { OC_MCP_TIMEOUT_MS: '250' });
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
    const { client, diagnostics } = await connect(t, http.url, { OC_MCP_TIMEOUT_MS: '10000' });
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
  const { client } = await connect(t, http.url);
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
  test(`HTTP ${status} never forwards the token to another address`, { timeout }, async t => {
    const sink = await fixture(t);
    const http = await fixture(t, (_request, res) => {
      res.writeHead(status, { location: `${sink.origin}/private-target?key=secret-location` });
      res.end('secret redirect body');
    });
    const { client } = await connect(t, http.url);
    const result = await client.callTool(sql);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /redirect.*refused/);
    assert.ok(!result.content[0].text.includes('secret'));
    assert.equal(http.requests.length, 1);
    assert.deepEqual(sink.requests, [], 'redirect target must never receive a request');
  });
}

test('same-origin redirects are also refused without replaying a write', { timeout }, async t => {
  const http = await fixture(t, (_request, res) => { res.writeHead(307, { location: '/retry' }); res.end(); });
  const { client } = await connect(t, http.url);
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql: 'DELETE FROM fixture_only' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /redirect.*refused/);
  assert.equal(http.requests.length, 1);
});

test('HTTP 503 preserves the tool error without retrying an unsafe SQL write', { timeout }, async t => {
  const http = await fixture(t, (_request, res) => res.writeHead(503).end('{"error":{"code":"busy"}}'));
  const { client } = await connect(t, http.url);
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql: 'DELETE FROM fixture_only' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /503.*busy/);
  assert.equal(http.requests.length, 1);
});
