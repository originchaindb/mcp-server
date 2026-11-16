import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [variant, readmePath, sourcePath, outputPath] = process.argv.slice(2);
assert.equal(variant, 'packed');
const readme = await readFile(readmePath, 'utf8');
// A Windows checkout has CRLF line endings; the examples read the same either way.
const examples = [...readme.replace(/\r\n/g, '\n').matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
const hostConfigs = examples.filter(example => example.mcpServers);
assert.equal(hostConfigs.length, 1, 'one mcpServers example');
const config = hostConfigs[0].mcpServers.originchaindb;
assert.equal(config.command, 'npx');
// Every other JSON example is a tools/call, run below against the fixture.
const toolCalls = examples.filter(example => example !== hostConfigs[0]);
assert.ok(toolCalls.every(call => typeof call.name === 'string' && typeof call.arguments === 'object'), 'tool call examples');
assert.deepEqual(toolCalls.map(call => call.name).sort(), ['oc_cypher', 'oc_fts_search', 'oc_sql', 'oc_sql']);
const sqlExample = toolCalls.find(call => call.name === 'oc_sql' && !call.arguments.params);
const sqlParamsExample = toolCalls.find(call => call.name === 'oc_sql' && call.arguments.params);
const ftsExample = toolCalls.find(call => call.name === 'oc_fts_search');
const graphExample = toolCalls.find(call => call.name === 'oc_cypher');
assert.ok(sqlExample && sqlParamsExample, 'a SQL example with and one without params');
const VERSION = '0.4.0';
// The README installs the published package; the packed variant runs that same command against the packed archive.
const PACKAGE_SPEC = `@originchain-db/mcp-server@${VERSION}`;
assert.deepEqual(config.args, ['--yes', '--package', PACKAGE_SPEC, 'originchain-mcp']);
// The README shows exactly the two application values.
assert.deepEqual(Object.keys(config.env), ['OC_URL', 'OC_TOKEN']);
const cases = [];
const requests = [];
const fixture = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (body?.sql === 'FAIL_AUTH') {
    res.writeHead(401).end(JSON.stringify({ error: { code: 'unauthorized', message: 'fixture denied' } }));
  } else if (body?.sql === 'RAW_TEXT') {
    res.setHeader('content-type', 'text/plain'); res.end('fixture plain text');
  } else if (req.url.endsWith('/schemas')) {
    res.end(JSON.stringify(['documents']));
  } else if (req.url.includes('/fts/')) {
    res.end(JSON.stringify(['document-1']));
  } else if (req.url.includes('/vector/')) {
    res.end(JSON.stringify([{ id: 'document-1', score: 0.9 }]));
  } else if (req.url.endsWith('/cypher')) {
    res.end(JSON.stringify({ kind: 'select', rows: [{ email: 'bob@example.com' }] }));
  } else {
    res.end(JSON.stringify({ rows: [{ value: 42 }] }));
  }
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
const base = '/v1/tenants/01hzdocsfixture0000000000000';
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))), OC_URL: `http://127.0.0.1:${address.port}${base}`, OC_TOKEN: 'fixture-token' };
delete env.OC_MCP_READONLY;

function start(overrides = {}) {
  const childEnv = { ...env, ...overrides };
  for (const name of Object.keys(childEnv)) if (childEnv[name] === undefined) delete childEnv[name];
  const command = process.env.MCP_SERVER_ENTRY ? process.execPath : config.command;
  const args = process.env.MCP_SERVER_ENTRY ? [resolve(process.env.MCP_SERVER_ENTRY)]
    : config.args.map(arg => arg === PACKAGE_SPEC ? resolve(sourcePath) : arg);
  const child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', nextId = 1;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id); clearTimeout(timer); pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      }
    }
  });
  child.on('error', err => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); } pending.clear(); });
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${stderr}`)); }, 60000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return { child, request, stderr: () => stderr,
    notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    close: async () => { child.stdin.end(); await new Promise(resolve => { const t = setTimeout(() => child.kill(), 3000); child.once('exit', () => { clearTimeout(t); resolve(); }); }); }
  };
}
function ok(name) { cases.push({ name, passed: true }); }
async function initialize(client) {
  const reply = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'readme-fixture', version: '1.0.0' } });
  assert.equal(reply.serverInfo.name, 'originchain-mcp'); assert.equal(reply.serverInfo.version, VERSION);
  client.notify('notifications/initialized');
}
function checkLast(path, method, body) {
  const last = requests.at(-1); assert.equal(last.url, base + path); assert.equal(last.method, method);
  assert.equal(last.authorization, 'Bearer fixture-token'); assert.deepEqual(last.body, body);
}
const textPayload = result => JSON.parse(result.content[0].text);
let client;
try {
  client = start(); await initialize(client); ok('README stdio command and version handshake');
  const tools = await client.request('tools/list');
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['oc_cypher','oc_fts_search','oc_list_schemas','oc_sql','oc_vector_topk']);
  ok('five advertised tool names');
  const hints = Object.fromEntries(tools.tools.map(t => [t.name, t.annotations?.readOnlyHint]));
  assert.deepEqual(hints, {oc_sql:false,oc_cypher:true,oc_fts_search:true,oc_list_schemas:true,oc_vector_topk:true});
  assert.ok(tools.tools.every(t => t.outputSchema?.type === 'object')); ok('annotations and output schemas advertised');
  let result = await client.request('tools/call', sqlExample);
  assert.deepEqual(textPayload(result).rows, [{ value: 42 }]); checkLast('/sql','POST',{sql:'SELECT 42 AS value'});
  assert.deepEqual(result.structuredContent, textPayload(result)); ok('README SQL example');
  result = await client.request('tools/call', sqlParamsExample);
  assert.deepEqual(textPayload(result).rows, [{ value: 42 }]); checkLast('/sql','POST',{sql:'SELECT id, title FROM documents WHERE id = $1',params:[7]}); ok('README SQL example with params');
  result = await client.request('tools/call', ftsExample);
  assert.deepEqual(textPayload(result), ['document-1']); checkLast('/fts/documents/body?q=release%20notes&limit=5','GET',undefined);
  assert.deepEqual(result.structuredContent, { result: ['document-1'] }); ok('README FTS example');
  result = await client.request('tools/call', graphExample);
  assert.deepEqual(result.structuredContent, { kind: 'select', rows: [{ email: 'bob@example.com' }] });
  checkLast('/cypher','POST',{cypher:'MATCH (a)-[:follows]->(b) WHERE a.id = $id RETURN b.email LIMIT 10',params:{id:'alice'},read_only:true,default_schema:'social.users'});
  ok('README graph example');
  const beforeGraphWrite = requests.length;
  result = await client.request('tools/call',{name:'oc_cypher',arguments:{cypher:'MATCH (n) DETACH DELETE n'}});
  assert.equal(result.isError,true); assert.match(result.content[0].text,/graph queries are read-only here; use oc_sql for writes/);
  assert.equal(requests.length,beforeGraphWrite); ok('graph write refused before HTTP');
  await client.request('tools/call',{name:'oc_fts_search',arguments:{table:'a/b',field:'x y',query:'a&b'}});
  checkLast('/fts/a%2Fb/x%20y?q=a%26b&limit=20','GET',undefined); ok('FTS default limit, encoding, and no mode');
  await client.request('tools/call',{name:'oc_vector_topk',arguments:{table:'a/b',vector:[0.1,0.2]}});
  checkLast('/vector/a%2Fb/topk','POST',{query:[0.1,0.2],dim:2,k:10,mode:'high_recall'}); ok('vector mapping and defaults');
  await client.request('tools/call',{name:'oc_vector_topk',arguments:{table:'docs',vector:[1,2],k:3,mode:'fast'}});
  checkLast('/vector/docs/topk','POST',{query:[1,2],dim:2,k:3,mode:'fast'}); ok('vector explicit options');
  const beforeRemovedTool = requests.length;
  result = await client.request('tools/call',{name:'oc_ask',arguments:{nl:'removed'}});
  assert.equal(result.isError,true); assert.match(result.content[0].text,/Unknown tool/);
  assert.equal(requests.length,beforeRemovedTool); ok('removed tool rejected before HTTP');
  result = await client.request('tools/call',{name:'oc_list_schemas',arguments:{}});
  assert.deepEqual(textPayload(result), ['documents']); checkLast('/schemas','GET',undefined); ok('schema discovery tool');
  const resources = await client.request('resources/list'); assert.equal(resources.resources[0].uri,'originchain://schemas');
  result = await client.request('resources/read',{uri:'originchain://schemas'});
  assert.equal(result.contents[0].mimeType,'application/json'); assert.deepEqual(JSON.parse(result.contents[0].text),['documents']); ok('schema resource read');
  result = await client.request('tools/call',{name:'oc_sql',arguments:{sql:'FAIL_AUTH'}});
  assert.equal(result.isError,true); assert.match(result.content[0].text,/401/); assert.match(result.content[0].text,/fixture denied/); ok('HTTP status and body returned as tool error');
  const count = requests.length;
  result = await client.request('tools/call',{name:'oc_sql',arguments:{sql:42}});
  assert.equal(result.isError,true); assert.equal(requests.length,count); ok('invalid SQL argument rejected before HTTP');
  result = await client.request('tools/call',{name:'oc_sql',arguments:{sql:'RAW_TEXT'}});
  assert.equal(result.content[0].text,'fixture plain text'); ok('non-JSON response unchanged');
  await client.request('tools/call',{name:'oc_sql',arguments:{sql:'DELETE FROM fixture_only WHERE id = 1'}});
  checkLast('/sql','POST',{sql:'DELETE FROM fixture_only WHERE id = 1'}); ok('default SQL forwards writes to mock only');
  assert.match(client.stderr(),/ready; request timeout=/); assert.doesNotMatch(client.stderr(),/WARNING/); ok('README configuration prints no retired-setting warning');
  await client.close(); client = start({OC_MCP_READONLY:'true'}); await initialize(client);
  const before = requests.length;
  result = await client.request('tools/call',sqlExample);
  assert.notEqual(result.isError,true); assert.equal(requests.length,before+1); checkLast('/sql','POST',{sql:'SELECT 42 AS value'}); ok('read-only SQL forwards ordinary SELECT');
  result = await client.request('tools/call',{name:'oc_sql',arguments:{sql:'SELECT 1; DELETE FROM fixture_only'}});
  assert.equal(result.isError,true); assert.equal(requests.length,before+1); ok('read-only SQL refuses a second statement before HTTP');
  await client.request('tools/call',{name:'oc_list_schemas',arguments:{}});
  checkLast('/schemas','GET',undefined); ok('SQL flag preserves schema discovery');
  await client.close(); client = undefined;
  const missing = start({OC_TOKEN:undefined});
  const exitCode = await new Promise((resolve,reject) => { const t=setTimeout(()=>{missing.child.kill();reject(new Error('missing token did not exit'));},30000); missing.child.once('exit',code=>{clearTimeout(t);resolve(code);}); });
  assert.equal(exitCode,1); assert.match(missing.stderr(),/OC_TOKEN is required and missing/); ok('missing required environment fails at startup');
  await writeFile(outputPath, JSON.stringify({variant,node:process.version,readme_sha256:createHash('sha256').update(readme).digest('hex'),package_version:VERSION,cases,all_passed:true,http_requests:requests.length,scope:'Local HTTP fixture; no live database or credentials'},null,2)+'\n');
  console.log(JSON.stringify({variant,node:process.version,passed:cases.length}));
} finally {
  if(client) await client.close();
  await new Promise(r=>fixture.close(r));
}
