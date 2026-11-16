#!/usr/bin/env node
// Checks server.json, this server's MCP Registry entry, against the registry's
// published server.json schema and against package.json. It never publishes.
//
//   node scripts/server-json.mjs          check against the vendored schema
//   node scripts/server-json.mjs --live   also fetch the schema server.json names and
//                                         report whether the vendored copy is current
//
// scripts/server.schema.json is the registry's published schema, byte for byte, from
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
// (source: github.com/modelcontextprotocol/registry, docs/reference/server-json;
// Apache-2.0 or MIT, see that repository's LICENSE). Replace it, and SCHEMA_SHA256,
// only together with server.json's `$schema`.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/** sha256 of the published schema file (LF line endings). */
export const SCHEMA_SHA256 = '3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const ENV_REQUIRED = ['OC_URL', 'OC_TOKEN'];

/** A validator for the registry schema (draft-07; it uses the non-standard `example` keyword, hence strict: false). */
export function schemaValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Problems with `server` as this package's registry entry; empty when there are none. */
export function checkServerJson(server, pkg, schema) {
  const problems = [];
  const validate = schemaValidator(schema);
  if (!validate(server)) {
    for (const error of validate.errors) problems.push(`schema: ${error.instancePath || '/'} ${error.message}`);
  }
  if (server.$schema !== schema.$id) problems.push(`$schema must be ${schema.$id}`);
  if (server.name !== pkg.mcpName) problems.push('name must equal package.json mcpName (the registry checks the published package)');
  if (server.version !== pkg.version) problems.push('version must equal package.json version');
  const repository = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  if (server.repository?.url !== repository) problems.push('repository.url must match package.json repository');
  const packages = Array.isArray(server.packages) ? server.packages : [];
  if (packages.length !== 1) problems.push('packages must list exactly the npm package');
  packages.forEach((entry, index) => {
    const at = `packages[${index}]`;
    if (entry.registryType !== 'npm') problems.push(`${at}.registryType must be npm`);
    if (entry.registryBaseUrl !== undefined && entry.registryBaseUrl !== NPM_REGISTRY) {
      problems.push(`${at}.registryBaseUrl must be ${NPM_REGISTRY}, the only npm registry the official registry accepts`);
    }
    if (entry.identifier !== pkg.name) problems.push(`${at}.identifier must equal package.json name`);
    if (entry.version !== pkg.version) problems.push(`${at}.version must equal package.json version`);
    if (entry.transport?.type !== 'stdio') problems.push(`${at}.transport.type must be stdio`);
    const variables = Array.isArray(entry.environmentVariables) ? entry.environmentVariables : [];
    const byName = Object.fromEntries(variables.map(variable => [variable.name, variable]));
    for (const name of ENV_REQUIRED) {
      if (byName[name]?.isRequired !== true) problems.push(`${at} must list ${name} as a required environment variable`);
    }
    if (byName.OC_TOKEN && byName.OC_TOKEN.isSecret !== true) problems.push(`${at} must mark OC_TOKEN isSecret`);
    for (const variable of variables) {
      if (variable.value !== undefined) problems.push(`${at} ${variable.name} must not carry a value`);
      if (variable.isSecret && variable.default !== undefined) problems.push(`${at} ${variable.name} is secret and must not carry a default value`);
    }
  });
  return problems;
}

const sha256 = text => createHash('sha256').update(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')).digest('hex');

async function main(argv) {
  const read = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [serverText, pkgText, schemaText] = await Promise.all([read('server.json'), read('package.json'), read('scripts/server.schema.json')]);
  const server = JSON.parse(serverText);
  const pkg = JSON.parse(pkgText);
  const problems = checkServerJson(server, pkg, JSON.parse(schemaText));
  if (sha256(schemaText) !== SCHEMA_SHA256) problems.push('scripts/server.schema.json is not the published schema file');
  if (argv.includes('--live')) {
    const response = await fetch(server.$schema, { redirect: 'error' });
    if (!response.ok) throw new Error(`fetching ${server.$schema}: HTTP ${response.status}`);
    const liveText = await response.text();
    const live = JSON.parse(liveText);
    for (const problem of checkServerJson(server, pkg, live)) problems.push(`live schema: ${problem}`);
    console.log(sha256(liveText) === SCHEMA_SHA256
      ? `live schema ${server.$schema} matches the vendored copy`
      : `live schema ${server.$schema} differs from the vendored copy (sha256 ${sha256(liveText)})`);
  }
  for (const problem of problems) console.error(`server.json: ${problem}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`server.json is valid: ${server.name} ${server.version}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2));
}
