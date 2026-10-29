# Contributing

Use Node.js 20 or newer and npm. From the repository root:

```sh
npm ci
npm test
npm pack --dry-run
```

`npm test` compiles `src/` and runs Node's test runner over `test/*.test.mjs`. The tests launch the actual MCP server over stdio and use local HTTP fixtures. `test/examples.test.mjs` runs the documented [protocol client example](examples/README.md), checks tool discovery, all four read operations, authentication and response values. No AI provider or live database is involved.

The source test workflow repeats tests on Node 20, 22 and 24 and against the installed npm archive. The package allowlist contains `dist/`, README and license; tests, examples and contributor instructions belong to the source checkout. Existing `scripts/` utilities cover promotion validation and packaging. Running the commands above builds local artifacts; it does not publish them.

Keep configuration validation in `src/config.ts`, request handling in `src/http.ts`, and MCP tools/resources in `src/index.ts`. Add protocol regressions for observable behaviour changes. Current tools cover SQL, vector search, full-text search and schema discovery; there is no dedicated graph tool. Database privileges govern access: the optional SELECT-prefix filter is not a SQL parser or a security boundary.
