// Tool titles and annotations: what a host reads to decide how to show a tool and
// whether to ask before running it. Hints are advice to the host, not enforcement;
// what each hint promises is enforced by the server tests elsewhere.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const timeout = 60000;

// No request is made: listing tools never reaches OC_URL.
async function listTools(t, overrides = {}) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))),
    OC_URL: 'http://127.0.0.1:9/db/annotations-fixture', OC_TOKEN: 'fixture-token', ...overrides };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  const client = new Client({ name: 'annotations-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.env.MCP_SERVER_PACKAGE ? 'npx' : process.execPath,
    args: process.env.MCP_SERVER_PACKAGE
      ? ['--yes', '--package', resolve(process.env.MCP_SERVER_PACKAGE), 'originchain-mcp']
      : [resolve('dist/index.js')],
    env, stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  return Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
}

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
// A database is a closed domain, so no tool is open-world.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const READ_TOOLS = {
  oc_list_schemas: 'List schemas',
  oc_vector_topk: 'Vector similarity search',
  oc_fts_search: 'Full-text search',
  oc_cypher: 'Read-only graph query',
};

test('every tool has a title and sets all four annotation hints explicitly', { timeout }, async t => {
  const tools = await listTools(t);
  assert.deepEqual(Object.keys(tools).sort(), ['oc_cypher', 'oc_fts_search', 'oc_list_schemas', 'oc_sql', 'oc_vector_topk']);
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.title, 'string', tool.name);
    assert.equal(tool.annotations?.title, tool.title, tool.name);
    // Every hint is a boolean the host can read; none is left to the spec's defaults
    // (a missing destructiveHint means "destructive" and a missing openWorldHint "open world").
    for (const hint of HINTS) assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} ${hint}`);
  }
});

test('the search, list and graph tools are annotated read-only', { timeout }, async t => {
  const tools = await listTools(t);
  for (const [name, title] of Object.entries(READ_TOOLS)) {
    assert.deepEqual(tools[name].annotations, { title, ...READ_ONLY }, name);
  }
});

test('oc_sql is annotated as a destructive write by default', { timeout }, async t => {
  const { oc_sql } = await listTools(t);
  assert.deepEqual(oc_sql.annotations, { title: 'Run SQL', ...WRITES });
  assert.equal(oc_sql.title, 'Run SQL');
  assert.match(oc_sql.description, /forwards statements, including writes/);
});

test('OC_MCP_READONLY=true annotates oc_sql read-only and its description says so', { timeout }, async t => {
  const tools = await listTools(t, { OC_MCP_READONLY: 'true' });
  assert.deepEqual(tools.oc_sql.annotations, { title: 'Run read-only SQL', ...READ_ONLY });
  assert.match(tools.oc_sql.description, /^Run a read-only SQL query/);
  assert.match(tools.oc_sql.description, /OC_MCP_READONLY=true is set, so this tool is read-only/);
  assert.doesNotMatch(tools.oc_sql.description, /including writes/);
  // The setting changes only oc_sql.
  for (const [name, title] of Object.entries(READ_TOOLS)) {
    assert.deepEqual(tools[name].annotations, { title, ...READ_ONLY }, name);
  }
});

for (const value of ['TRUE', '1', 'yes', '']) {
  test(`OC_MCP_READONLY=${JSON.stringify(value)} leaves oc_sql annotated as a write`, { timeout }, async t => {
    // Control for the test above: only the exact value `true` switches the mode.
    const { oc_sql } = await listTools(t, { OC_MCP_READONLY: value });
    assert.deepEqual(oc_sql.annotations, { title: 'Run SQL', ...WRITES });
  });
}
