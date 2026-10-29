import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const operation = process.argv[2];
if (!operation || operation === '--help') {
  console.log('Usage: node examples/client.mjs sql|schemas|fts|vector');
  console.log('Connection: OC_HOST, OC_TENANT, OC_TOKEN. See examples/README.md for fixtures.');
  process.exit(0);
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}
for (const name of ['OC_HOST', 'OC_TENANT', 'OC_TOKEN']) required(name);
let name, args;
switch (operation) {
  case 'sql': name = 'oc_sql'; args = { sql: 'SELECT 1 AS value' }; break;
  case 'schemas': name = 'oc_list_schemas'; args = {}; break;
  case 'fts':
    name = 'oc_fts_search';
    args = { table: required('OC_TABLE'), field: required('OC_FTS_FIELD'), query: required('OC_QUERY'), limit: 5 };
    break;
  case 'vector': {
    const vector = JSON.parse(required('OC_QUERY_VECTOR'));
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(x => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error('OC_QUERY_VECTOR must be a nonempty array of finite numbers');
    }
    name = 'oc_vector_topk'; args = { table: required('OC_TABLE'), vector, k: 5, mode: 'high_recall' };
    break;
  }
  default: throw new Error('Expected sql, schemas, fts or vector');
}
const archive = process.env.MCP_SERVER_PACKAGE;
const transport = new StdioClientTransport({
  command: archive ? 'npx' : process.execPath,
  args: archive ? ['--yes', '--package', resolve(archive), 'originchain-mcp']
    : [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client({ name: 'originchaindb-example', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (!tools.some(tool => tool.name === name)) throw new Error(`Server does not advertise ${name}`);
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  for (const item of result.content) if (item.type === 'text') console.log(item.text);
} catch {
  console.error('MCP request failed. Check connection, permissions and example inputs.');
  process.exitCode = 1;
} finally {
  await client.close();
}
