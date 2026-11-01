// Tool arguments: bound SQL parameters, and path values that must stay inside OC_URL.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const timeout = 60000;
// OC_URL is opaque; an arbitrary path prefix shows when a request leaves it.
const ADDRESS_PATH = '/db/tool-arguments-fixture';

async function connect(t, overrides = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('content-type', 'application/json');
    res.end('{"kind":"select","columns":["value"],"rows":[{"value":"42"}]}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))),
    OC_URL: `http://127.0.0.1:${server.address().port}${ADDRESS_PATH}`, OC_TOKEN: 'fixture-token', ...overrides,
  };
  const client = new Client({ name: 'tool-arguments-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.env.MCP_SERVER_PACKAGE ? 'npx' : process.execPath,
    args: process.env.MCP_SERVER_PACKAGE
      ? ['--yes', '--package', resolve(process.env.MCP_SERVER_PACKAGE), 'originchain-mcp']
      : [resolve('dist/index.js')],
    env, stderr: 'pipe',
  });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });
  await client.connect(transport);
  return { client, requests };
}

test('oc_sql advertises params for $1, $2, ... and says never to splice', { timeout }, async t => {
  const { client } = await connect(t);
  const sql = (await client.listTools()).tools.find(tool => tool.name === 'oc_sql');
  assert.equal(sql.inputSchema.properties.params.type, 'array');
  assert.match(sql.inputSchema.properties.params.description, /\$1, \$2/);
  assert.match(sql.inputSchema.properties.params.description, /never splice/);
  assert.deepEqual(sql.inputSchema.required, ['sql']);
});

for (const params of [[10], ['a', 2, true, null], []]) {
  test(`oc_sql sends params ${JSON.stringify(params)} unchanged beside sql`, { timeout }, async t => {
    const { client, requests } = await connect(t);
    const sql = 'SELECT n FROM a WHERE n > $1';
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql, params } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(requests, [{ method: 'POST', url: `${ADDRESS_PATH}/sql`, body: { sql, params } }]);
  });
}

test('oc_sql without params sends only sql', { timeout }, async t => {
  const { client, requests } = await connect(t);
  await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT 1' } });
  assert.deepEqual(requests.map(r => r.body), [{ sql: 'SELECT 1' }]);
});

test('the SQL-prefix filter forwards a SELECT with its params', { timeout }, async t => {
  const { client, requests } = await connect(t, { OC_MCP_READONLY: 'true' });
  const args = { sql: 'SELECT n FROM a WHERE n = $1', params: [7] };
  assert.notEqual((await client.callTool({ name: 'oc_sql', arguments: args })).isError, true);
  assert.deepEqual(requests.map(r => r.body), [args]);
});

for (const params of ['10', { 1: 10 }, 10, null]) {
  test(`oc_sql rejects params ${JSON.stringify(params)} before HTTP`, { timeout }, async t => {
    const { client, requests } = await connect(t);
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT $1', params } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /`params` must be an array/);
    assert.deepEqual(requests, []);
  });
}

// A path value of "." or ".." would be resolved by the URL parser and move the request
// out of OC_URL's path (for example `/fts/../..` reaches OC_URL's parent).
const pathCalls = [
  ['vector table', v => ({ name: 'oc_vector_topk', arguments: { table: v, vector: [1, 2] } })],
  ['full-text table', v => ({ name: 'oc_fts_search', arguments: { table: v, field: 'body', query: 'x' } })],
  ['full-text field', v => ({ name: 'oc_fts_search', arguments: { table: 'docs', field: v, query: 'x' } })],
];
for (const [label, call] of pathCalls) {
  for (const value of ['', '.', '..']) {
    test(`a ${label} of ${JSON.stringify(value)} is rejected before HTTP`, { timeout }, async t => {
      const { client, requests } = await connect(t);
      const result = await client.callTool(call(value));
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /must not be empty, `\.` or `\.\.`/);
      assert.deepEqual(requests, []);
    });
  }
}

test('control: names that only contain dots stay inside OC_URL, encoded', { timeout }, async t => {
  const { client, requests } = await connect(t);
  for (const [, call] of pathCalls) {
    for (const value of ['...', 'a.b', '%2e%2e', '../x']) {
      assert.notEqual((await client.callTool(call(value))).isError, true, `${value} must be accepted`);
    }
  }
  assert.equal(requests.length, 12);
  for (const request of requests) assert.ok(request.url.startsWith(`${ADDRESS_PATH}/`), request.url);
  assert.ok(requests.some(r => r.url === `${ADDRESS_PATH}/fts/docs/..%2Fx?q=x&limit=20`));
  assert.ok(requests.some(r => r.url === `${ADDRESS_PATH}/vector/%252e%252e/topk`));
});
