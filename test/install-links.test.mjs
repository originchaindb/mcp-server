// One-click install links in the README: each one is decoded here, independently of
// scripts/install-links.mjs, and must launch the pinned package with exactly OC_URL
// and OC_TOKEN, both taken from the user (an input prompt or the environment) and
// never carried in the link.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { installLinks } from '../scripts/install-links.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const SPEC = `@originchain-db/mcp-server@${pkg.version}`;
const LAUNCH = { command: 'npx', args: ['--yes', '--package', SPEC, 'originchain-mcp'] };
const ENV_NAMES = ['OC_URL', 'OC_TOKEN'];

const only = (matches, label) => {
  assert.equal(matches.length, 1, `exactly one ${label} in the README`);
  return matches[0];
};
// Markdown link targets end at ")" or whitespace; every link here is percent-encoded.
const cursorLink = text => only([...text.matchAll(/https:\/\/cursor\.com\/en\/install-mcp\?[^)\s]+/g)].map(m => m[0]), 'Add to Cursor link');
const vscodeLink = text => only([...text.matchAll(/https:\/\/vscode\.dev\/redirect\?[^)\s]+/g)].map(m => m[0]), 'Add to VS Code link');
const claudeLine = text => only([...text.matchAll(/^claude mcp add .*$/gm)].map(m => m[0]), 'Claude Code command');

function decodeCursor(link) {
  const url = new URL(link);
  assert.deepEqual([...url.searchParams.keys()], ['name', 'config']);
  return { name: url.searchParams.get('name'), config: JSON.parse(Buffer.from(url.searchParams.get('config'), 'base64').toString('utf8')) };
}
function decodeVscode(link) {
  const url = new URL(link);
  assert.deepEqual([...url.searchParams.keys()], ['url']);
  const target = url.searchParams.get('url');
  const prefix = 'vscode:mcp/install?';
  assert.ok(target.startsWith(prefix), target);
  return JSON.parse(decodeURIComponent(target.slice(prefix.length)));
}
// Splits a POSIX shell line into words; double quotes group, and stay visible so a
// variable reference can be told from a literal value.
function shellWords(line) {
  assert.doesNotMatch(line, /['\\`;|&<>]/, 'the command uses no quoting or operators this check does not model');
  return line.match(/(?:[^\s"]+|"[^"]*")+/g);
}
function decodeClaude(line) {
  const words = shellWords(line);
  const split = words.indexOf('--');
  const options = words.slice(3, split);
  const env = {};
  const rest = [];
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--env' || options[i] === '-e') {
      const [name, ...value] = options[++i].split('=');
      env[name] = value.join('=');
    } else rest.push(options[i]);
  }
  return { prefix: words.slice(0, 3), options: rest, env, command: words[split + 1], args: words.slice(split + 2) };
}

// A value is safe only when it is a reference the host resolves at launch.
const REFERENCE = {
  cursor: (name, value) => value === `\${env:${name}}`,
  vscode: (name, value, inputs) => /^\$\{input:([a-z_]+)\}$/.test(value) && inputs.some(i => `\${input:${i.id}}` === value),
  claude: (name, value) => value === `"$${name}"`,
};
function secretProblems(kind, env, inputs = []) {
  const problems = [];
  for (const [name, value] of Object.entries(env)) {
    if (!REFERENCE[kind](name, value, inputs)) problems.push(`${name} carries a value`);
  }
  if (/oc_pat_|Bearer /.test(JSON.stringify({ env, inputs }))) problems.push('token-like text');
  for (const input of inputs) if ('default' in input) problems.push(`input ${input.id} has a default`);
  return problems;
}
// Control, run on each decoded link: the same check flags that link once a value is
// put in, so its empty result is not a check that cannot fire.
function assertCheckCanFail(kind, env, inputs = []) {
  for (const name of Object.keys(env)) {
    assert.deepEqual(secretProblems(kind, { ...env, [name]: 'oc_pat_example' }, inputs),
      [`${name} carries a value`, 'token-like text'], `${kind} ${name}`);
    assert.deepEqual(secretProblems(kind, { ...env, [name]: 'https://db.example.com' }, inputs), [`${name} carries a value`]);
  }
  if (kind === 'vscode') {
    // A reference to an input that is not declared is a value, not a prompt; a default is a value too.
    assert.notDeepEqual(secretProblems(kind, env, []), []);
    assert.deepEqual(secretProblems(kind, env, inputs.map(input => ({ ...input, default: 'x' }))),
      inputs.map(input => `input ${input.id} has a default`));
  }
  if (kind === 'claude') assert.deepEqual(secretProblems(kind, { ...env, OC_TOKEN: '"$OC_URL"' }), ['OC_TOKEN carries a value']);
}

test('Add to Cursor launches the pinned package with OC_URL and OC_TOKEN from the environment', () => {
  const { name, config } = decodeCursor(cursorLink(readme));
  assert.equal(name, 'originchaindb');
  assert.deepEqual({ command: config.command, args: config.args }, LAUNCH);
  assert.deepEqual(Object.keys(config.env), ENV_NAMES);
  assert.deepEqual(config.env, { OC_URL: '${env:OC_URL}', OC_TOKEN: '${env:OC_TOKEN}' });
  assert.deepEqual(Object.keys(config).sort(), ['args', 'command', 'env']);
  assert.deepEqual(secretProblems('cursor', config.env), []);
  assertCheckCanFail('cursor', config.env);
});

test('Add to VS Code launches the pinned package and prompts for OC_URL and, as a password, OC_TOKEN', () => {
  const config = decodeVscode(vscodeLink(readme));
  assert.equal(config.name, 'originchaindb');
  assert.equal(config.type, 'stdio');
  assert.deepEqual({ command: config.command, args: config.args }, LAUNCH);
  assert.deepEqual(Object.keys(config.env), ENV_NAMES);
  assert.deepEqual(config.env, { OC_URL: '${input:oc_url}', OC_TOKEN: '${input:oc_token}' });
  const inputs = Object.fromEntries(config.inputs.map(input => [input.id, input]));
  assert.deepEqual(Object.keys(inputs), ['oc_url', 'oc_token']);
  for (const input of config.inputs) {
    assert.equal(input.type, 'promptString');
    assert.ok(input.description.length > 0);
    // The properties VS Code accepts for a promptString in an install link.
    assert.ok(Object.keys(input).every(key => ['id', 'type', 'description', 'default', 'password'].includes(key)), input.id);
  }
  assert.equal(inputs.oc_token.password, true);
  assert.notEqual(inputs.oc_url.password, true);
  assert.deepEqual(secretProblems('vscode', config.env, config.inputs), []);
  assertCheckCanFail('vscode', config.env, config.inputs);
});

test('the Claude Code command adds the pinned package with OC_URL and OC_TOKEN from the shell', () => {
  const command = decodeClaude(claudeLine(readme));
  assert.deepEqual(command.prefix, ['claude', 'mcp', 'add']);
  // The server name must not follow --env directly, or the CLI reads it as another pair.
  assert.deepEqual(command.options, ['--transport', 'stdio', 'originchaindb']);
  assert.deepEqual({ command: command.command, args: command.args }, LAUNCH);
  assert.deepEqual(Object.keys(command.env), ENV_NAMES);
  assert.deepEqual(secretProblems('claude', command.env), []);
  assertCheckCanFail('claude', command.env);
});

test('the README links are the ones scripts/install-links.mjs generates for this version', () => {
  // Fails after a version bump until the README is regenerated.
  const links = installLinks(pkg.version);
  assert.equal(cursorLink(readme), links.cursorWeb);
  assert.equal(vscodeLink(readme), links.vscodeWeb);
  assert.equal(claudeLine(readme), links.claude);
  // The deep links the web links open carry the same configuration.
  assert.deepEqual(decodeCursor(links.cursor.replace('cursor://anysphere.cursor-deeplink/mcp/install', 'https://cursor.com/en/install-mcp')),
    decodeCursor(links.cursorWeb));
  assert.equal(new URL(links.vscodeWeb).searchParams.get('url'), links.vscode);
  // Control: the README extraction and decoders read a link that does carry a token,
  // through the same path, and the check flags it.
  const leaked = links.cursorWeb.replace(/config=[^&]+/, `config=${encodeURIComponent(Buffer.from(JSON.stringify(
    { ...LAUNCH, env: { OC_URL: '${env:OC_URL}', OC_TOKEN: 'oc_pat_example' } })).toString('base64'))}`);
  assert.deepEqual(secretProblems('cursor', decodeCursor(cursorLink(`[x](${leaked})`)).config.env), ['OC_TOKEN carries a value', 'token-like text']);
});
