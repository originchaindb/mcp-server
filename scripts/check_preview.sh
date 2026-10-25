#!/usr/bin/env bash
# Shared by PR verification and promotion: no publish capability or database secrets.
set -euo pipefail
workspace="$PWD"
directory="$(realpath "$1")"
source="$(realpath "$2")"
runtime="$3"
archive="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive"])' "$directory/selected-preview.json")"
export MCP_SERVER_PACKAGE="$directory/$archive"
npm ci --prefix "$source"
npm run build --prefix "$source"
python scripts/release_preview.py verify-source "$directory" "$source"
consumer="$(mktemp -d "$RUNNER_TEMP/mcp-consumer.XXXXXX")"
cd "$consumer"
npm init -y
npm install --ignore-scripts "$MCP_SERVER_PACKAGE"
npm audit --json > "$directory/audit-node$runtime.json"
node --test --test-concurrency=1 "$source"/test/*.test.mjs | tee "$directory/tests-node$runtime.log"
node "$source/test/readme-fixture.mjs" packed "$source/README.md" "$MCP_SERVER_PACKAGE" "$directory/readme-node$runtime.json"
MCP_SERVER_ENTRY="$consumer/node_modules/@originchain/mcp-server/dist/index.js" node "$workspace/test/readme-fixture.mjs" packed "$workspace/README.md" "$MCP_SERVER_PACKAGE" "$directory/installed-executable-node$runtime.json"
cd "$workspace"
python scripts/release_preview.py attest "$directory" "$runtime"
