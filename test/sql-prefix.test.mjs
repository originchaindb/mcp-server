import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the compiled stdio server and its outgoing HTTP requests. The fixture
// never connects to a database, and its bearer token is deliberately synthetic.
async function connect(t, readOnly) {
  const requests = [];
  const fixture = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rows: [{ value: 42 }] }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))),
    OC_HOST: `http://127.0.0.1:${fixture.address().port}`,
    OC_TENANT: 'test-tenant',
    OC_TOKEN: 'fixture-token',
  };
  if (readOnly) env.OC_MCP_READONLY = 'true';
  else delete env.OC_MCP_READONLY;
  const client = new Client({ name: 'sql-prefix-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.env.MCP_SERVER_PACKAGE ? 'npx' : process.execPath,
    args: process.env.MCP_SERVER_PACKAGE
      ? ['--yes', '--package', resolve(process.env.MCP_SERVER_PACKAGE), 'originchain-mcp']
      : [resolve('dist/index.js')],
    env,
    stderr: 'pipe',
  });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => fixture.close(resolve));
  });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk; });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`MCP startup failed: ${diagnostics}`, { cause: error });
  }
  assert.equal(client.getServerVersion().version, '0.2.0-rc.1');
  return { client, requests };
}

for (const sql of ['SELECT 42 AS value', ' \n\tselect 42 AS value', 'SeLeCt(42) AS value']) {
  test(`SELECT-prefix filter forwards ${JSON.stringify(sql)}`, { timeout: 60000 }, async t => {
    const { client, requests } = await connect(t, true);
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(requests, [{ method: 'POST', path: '/v1/tenants/test-tenant/sql', body: { sql } }]);
    assert.deepEqual(JSON.parse(result.content[0].text), { rows: [{ value: 42 }] });
  });
}

for (const sql of ['DELETE FROM fixture_only', 'SELECTED 42', '', 'WITH c AS (SELECT 1) SELECT * FROM c']) {
  test(`SELECT-prefix filter rejects ${JSON.stringify(sql)} before HTTP`, { timeout: 60000 }, async t => {
    const { client, requests } = await connect(t, true);
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SELECT/);
    assert.deepEqual(requests, []);
  });
}

test('unset filter preserves SQL forwarding to database authorization', { timeout: 60000 }, async t => {
  const { client, requests } = await connect(t, false);
  const sql = 'DELETE FROM fixture_only';
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(requests, [{ method: 'POST', path: '/v1/tenants/test-tenant/sql', body: { sql } }]);
});

test('SQL-only filter does not claim to restrict Ask', { timeout: 60000 }, async t => {
  const { client, requests } = await connect(t, true);
  const result = await client.callTool({ name: 'oc_ask', arguments: { nl: 'fixture query' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(requests, [{ method: 'POST', path: '/v1/tenants/test-tenant/ask', body: { nl: 'fixture query' } }]);
});

test('prefix filtering is not a SQL parser or read-only authorization boundary', { timeout: 60000 }, async t => {
  const { client, requests } = await connect(t, true);
  const sql = 'SELECT 1; DELETE FROM fixture_only';
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(requests, [{ method: 'POST', path: '/v1/tenants/test-tenant/sql', body: { sql } }]);
});
