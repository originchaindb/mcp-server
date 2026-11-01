// Guard: this repository documents and uses one application path, HTTPS to OC_URL
// with OC_TOKEN. It fails if a retired connection name or a database-client (wire
// protocol) term appears anywhere in it, or if any tool or resource description
// mentions a database id ("tenant").
//
// Matching is exact and case-sensitive (String.prototype.includes, the equivalent of
// `grep -a -o -F` without `-i`). Every check carries a positive control that must be
// flagged and a negative control that must not be.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// From the connect contract's never_access list. Exact strings.
export const NEVER_ACCESS = [
  'ORIGINCHAIN_HOST', 'ORIGINCHAIN_PORT', 'ORIGINCHAIN_USER', 'ORIGINCHAIN_PASSWORD', 'ORIGINCHAIN_DB',
  'ORIGINCHAIN_TOKEN', 'ORIGINCHAIN_URL', 'ORIGINCHAIN_TENANT', 'ORIGINCHAIN_DB_USER', 'ORIGINCHAIN_CA',
  'OC_HOST', 'OC_TENANT', 'OC_BASE_URL', 'OC_BEARER', 'OC_API_KEY', 'OC_ENDPOINT', 'OC_DB_USER', 'OC_DB_KEY',
  'OC_DB_PASSWORD', 'OC_ES_URL', 'X-OC-DB-User', 'x-oc-db-user', 'X-OC-DB-Key', 'x-oc-db-key', 'X-OC-Tenant',
  'x-oc-tenant', '/v1/tenants/$', '/v1/tenants/{tenant}', '/v1/tenants/YOUR_TENANT', 'oc_live_',
];
// Database-client terms. MCP is an application path, so none is allowed here.
export const WIRE_TERMS = ['psycopg', 'node-postgres', 'postgresql://', 'PGPASSWORD', ':5432', 'sslmode'];

// Files that may contain NEVER_ACCESS names: the library reads or rejects them for one
// release, and one test proves that. Wire terms are still checked in these files.
const NEVER_ACCESS_EXEMPT = new Set(['src/config.ts', 'test/retired-names.test.mjs']);
// This file holds the lists themselves.
const SELF = 'test/access-terms.test.mjs';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release-package']);

const hitsIn = (text, terms) => terms.filter(term => text.includes(term));

async function scanFile(path) {
  const bytes = await readFile(path);
  if (bytes.includes(0)) return null; // binary
  const text = bytes.toString('utf8');
  return { never: hitsIn(text, NEVER_ACCESS), wire: hitsIn(text, WIRE_TERMS) };
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...await listFiles(join(dir, entry.name)));
    } else if (entry.isFile() && !entry.name.endsWith('.tgz')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Returns { scanned, violations } for the tree at `root`. */
export async function guard(root) {
  const scanned = [];
  const violations = [];
  for (const file of await listFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === SELF) continue;
    const hits = await scanFile(file);
    if (!hits) continue;
    scanned.push(rel);
    const never = NEVER_ACCESS_EXEMPT.has(rel) ? [] : hits.never;
    if (never.length || hits.wire.length) violations.push({ file: rel, never, wire: hits.wire });
  }
  return { scanned, violations };
}

test('positive control: every listed term is flagged in a fixture file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-access-terms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [index, term] of [...NEVER_ACCESS, ...WIRE_TERMS].entries()) {
    await writeFile(join(dir, `fixture-${index}.md`), `before ${term} after\n`);
  }
  const { scanned, violations } = await guard(dir);
  assert.equal(scanned.length, NEVER_ACCESS.length + WIRE_TERMS.length);
  const flagged = violations.flatMap(v => [...v.never, ...v.wire]);
  for (const term of [...NEVER_ACCESS, ...WIRE_TERMS]) assert.ok(flagged.includes(term), `guard missed ${term}`);
});

test('negative control: the application path and near-misses are not flagged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-access-terms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'clean.md'), [
    'Connect over HTTPS with two values: OC_URL (your database\'s address, from Connect) and OC_TOKEN (an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.',
    'oc_pat_example oc_host OC-HOST x-oc-probe /v1/tenants/01hzfixture postgres port 5432 OC_MCP_TIMEOUT_MS',
  ].join('\n'));
  const { scanned, violations } = await guard(dir);
  assert.deepEqual(scanned, ['clean.md']);
  assert.deepEqual(violations, []);
});

test('repository contains no retired connection names or database-client terms', async () => {
  const { scanned, violations } = await guard(ROOT);
  // The walk must reach the files that matter, or the result below is vacuous.
  for (const file of ['README.md', 'CONTRIBUTING.md', 'examples/README.md', 'examples/client.mjs', 'src/index.ts',
    'src/http.ts', 'src/config.ts', 'package.json', 'test/runtime-controls.test.mjs', 'test/retired-names.test.mjs']) {
    assert.ok(scanned.includes(file), `guard did not scan ${file}`);
  }
  assert.deepEqual(violations, []);
});

test('exemption control: exempt files really contain retired names and are not reported', async () => {
  // Positive control on real files through the same scan path: if this fails, the
  // scanner cannot see retired names in the repository and the guard proves nothing.
  assert.ok((await scanFile(resolve(ROOT, 'src/config.ts'))).never.includes('OC_HOST'));
  assert.ok((await scanFile(resolve(ROOT, 'test/retired-names.test.mjs'))).never.includes('X-OC-DB-User'));
  const { violations } = await guard(ROOT);
  assert.ok(!violations.some(v => NEVER_ACCESS_EXEMPT.has(v.file)));
});

// The approved one-line answer, verbatim (connect contract "answer").
const ANSWER = "Connect over HTTPS with two values: OC_URL (your database's address, from Connect) and OC_TOKEN (an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.";
const answerBlock = text => /<!-- connect:begin -->\n(?:<!--[^\n]*-->\n)*([^\n]*)\n<!-- connect:end -->/.exec(text)?.[1];

test('README carries the approved one-line answer verbatim between connect markers', async () => {
  // Positive control: an edited sentence is detected; negative control: the exact one passes.
  const fixture = sentence => ['<!-- connect:begin -->', '<!-- note -->', sentence, '<!-- connect:end -->'].join('\n');
  assert.notEqual(answerBlock(fixture(ANSWER.replace('OC_TOKEN (', 'OC_TOKEN, ('))), ANSWER);
  assert.equal(answerBlock(fixture(ANSWER)), ANSWER);
  const readme = (await readFile(resolve(ROOT, 'README.md'), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(answerBlock(readme), ANSWER);
});

// Tool and resource descriptions are what an assistant reads, so they get a stricter
// check: no retired names, no wire terms, and no mention of a database id.
function descriptionProblems(text) {
  return [...hitsIn(text, NEVER_ACCESS), ...hitsIn(text, WIRE_TERMS),
    ...(text.toLowerCase().includes('tenant') ? ['tenant'] : [])];
}

test('positive and negative controls for the description check', () => {
  assert.deepEqual(descriptionProblems('Run a SQL statement against the OriginChain Tenant'), ['tenant']);
  assert.deepEqual(descriptionProblems('connect with psycopg using OC_HOST'), ['OC_HOST', 'psycopg']);
  assert.deepEqual(descriptionProblems('Run a SQL statement against the OriginChainDB database (POST $OC_URL/sql).'), []);
});

test('advertised tool and resource descriptions show only the application path', { timeout: 60000 }, async t => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OC_'))),
    OC_URL: 'http://127.0.0.1:9/v1', OC_TOKEN: 'fixture-token' };
  const client = new Client({ name: 'access-terms-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.env.MCP_SERVER_PACKAGE ? 'npx' : process.execPath,
    args: process.env.MCP_SERVER_PACKAGE
      ? ['--yes', '--package', resolve(process.env.MCP_SERVER_PACKAGE), 'originchain-mcp']
      : [resolve(ROOT, 'dist/index.js')],
    env, stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const texts = [
    ...tools.flatMap(tool => [tool.description, ...Object.values(tool.inputSchema.properties ?? {}).map(p => p.description)]),
    ...resources.flatMap(resource => [resource.name, resource.description]),
  ].filter(Boolean);
  assert.equal(tools.length, 4);
  assert.ok(texts.length >= 4 + resources.length, 'descriptions were collected');
  assert.ok(texts.some(text => text.includes('$OC_URL/sql')), 'the SQL tool names its application path');
  for (const text of texts) assert.deepEqual(descriptionProblems(text), [], text);
});
