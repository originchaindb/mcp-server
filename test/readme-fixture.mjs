import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [variant, readmePath, sourcePath, outputPath] = process.argv.slice(2);
assert.equal(variant, 'packed');
const readme = await readFile(readmePath, 'utf8');
const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
const config = examples[0].mcpServers.originchaindb;
assert.equal(config.command, 'npx');
assert.deepEqual(config.args, ['--yes', '--package', 'https://github.com/originchaindb/mcp-server/releases/download/v0.1.3-rc.1/originchain-mcp-server-0.1.3-rc.1.tgz', 'originchain-mcp']);
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
  } else if (req.url.endsWith('/ask')) {
    res.end(JSON.stringify({ plan: 'fixture', plan_only: body.plan_only ?? false }));
  } else {
    res.end(JSON.stringify({ rows: [{ value: 42 }] }));
  }
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const address = fixture.address();
const env = { ...process.env, OC_HOST: `http://127.0.0.1:${address.port}`, OC_TENANT: 'docs tenant', OC_TOKEN: 'fixture-token' };
delete env.OC_MCP_READONLY;
const base = '/v1/tenants/docs%20tenant';

function start(overrides = {}) {
  const childEnv = { ...env, ...overrides };
  for (const name of Object.keys(childEnv)) if (childEnv[name] === undefined) delete childEnv[name];
  const command = config.command;
  const args = config.args.map(arg => arg.startsWith('https://github.com/') ? resolve(sourcePath) : arg);
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
  assert.equal(reply.serverInfo.name, 'originchain-mcp'); assert.equal(reply.serverInfo.version, '0.1.3-rc.1');
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
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['oc_ask','oc_fts_search','oc_list_schemas','oc_sql','oc_vector_topk']);
  ok('five advertised tool names');
  let result = await client.request('tools/call', examples[1]);
  assert.deepEqual(textPayload(result).rows, [{ value: 42 }]); checkLast('/sql','POST',{sql:'SELECT 42 AS value'}); ok('README SQL example');
  result = await client.request('tools/call', examples[2]);
  assert.deepEqual(textPayload(result), ['document-1']); checkLast('/fts/documents/body?q=release%20notes&limit=5','GET',undefined); ok('README FTS example');
  await client.request('tools/call',{name:'oc_fts_search',arguments:{table:'a/b',field:'x y',query:'a&b'}});
  checkLast('/fts/a%2Fb/x%20y?q=a%26b&limit=20','GET',undefined); ok('FTS default limit, encoding, and no mode');
  await client.request('tools/call',{name:'oc_vector_topk',arguments:{table:'a/b',vector:[0.1,0.2]}});
  checkLast('/vector/a%2Fb/topk','POST',{query:[0.1,0.2],dim:2,k:10,mode:'high_recall'}); ok('vector mapping and defaults');
  await client.request('tools/call',{name:'oc_vector_topk',arguments:{table:'docs',vector:[1,2],k:3,mode:'fast'}});
  checkLast('/vector/docs/topk','POST',{query:[1,2],dim:2,k:3,mode:'fast'}); ok('vector explicit options');
  await client.request('tools/call',{name:'oc_ask',arguments:{nl:'Show a plan',plan_only:true}});
  checkLast('/ask','POST',{nl:'Show a plan',plan_only:true}); ok('Ask plan-only mapping');
  await client.request('tools/call',{name:'oc_ask',arguments:{nl:'Run a query'}});
  checkLast('/ask','POST',{nl:'Run a query'}); ok('Ask default does not add plan-only');
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
  await client.close(); client = start({OC_MCP_READONLY:'true'}); await initialize(client);
  const before = requests.length;
  result = await client.request('tools/call',examples[1]);
  assert.notEqual(result.isError,true); assert.equal(requests.length,before+1); checkLast('/sql','POST',{sql:'SELECT 42 AS value'}); ok('fixed SQL-prefix filter forwards ordinary SELECT');
  await client.request('tools/call',{name:'oc_ask',arguments:{nl:'Run a query'}});
  checkLast('/ask','POST',{nl:'Run a query'}); ok('SQL flag does not restrict Ask');
  await client.close(); client = undefined;
  const missing = start({OC_TOKEN:undefined});
  const exitCode = await new Promise((resolve,reject) => { const t=setTimeout(()=>{missing.child.kill();reject(new Error('missing token did not exit'));},30000); missing.child.once('exit',code=>{clearTimeout(t);resolve(code);}); });
  assert.equal(exitCode,1); assert.match(missing.stderr(),/OC_TOKEN is required and missing/); ok('missing required environment fails at startup');
  await writeFile(outputPath, JSON.stringify({variant,node:process.version,readme_sha256:createHash('sha256').update(readme).digest('hex'),package_version:'0.1.3-rc.1',cases,all_passed:true,http_requests:requests.length,scope:'Local HTTP fixture; no live tenant or credentials'},null,2)+'\n');
  console.log(JSON.stringify({variant,node:process.version,passed:cases.length}));
} finally {
  if(client) await client.close();
  await new Promise(r=>fixture.close(r));
}
