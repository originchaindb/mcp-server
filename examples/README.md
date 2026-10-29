# Call the server through MCP

`client.mjs` uses the official MCP client, starts this server over stdio, completes the protocol handshake, discovers tools and calls one tool. No AI model is required.

From this source checkout:

```sh
npm ci
npm run build
node examples/client.mjs --help
```

Set `OC_HOST`, `OC_TENANT` and `OC_TOKEN` in the process environment. `OC_HOST` is the HTTPS database origin, without an API path. Local loopback HTTP is supported for testing. If database identity is enabled, set both `OC_DB_USER` and `OC_DB_KEY`. Keep credentials out of source and shell history.

```sh
node examples/client.mjs sql
node examples/client.mjs schemas
node examples/client.mjs fts
node examples/client.mjs vector
```

| Command | Required fixture variables | Behaviour |
| --- | --- | --- |
| `sql` | None | `SELECT 1 AS value`; no table required |
| `schemas` | None | List existing schema IDs |
| `fts` | `OC_TABLE`, `OC_FTS_FIELD`, `OC_QUERY` | Search a pre-existing indexed text field |
| `vector` | `OC_TABLE`, `OC_QUERY_VECTOR` | Search a pre-existing vector index; JSON vector must match its dimension and embedding model |

For a prepared two-dimensional fixture, `OC_QUERY_VECTOR` can be `[1,0]`. It is not a text embedding. The examples read existing data and create no schemas or rows. There is no dedicated graph MCP tool; use a maintained language SDK for the graph API.

By default the example starts `dist/index.js` from this checkout. To test a downloaded npm archive, set `MCP_SERVER_PACKAGE` to its absolute `.tgz` path; the client starts that exact archive with `npx`. The source CI exercises both paths. The loopback acceptance verifies MCP and HTTP contracts, not live database behaviour.
