// Guard: this repository documents and uses one application path, HTTPS to OC_URL
// with OC_TOKEN. It fails if a retired connection name or a database-client (wire
// protocol) term appears anywhere in it, if a file outside src/config.ts and test/
// names a database id ("tenant") or the address's path, or if any tool or resource
// description does.
//
// Names are matched exactly and case-sensitively (String.prototype.includes, the
// equivalent of `grep -a -o -F` without `-i`). Two rules compare lowercased text in
// code instead: HTTP header names, which are case-insensitive on the wire, and the
// word "tenant". Every rule carries a positive control that must be flagged and a
// negative control that must not be.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
// HTTP header names are case-insensitive, so any spelling of these is a retired name.
const HEADER_NAMES = ['x-oc-db-user', 'x-oc-db-key', 'x-oc-tenant'];
// Database-client terms from the contract, plus other database-client URL schemes.
// MCP is an application path, so none is allowed anywhere here, exempt files included.
export const WIRE_TERMS = ['psycopg', 'node-postgres', 'postgresql://', 'PGPASSWORD', ':5432', 'sslmode',
  'postgres://', 'mysql://', 'sqlserver://'];
// Nothing may depend on the address's shape: only the one-release fallback in
// src/config.ts builds it, and only tests use today's shape as an opaque fixture.
const ADDRESS_SHAPE = '/v1/tenants/';
const mayNameAddressShape = rel => rel === 'src/config.ts' || rel.startsWith('test/');

// Exactly the retired names each file needs: src/config.ts reads or rejects them for
// one release, and test/retired-names.test.mjs proves that. Any other retired name in
// those files, or any retired name elsewhere, is a violation.
const ALLOWED = {
  'src/config.ts': ['OC_HOST', 'OC_TENANT', 'OC_DB_USER', 'OC_DB_KEY', '/v1/tenants/$'],
  'test/retired-names.test.mjs': ['OC_HOST', 'OC_TENANT', 'OC_DB_USER', 'OC_DB_KEY',
    'X-OC-DB-User', 'x-oc-db-user', 'X-OC-DB-Key', 'x-oc-db-key', 'X-OC-Tenant', 'x-oc-tenant'],
};
// This file holds the lists themselves.
const SELF = 'test/access-terms.test.mjs';
// Build output and caches; everything else is read, and a file it cannot read fails the guard.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release-package', '__pycache__']);

const hitsIn = (text, terms) => terms.filter(term => text.includes(term));

/** Text of a file, decoding UTF-16 by its byte-order mark; null for other files containing NUL. */
function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return swapped.swap16().toString('utf16le');
  }
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

function scanText(text) {
  const lower = text.toLowerCase();
  const never = [...new Set([...hitsIn(text, NEVER_ACCESS), ...hitsIn(lower, HEADER_NAMES)])];
  const shape = [...hitsIn(text, [ADDRESS_SHAPE]), ...(lower.includes('tenant') ? ['tenant'] : [])];
  return { never, wire: hitsIn(text, WIRE_TERMS), shape };
}

async function scanFile(path) {
  const text = decode(await readFile(path));
  return text === null ? null : scanText(text);
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

/** Returns { scanned, skipped, violations } for the tree at `root`. */
export async function guard(root) {
  const scanned = [];
  const skipped = [];
  const violations = [];
  for (const file of await listFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === SELF) continue;
    const hits = await scanFile(file);
    if (!hits) { skipped.push(rel); continue; }
    scanned.push(rel);
    const never = hits.never.filter(term => !(ALLOWED[rel] ?? []).includes(term));
    const shape = mayNameAddressShape(rel) ? [] : hits.shape;
    if (never.length || hits.wire.length || shape.length) violations.push({ file: rel, never, wire: hits.wire, shape });
  }
  return { scanned, skipped, violations };
}

async function tree(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-access-terms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return guard(dir);
}
const flaggedIn = (violations, file) => violations.find(v => v.file === file) ?? { never: [], wire: [], shape: [] };

test('positive control: every listed term is flagged in a fixture file', async t => {
  const terms = [...NEVER_ACCESS, ...WIRE_TERMS];
  const { scanned, skipped, violations } = await tree(t,
    Object.fromEntries(terms.map((term, index) => [`fixture-${index}.md`, `before ${term} after\n`])));
  assert.equal(scanned.length, terms.length);
  assert.deepEqual(skipped, []);
  const flagged = violations.flatMap(v => [...v.never, ...v.wire]);
  for (const term of terms) assert.ok(flagged.includes(term), `guard missed ${term}`);
});

test('positive control: header names in any letter case are flagged', async t => {
  const { violations } = await tree(t, { 'a.md': 'send X-Oc-Db-User', 'b.md': 'X-OC-TENANT: t', 'c.ts': "'x-Oc-Db-Key'" });
  assert.deepEqual(flaggedIn(violations, 'a.md').never, ['x-oc-db-user']);
  assert.deepEqual(flaggedIn(violations, 'b.md').never, ['x-oc-tenant']);
  assert.deepEqual(flaggedIn(violations, 'c.ts').never, ['x-oc-db-key']);
});

test('positive control: the address shape and the word tenant are flagged outside src/config.ts and test/', async t => {
  const { violations } = await tree(t, {
    'README.md': 'OC_URL looks like https://host/v1/tenants/<id>',
    'docs/a.md': 'set oc_tenant', 'examples/b.mjs': '// your Tenant id', 'src/index.ts': 'the tenant',
  });
  assert.deepEqual(flaggedIn(violations, 'README.md').shape, ['/v1/tenants/', 'tenant']);
  for (const file of ['docs/a.md', 'examples/b.mjs', 'src/index.ts']) assert.deepEqual(flaggedIn(violations, file).shape, ['tenant'], file);
});

test('positive control: UTF-16 files are decoded, and unreadable files are reported, not passed', async t => {
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('set OC_HOST\n', 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('set OC_HOST\n', 'utf16le').swap16()]);
  const noBom = Buffer.from('set OC_HOST\n', 'utf16le');
  const { skipped, violations } = await tree(t, { 'le.md': utf16le, 'be.md': utf16be, 'nobom.md': noBom });
  assert.deepEqual(flaggedIn(violations, 'le.md').never, ['OC_HOST']);
  assert.deepEqual(flaggedIn(violations, 'be.md').never, ['OC_HOST']);
  assert.deepEqual(skipped, ['nobom.md']);
});

test('positive control: an allowed file is flagged for any retired name outside its own list', async t => {
  const { violations } = await tree(t, {
    'src/config.ts': 'OC_HOST ORIGINCHAIN_URL oc_live_ X-OC-Tenant psycopg',
    'test/retired-names.test.mjs': 'X-OC-DB-User ORIGINCHAIN_PASSWORD',
    'test/other.test.mjs': 'OC_HOST',
  });
  assert.deepEqual(flaggedIn(violations, 'src/config.ts'),
    { file: 'src/config.ts', never: ['ORIGINCHAIN_URL', 'X-OC-Tenant', 'oc_live_', 'x-oc-tenant'], wire: ['psycopg'], shape: [] });
  assert.deepEqual(flaggedIn(violations, 'test/retired-names.test.mjs').never, ['ORIGINCHAIN_PASSWORD']);
  assert.deepEqual(flaggedIn(violations, 'test/other.test.mjs').never, ['OC_HOST']);
});

test('negative control: the application path, near-misses and the exemptions are not flagged', async t => {
  const { scanned, skipped, violations } = await tree(t, {
    'clean.md': [
      'Connect over HTTPS with two values: OC_URL (your database\'s address, from Connect) and OC_TOKEN (an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.',
      'oc_pat_example oc_host OC-HOST x-oc-probe postgres port 5432 OC_MCP_TIMEOUT_MS a postgresql database',
      'SQL tools such as psql or DBeaver connect through Connect, Database client, with their own login.',
    ].join('\n'),
    'src/config.ts': 'OC_HOST OC_TENANT OC_DB_USER OC_DB_KEY `${origin}/v1/tenants/${id}` const tenant',
    'test/fixture.test.mjs': "const base = '/v1/tenants/01hzfixture'; // today's shape, opaque; no tenant parsing",
  });
  assert.deepEqual(scanned.sort(), ['clean.md', 'src/config.ts', 'test/fixture.test.mjs']);
  assert.deepEqual(skipped, []);
  assert.deepEqual(violations, []);
});

test('repository contains no retired connection names or database-client terms', async () => {
  const { scanned, skipped, violations } = await guard(ROOT);
  // The walk must reach the files that matter, or the result below is vacuous.
  for (const file of ['README.md', 'CONTRIBUTING.md', 'examples/README.md', 'examples/client.mjs', 'src/index.ts',
    'src/http.ts', 'src/config.ts', 'package.json', '.github/workflows/test.yml', 'test/runtime-controls.test.mjs',
    'test/retired-names.test.mjs']) {
    assert.ok(scanned.includes(file), `guard did not scan ${file}`);
  }
  assert.deepEqual(skipped, [], 'the guard cannot read these files, so it cannot vouch for them');
  assert.deepEqual(violations, []);
});

test('exemption control: allowed files contain exactly their allowed names and are not reported', async () => {
  // Positive control on real files through the same scan path: if this fails, the
  // scanner cannot see retired names in the repository and the guard proves nothing.
  // Equality also keeps each list minimal: a name a file stops using leaves its list.
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    assert.deepEqual((await scanFile(resolve(ROOT, file))).never.sort(), [...allowed].sort(), file);
  }
  const config = await scanFile(resolve(ROOT, 'src/config.ts'));
  assert.deepEqual(config.shape, ['/v1/tenants/', 'tenant']);
  const { violations } = await guard(ROOT);
  assert.ok(!violations.some(v => v.file in ALLOWED));
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

// Tool and resource descriptions are what an assistant reads, so they get the strictest
// check: no retired names, no wire terms, and no mention of a database id or the
// address's path.
function descriptionProblems(text) {
  const { never, wire, shape } = scanText(text);
  return [...never, ...wire, ...shape];
}

test('positive and negative controls for the description check', () => {
  assert.deepEqual(descriptionProblems('Run a SQL statement against the OriginChain Tenant'), ['tenant']);
  assert.deepEqual(descriptionProblems('connect with psycopg using OC_HOST'), ['OC_HOST', 'psycopg']);
  assert.deepEqual(descriptionProblems('send X-Oc-Db-User to https://h/v1/tenants/1'), ['x-oc-db-user', '/v1/tenants/', 'tenant']);
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
