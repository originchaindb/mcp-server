#!/usr/bin/env node
// One-click install links for the README, generated for package.json's version:
//
//   node scripts/install-links.mjs
//
// Paste its output into the README's install section after a version bump;
// test/install-links.test.mjs fails while the README carries other links. No link
// carries a value: Cursor reads OC_URL and OC_TOKEN from the environment it starts
// in, VS Code prompts for both (the token as a password), and the Claude Code
// command takes both from the shell.
//
// Formats, from each client's own documentation:
// - Cursor, https://cursor.com/docs/context/mcp/install-links:
//   cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG,
//   where the config is the server's mcp.json entry, JSON-stringified, then base64.
//   The page's link generator gives the web form https://cursor.com/en/install-mcp?…
//   with the same query, which GitHub renders as a working link.
// - VS Code, https://code.visualstudio.com/api/extension-guides/ai/mcp:
//   vscode:mcp/install?<URL-encoded JSON of {name, ...server configuration}>, which may
//   carry `inputs`, wrapped for web pages as https://vscode.dev/redirect?url=<URL-encoded link>.
// - Claude Code, https://code.claude.com/docs/en/mcp:
//   claude mcp add [options] <name> -- <command> [args...]; the name must not directly
//   follow --env, or the CLI reads it as another KEY=value pair.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SERVER_NAME = 'originchaindb';
const PACKAGE = '@originchain-db/mcp-server';

/** The launch command every link uses: the published package at exactly `version`. */
export function launch(version) {
  return { command: 'npx', args: ['--yes', '--package', `${PACKAGE}@${version}`, 'originchain-mcp'] };
}

/** Cursor has no input prompts; `${env:NAME}` reads each value from Cursor's environment. */
export function cursorConfig(version) {
  return { ...launch(version), env: { OC_URL: '${env:OC_URL}', OC_TOKEN: '${env:OC_TOKEN}' } };
}

/** VS Code prompts for each `${input:id}` when the server first starts. */
export function vscodeConfig(version) {
  return {
    name: SERVER_NAME,
    type: 'stdio',
    ...launch(version),
    env: { OC_URL: '${input:oc_url}', OC_TOKEN: '${input:oc_token}' },
    inputs: [
      { type: 'promptString', id: 'oc_url', description: 'OC_URL: the database address, copied from Connect' },
      { type: 'promptString', id: 'oc_token', description: 'OC_TOKEN: an access token from Access tokens', password: true },
    ],
  };
}

export function installLinks(version) {
  // encodeURIComponent leaves ' ( ) ! * as they are; none may appear, so every link is
  // safe inside a Markdown link target or an HTML attribute.
  for (const config of [cursorConfig(version), vscodeConfig(version)]) {
    if (/['()!*]/.test(JSON.stringify(config))) throw new Error("install link text must not contain ' ( ) ! or *");
  }
  const config = Buffer.from(JSON.stringify(cursorConfig(version)), 'utf8').toString('base64');
  const cursorQuery = `name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(config)}`;
  const vscode = `vscode:mcp/install?${encodeURIComponent(JSON.stringify(vscodeConfig(version)))}`;
  const { command, args } = launch(version);
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?${cursorQuery}`,
    cursorWeb: `https://cursor.com/en/install-mcp?${cursorQuery}`,
    vscode,
    vscodeWeb: `https://vscode.dev/redirect?url=${encodeURIComponent(vscode)}`,
    claude: `claude mcp add --env OC_URL="$OC_URL" --env OC_TOKEN="$OC_TOKEN" --transport stdio ${SERVER_NAME} -- ${[command, ...args].join(' ')}`,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(installLinks(version), null, 2));
}
