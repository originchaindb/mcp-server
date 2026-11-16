import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the compiled stdio server and its outgoing HTTP requests. The fixture
// never connects to a database, and its bearer token is deliberately synthetic.
// OC_URL is opaque, so this file uses an arbitrary path prefix rather than today's shape.
const ADDRESS_PATH = '/db/sql-prefix-fixture';
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
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
    OC_URL: `http://127.0.0.1:${fixture.address().port}${ADDRESS_PATH}`,
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
  assert.equal(client.getServerVersion().version, version);
  return { client, requests };
}

for (const sql of ['SELECT 42 AS value', ' \n\tselect 42 AS value', 'SeLeCt 42 AS value;']) {
  test(`read-only mode forwards ${JSON.stringify(sql)}`, { timeout: 60000 }, async t => {
    const { client, requests } = await connect(t, true);
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(requests, [{ method: 'POST', path: `${ADDRESS_PATH}/sql`, body: { sql } }]);
    assert.deepEqual(JSON.parse(result.content[0].text), { rows: [{ value: 42 }] });
  });
}

for (const sql of ['DELETE FROM fixture_only', 'SELECTED 42', '', 'WITH c AS (SELECT 1) SELECT * FROM c']) {
  test(`read-only mode rejects ${JSON.stringify(sql)} before HTTP`, { timeout: 60000 }, async t => {
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
  assert.deepEqual(requests, [{ method: 'POST', path: `${ADDRESS_PATH}/sql`, body: { sql } }]);
});

test('advertised tool set excludes the removed service and rejects it before HTTP', { timeout: 60000 }, async t => {
  const { client, requests } = await connect(t, true);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
    'oc_cypher', 'oc_fts_search', 'oc_list_schemas', 'oc_sql', 'oc_vector_topk',
  ]);
  const result = await client.callTool({ name: 'oc_ask', arguments: { nl: 'fixture query' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
  assert.deepEqual(requests, []);
});

// OC_MCP_READONLY=true makes oc_sql read-only, as its annotations say: a statement that
// starts with SELECT but may still write is refused, not forwarded. Until 0.4.0 the
// setting checked only the SELECT prefix and forwarded every one of these.
for (const sql of [
  'SELECT 1; DELETE FROM fixture_only', 'SELECT * INTO fixture_copy FROM fixture_only', 'SELECT nextval($1)',
  'SELECT v FROM fixture_only FOR UPDATE', 'SELECT writes_rows()', 'SELECT other.count(v) FROM fixture_only',
  '/* note */ SELECT 1', 'SELECT 1 -- note', 'SELECT "f"(1)', 'SELECT $$x$$', "SELECT v FROM a WHERE note = 'delete'",
  'SeLeCt(42) AS value',
]) {
  test(`read-only mode refuses ${JSON.stringify(sql)}, which may write, before HTTP`, { timeout: 60000 }, async t => {
    const { client, requests } = await connect(t, true);
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql, params: [1] } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /OC_MCP_READONLY=true: oc_sql is read-only and forwards only a single plain SELECT/);
    assert.match(result.content[0].text, /put values in `params`/);
    assert.deepEqual(requests, []);
  });
}

test('read-only mode refuses a write word in the text and forwards the same read with the value in params', { timeout: 60000 }, async t => {
  // Control for the refusals above: the value refused inside the text passes as a parameter.
  const { client, requests } = await connect(t, true);
  const refused = await client.callTool({ name: 'oc_sql', arguments: { sql: "SELECT v FROM a WHERE note = 'delete'" } });
  assert.equal(refused.isError, true);
  assert.deepEqual(requests, []);
  const args = { sql: 'SELECT v FROM a WHERE note = $1 AND id IN (SELECT id FROM b) ORDER BY lower(v) LIMIT 5', params: ['delete'] };
  const result = await client.callTool({ name: 'oc_sql', arguments: args });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(requests, [{ method: 'POST', path: `${ADDRESS_PATH}/sql`, body: args }]);
});
