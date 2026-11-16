// Structured results: every tool declares an outputSchema, and every successful
// result carries structuredContent that matches it, beside the same text content
// older hosts read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const timeout = 60000;
const ADDRESS_PATH = '/db/structured-results-fixture';

const SELECT = { kind: 'select', columns: ['value'], rows: [{ value: '42' }] };
const WRITE = { kind: 'insert', rows_inserted: 1 };
const HITS = [{ id: 'd1', score: 0.9 }];
const FTS = ['d1'];
const SCHEMAS = ['docs.items'];
const GRAPH = { kind: 'select', rows: [{ email: 'bob@example.com' }] };

async function connect(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, url: req.url, body });
    const send = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    if (body?.sql === 'RAW_TEXT') res.writeHead(200, { 'content-type': 'text/plain' }).end('fixture plain text');
    else if (body?.sql === 'JSON_ARRAY') send(200, [1, 2]);
    else if (body?.sql === 'FAIL') send(401, { error: 'unknown token' });
    else if (body?.sql?.startsWith('INSERT')) send(200, WRITE);
    else if (req.url.endsWith('/sql')) send(200, SELECT);
    else if (req.url.endsWith('/cypher')) send(200, GRAPH);
    else if (req.url.includes('/vector/')) send(200, HITS);
    else if (req.url.includes('/fts/')) send(200, FTS);
    else if (req.url.endsWith('/schemas')) send(200, SCHEMAS);
    else send(404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))),
    OC_URL: `http://127.0.0.1:${server.address().port}${ADDRESS_PATH}`, OC_TOKEN: 'fixture-token',
  };
  const client = new Client({ name: 'structured-results-fixture', version: '1.0.0' });
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
  // Listing tools also makes the SDK client validate every later result against
  // its tool's outputSchema; the explicit check below does not rely on that.
  const { tools } = await client.listTools();
  return { client, requests, tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) };
}

const validatorFor = schema => new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

const CALLS = [
  ['oc_sql', { sql: 'SELECT 42 AS value' }, SELECT, SELECT],
  ['oc_sql', { sql: 'INSERT INTO a VALUES (1)' }, WRITE, WRITE],
  ['oc_cypher', { cypher: 'MATCH (n:users) RETURN n.email' }, GRAPH, GRAPH],
  ['oc_vector_topk', { table: 'docs', vector: [1, 0] }, HITS, { hits: HITS }],
  ['oc_fts_search', { table: 'docs', field: 'body', query: 'tea' }, FTS, { result: FTS }],
  ['oc_list_schemas', {}, SCHEMAS, { schemas: SCHEMAS }],
];

test('every tool declares an object outputSchema that compiles', { timeout }, async t => {
  const { tools } = await connect(t);
  assert.deepEqual(Object.keys(tools).sort(), ['oc_cypher', 'oc_fts_search', 'oc_list_schemas', 'oc_sql', 'oc_vector_topk']);
  for (const tool of Object.values(tools)) {
    assert.equal(tool.outputSchema?.type, 'object', tool.name);
    assert.equal(typeof validatorFor(tool.outputSchema), 'function', tool.name);
  }
});

for (const [name, args, response, structured] of CALLS) {
  test(`${name} ${JSON.stringify(args)} returns structuredContent and keeps its text content`, { timeout }, async t => {
    const { client, tools } = await connect(t);
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    // The text block is unchanged from earlier versions: the response as formatted JSON.
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, JSON.stringify(response, null, 2));
    assert.deepEqual(result.structuredContent, structured);
    const validate = validatorFor(tools[name].outputSchema);
    assert.ok(validate(result.structuredContent), JSON.stringify(validate.errors));
  });
}

test('control: each outputSchema rejects a result of the wrong shape', { timeout }, async t => {
  // Without this, a schema that accepts everything would pass the tests above.
  const { tools } = await connect(t);
  for (const [name, wrong] of [
    ['oc_sql', { kind: 'select', rows: 'not an array' }],
    ['oc_sql', { kind: 7 }],
    ['oc_cypher', { kind: 'select', rows: [1] }],
    ['oc_vector_topk', { hits: [{ id: 'd1', score: 'high' }] }],
    ['oc_list_schemas', { schemas: [1] }],
    ['oc_list_schemas', { schemas: ['a'], extra: true }],
  ]) {
    assert.equal(validatorFor(tools[name].outputSchema)(wrong), false, `${name} accepted ${JSON.stringify(wrong)}`);
  }
});

for (const [sql, value, text] of [
  ['RAW_TEXT', 'fixture plain text', 'fixture plain text'],
  ['JSON_ARRAY', [1, 2], JSON.stringify([1, 2], null, 2)],
]) {
  test(`a response that is not a JSON object (${sql}) is returned as {"value": ...}`, { timeout }, async t => {
    const { client, tools } = await connect(t);
    const result = await client.callTool({ name: 'oc_sql', arguments: { sql } });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, text);
    assert.deepEqual(result.structuredContent, { value });
    assert.ok(validatorFor(tools.oc_sql.outputSchema)(result.structuredContent));
  });
}

test('an error result has text content and no structuredContent', { timeout }, async t => {
  const { client, requests } = await connect(t);
  // Control: the same tool does return structuredContent when it succeeds.
  assert.deepEqual((await client.callTool({ name: 'oc_sql', arguments: { sql: 'SELECT 42 AS value' } })).structuredContent, SELECT);
  const result = await client.callTool({ name: 'oc_sql', arguments: { sql: 'FAIL' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /401: \{"error":"unknown token"\}/);
  assert.equal(result.structuredContent, undefined);
  const refused = await client.callTool({ name: 'oc_vector_topk', arguments: { table: 'docs', vector: 'x' } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent, undefined);
  assert.equal(requests.length, 2);
});
