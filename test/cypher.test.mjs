// oc_cypher: a read-only graph query, POST $OC_URL/cypher with read_only: true.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const timeout = 60000;
// OC_URL is opaque; an arbitrary path prefix shows when a request leaves it.
const ADDRESS_PATH = '/db/cypher-fixture';
const ROWS = { kind: 'select', rows: [{ email: 'bob@example.com' }] };
// The engine's refusal of a write in a read_only request.
const REFUSAL = { error: 'read_only_query', sqlstate: '42501', detail: 'This endpoint accepts read-only Cypher queries.' };
const READ_ONLY_MESSAGE = /graph queries are read-only here; use oc_sql for writes/;

async function connect(t, handler = (_request, res) => res.end(JSON.stringify(ROWS))) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = { method: req.method, url: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
    request.index = requests.length;
    requests.push(request);
    res.setHeader('content-type', 'application/json');
    handler(request, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))),
    OC_URL: `http://127.0.0.1:${server.address().port}${ADDRESS_PATH}`, OC_TOKEN: 'fixture-token',
  };
  const client = new Client({ name: 'cypher-fixture', version: '1.0.0' });
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
const cypher = args => ({ name: 'oc_cypher', arguments: args });

test('oc_cypher is advertised with a required query, scalar params and an optional default schema', { timeout }, async t => {
  const { client } = await connect(t);
  const tool = (await client.listTools()).tools.find(entry => entry.name === 'oc_cypher');
  assert.ok(tool, 'oc_cypher is listed');
  assert.deepEqual(tool.inputSchema.required, ['cypher']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['cypher', 'default_schema', 'params']);
  assert.equal(tool.inputSchema.properties.params.type, 'object');
  assert.deepEqual(tool.inputSchema.properties.params.additionalProperties, { type: ['string', 'number', 'boolean', 'null'] });
  assert.match(tool.inputSchema.properties.params.description, /never splice/);
  assert.match(tool.description, /POST \$OC_URL\/cypher/);
  assert.match(tool.description, /read-only/);
});

test('oc_cypher POSTs the query, its params and read_only: true to $OC_URL/cypher', { timeout }, async t => {
  const { client, requests } = await connect(t);
  const args = {
    cypher: 'MATCH (a)-[:follows]->(b) WHERE a.id = $id AND b.active = $active RETURN b.email LIMIT $n',
    params: { id: 'alice', active: true, n: 10, missing: null },
    default_schema: 'social.users',
  };
  const result = await client.callTool(cypher(args));
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), ROWS);
  assert.deepEqual(result.structuredContent, ROWS);
  assert.deepEqual(requests.map(({ method, url, authorization, body }) => ({ method, url, authorization, body })), [{
    method: 'POST', url: `${ADDRESS_PATH}/cypher`, authorization: 'Bearer fixture-token',
    body: { cypher: args.cypher, params: args.params, read_only: true, default_schema: 'social.users' },
  }]);
});

test('without params oc_cypher sends an empty params object, and default_schema only when given', { timeout }, async t => {
  const { client, requests } = await connect(t);
  await client.callTool(cypher({ cypher: 'MATCH (n:users) RETURN n.email' }));
  assert.deepEqual(requests.map(r => r.body), [{ cypher: 'MATCH (n:users) RETURN n.email', params: {}, read_only: true }]);
});

test('params are bound by the database, never spliced into the query text', { timeout }, async t => {
  const { client, requests } = await connect(t);
  const query = 'MATCH (n:users) WHERE n.name = $name RETURN n';
  const params = { name: "x' OR 1=1 //", quote: '"}{$name' };
  await client.callTool(cypher({ cypher: query, params }));
  assert.equal(requests[0].body.cypher, query);
  assert.deepEqual(requests[0].body.params, params);
});

for (const [label, args, message] of [
  ['a list param', { cypher: 'MATCH (n) RETURN n', params: { ids: [1, 2] } }, /`params` values must be strings, numbers, booleans or null/],
  ['an object param', { cypher: 'MATCH (n) RETURN n', params: { filter: { a: 1 } } }, /`params` values must be strings, numbers, booleans or null/],
  ['params as an array', { cypher: 'MATCH (n) RETURN n', params: ['alice'] }, /`params` must be an object/],
  ['params as a string', { cypher: 'MATCH (n) RETURN n', params: 'alice' }, /`params` must be an object/],
  ['params as null', { cypher: 'MATCH (n) RETURN n', params: null }, /`params` must be an object/],
  ['a missing query', { params: {} }, /`cypher` must be a string/],
  ['a numeric query', { cypher: 7 }, /`cypher` must be a string/],
  ['a numeric default schema', { cypher: 'MATCH (n) RETURN n', default_schema: 7 }, /`default_schema` must be a string/],
]) {
  test(`oc_cypher rejects ${label} before HTTP`, { timeout }, async t => {
    const { client, requests } = await connect(t);
    const result = await client.callTool(cypher(args));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
    assert.deepEqual(requests, []);
  });
}

for (const [label, body] of [
  ['the engine\'s read_only_query refusal', REFUSAL],
  ['a read_only_query refusal with an error object', { error: { code: 'read_only_query', message: 'refused' } }],
]) {
  test(`${label} becomes a tool error that says graph queries are read-only here`, { timeout }, async t => {
    // A query the server lets through but the engine refuses, such as a write the
    // server cannot see in the text.
    const { client, requests } = await connect(t, (_request, res) => res.writeHead(403).end(JSON.stringify(body)));
    const result = await client.callTool(cypher({ cypher: 'MATCH (n) RETURN n' }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, READ_ONLY_MESSAGE);
    assert.match(result.content[0].text, /403/);
    assert.equal(requests.length, 1, 'a refusal is not resent');
  });
}

test('control: any other 403 keeps the plain HTTP error', { timeout }, async t => {
  const { client } = await connect(t, (_request, res) => res.writeHead(403).end(JSON.stringify({ error: 'permission denied for users' })));
  const result = await client.callTool(cypher({ cypher: 'MATCH (n) RETURN n' }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /OriginChain POST \/cypher → 403: \{"error":"permission denied for users"\}/);
  assert.doesNotMatch(result.content[0].text, READ_ONLY_MESSAGE);
});

// Older databases ignore `read_only`, so the server also refuses a write keyword
// anywhere in the text, before any request.
for (const query of [
  'CREATE (n:users {id: 1})', 'MATCH (n:users) SET n.active = false', 'MATCH (n:users) DETACH DELETE n',
  'match (n:users) delete n', 'MERGE (n:users {id: 1})', 'MATCH (n:users) REMOVE n.active',
  'MATCH (n:users) FOREACH (x IN [1] | CREATE (:audit))', 'MATCH (n:users) CALL { CREATE (:audit) } RETURN n',
  'DROP INDEX users_email', "LOAD CSV FROM 'file:///x' AS line RETURN line",
  "MATCH (n:users) WHERE n.note = 'set' RETURN n",
]) {
  test(`oc_cypher refuses ${JSON.stringify(query)} before HTTP`, { timeout }, async t => {
    const { client, requests } = await connect(t);
    const result = await client.callTool(cypher({ cypher: query }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, READ_ONLY_MESSAGE);
    assert.deepEqual(requests, []);
  });
}

test('control: reads, and names that merely contain a write keyword, are forwarded', { timeout }, async t => {
  const { client, requests } = await connect(t);
  const reads = [
    'MATCH (n:users) WHERE n.created_at > $since RETURN n.settings, n.deleted_flag, n.merged_into',
    'OPTIONAL MATCH (a:users)-[:follows]->(b) WITH a, count(b) AS c UNWIND [1, 2] AS x RETURN a.id, c, x ORDER BY c DESC SKIP 1 LIMIT 5',
    'MATCH (n:users) CALL { MATCH (m:orders) RETURN count(m) AS c } RETURN n.id, c',
  ];
  for (const query of reads) {
    const result = await client.callTool(cypher({ cypher: query, params: { since: '2026-01-01' } }));
    assert.notEqual(result.isError, true, `${query}: ${result.content[0].text}`);
  }
  assert.deepEqual(requests.map(r => r.body.cypher), reads);
});

test('a graph query is a read: it is resent once after HTTP 503 with Retry-After', { timeout }, async t => {
  const { client, requests } = await connect(t, (request, res) => {
    if (request.index === 0) res.writeHead(503, { 'retry-after': '0' }).end('{"error":"warming"}');
    else res.end(JSON.stringify(ROWS));
  });
  const result = await client.callTool(cypher({ cypher: 'MATCH (n:users) RETURN n.email' }));
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, requests[0].body);
});
