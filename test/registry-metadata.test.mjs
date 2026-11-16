// MCP Registry metadata: package.json's mcpName and server.json, checked against the
// registry's published server.json schema (vendored in scripts/, see PUBLISHING.md)
// and against package.json. Nothing here contacts a registry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SCHEMA_SHA256, checkServerJson, schemaValidator } from '../scripts/server-json.mjs';

const text = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(await text('package.json'));
const readServer = async () => JSON.parse(await text('server.json'));
const schemaText = await text('scripts/server.schema.json');
const schema = JSON.parse(schemaText);
const copy = value => structuredClone(value);

test('package.json names the server for the registry', () => {
  assert.equal(pkg.mcpName, 'io.github.originchaindb/mcp-server');
  assert.equal(pkg.name, '@originchain-db/mcp-server');
});

test('server.json is valid against the published registry schema and matches package.json', async () => {
  const server = await readServer();
  // The vendored schema is the published 2025-12-11 file, unchanged. Line endings are
  // normalised so a Windows checkout hashes like the published file.
  assert.equal(schema.$id, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(createHash('sha256').update(Buffer.from(schemaText.replace(/\r\n/g, '\n'), 'utf8')).digest('hex'), SCHEMA_SHA256);
  assert.deepEqual(checkServerJson(server, pkg, schema), []);
  assert.equal(server.$schema, schema.$id);
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.deepEqual(server.packages.map(p => [p.registryType, p.identifier, p.version, p.transport.type]),
    [['npm', pkg.name, pkg.version, 'stdio']]);
});

test('server.json asks for OC_URL and a secret OC_TOKEN and carries no value for either', async () => {
  const server = await readServer();
  const env = Object.fromEntries(server.packages[0].environmentVariables.map(v => [v.name, v]));
  assert.equal(env.OC_URL.isRequired, true);
  assert.equal(env.OC_TOKEN.isRequired, true);
  assert.equal(env.OC_TOKEN.isSecret, true);
  for (const variable of Object.values(env)) {
    assert.equal(variable.value, undefined, variable.name);
    if (variable.isSecret) assert.equal(variable.default, undefined, variable.name);
  }
  // No token-like text anywhere in the file.
  assert.doesNotMatch(JSON.stringify(server), /oc_pat_|Bearer /);
});

test('control: the schema check rejects entries the registry would refuse', async () => {
  // Proves the validator can fail, so the empty result above means something.
  const server = await readServer();
  const validate = schemaValidator(schema);
  assert.equal(validate(server), true);
  for (const [label, mutate] of [
    ['a description over 100 characters', s => { s.description = 'x'.repeat(101); }],
    ['a name without a namespace', s => { s.name = 'mcp-server'; }],
    ['no version', s => { delete s.version; }],
    ['a package version of latest', s => { s.packages[0].version = 'latest'; }],
    ['a package without a transport', s => { delete s.packages[0].transport; }],
    ['a repository without a source', s => { delete s.repository.source; }],
  ]) {
    const broken = copy(server);
    mutate(broken);
    assert.equal(validate(broken), false, label);
    assert.notDeepEqual(checkServerJson(broken, pkg, schema), [], label);
  }
});

test('control: the package.json cross-checks fail on drift', async () => {
  const server = await readServer();
  for (const [label, mutate, expected] of [
    ['another server name', s => { s.name = 'io.github.originchaindb/other'; }, /mcpName/],
    ['another version', s => { s.version = '0.0.1'; }, /version/],
    ['another package', s => { s.packages[0].identifier = '@other/mcp-server'; }, /identifier/],
    ['another package version', s => { s.packages[0].version = '0.0.1'; }, /packages\[0\]\.version/],
    ['another registry', s => { s.packages[0].registryBaseUrl = 'https://npm.example.com'; }, /registryBaseUrl/],
    ['a token that is not secret', s => { s.packages[0].environmentVariables.find(v => v.name === 'OC_TOKEN').isSecret = false; }, /isSecret/],
    ['a token with a value', s => { s.packages[0].environmentVariables.find(v => v.name === 'OC_TOKEN').value = 'oc_pat_x'; }, /value/],
    ['no address variable', s => { s.packages[0].environmentVariables = s.packages[0].environmentVariables.filter(v => v.name !== 'OC_URL'); }, /OC_URL/],
    ['another schema version', s => { s.$schema = 'https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json'; }, /\$schema/],
  ]) {
    const broken = copy(server);
    mutate(broken);
    const problems = checkServerJson(broken, pkg, schema);
    assert.ok(problems.some(p => expected.test(p)), `${label}: ${JSON.stringify(problems)}`);
  }
});
