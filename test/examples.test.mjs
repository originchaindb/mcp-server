import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
test('documented MCP client calls four read operations through stdio', { timeout: 180000 }, async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    if (req.headers.authorization === 'Bearer rejected-fixture-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized', message: 'fixture-private-row-marker' } }));
      return;
    }
    const payload = req.url.endsWith('/sql') ? { rows: [{ value: 1 }] }
      : req.url.endsWith('/schemas') ? ['sample.items']
      : req.url.includes('/fts/') ? ['item-1'] : [{ id: 'item-1', score: 0.9 }];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OC_'))),
    OC_HOST: `http://127.0.0.1:${server.address().port}`, OC_TENANT: 'fixture', OC_TOKEN: 'fixture-token',
    OC_DB_USER: 'fixture-user', OC_DB_KEY: 'fixture-key', OC_TABLE: 'sample.items',
    OC_FTS_FIELD: 'body', OC_QUERY: 'tea & mug', OC_QUERY_VECTOR: '[1,0]' };
  const script = fileURLToPath(new URL('../examples/client.mjs', import.meta.url));
  const run = (operation, overrides = {}) => exec(process.execPath, [script, operation], { env: { ...env, ...overrides }, timeout: 45000 });
  try {
    const outputs = {};
    for (const operation of ['sql', 'schemas', 'fts', 'vector']) outputs[operation] = JSON.parse((await run(operation)).stdout);
    assert.deepEqual(outputs, { sql: { rows: [{ value: 1 }] }, schemas: ['sample.items'], fts: ['item-1'], vector: [{ id: 'item-1', score: 0.9 }] });
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(r => r.method), ['POST', 'GET', 'GET', 'POST']);
    const base = '/v1/tenants/fixture';
    assert.deepEqual(requests.map(r => r.url), [base + '/sql', base + '/schemas', base + '/fts/sample.items/body?q=tea%20%26%20mug&limit=5', base + '/vector/sample.items/topk']);
    assert.deepEqual(requests[0].body, { sql: 'SELECT 1 AS value' });
    assert.deepEqual(requests[3].body, { query: [1,0], dim: 2, k: 5, mode: 'high_recall' });
    for (const { headers } of requests) {
      assert.equal(headers.authorization, 'Bearer fixture-token');
      assert.equal(headers['x-oc-db-user'], 'fixture-user');
      assert.equal(headers['x-oc-db-key'], 'fixture-key');
    }
    await run('--help');
    await assert.rejects(run('vector', { OC_QUERY_VECTOR: '[true]' }));
    await assert.rejects(run('sql', { OC_TOKEN: '' }));
    assert.equal(requests.length, 4);
    await assert.rejects(run('sql', { OC_TOKEN: 'rejected-fixture-token' }), error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /MCP request failed/);
      assert.doesNotMatch(error.stdout + error.stderr, /fixture-private-row-marker|rejected-fixture-token/);
      return true;
    });
    assert.equal(requests.length, 5, 'failed request must not retry');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
