# OriginChainDB MCP server

Connect an MCP host to an OriginChainDB tenant through five tools: SQL,
natural-language queries, vector search, full-text search, and schema discovery.
The host starts this Node.js process and communicates over stdin/stdout. The
process sends HTTP requests to your database; it does not start an HTTP MCP
server.

## Install and connect

Use Node.js 20 or later. The GitHub preview
[`0.2.0-rc.1`](https://github.com/originchaindb/mcp-server/releases/tag/v0.2.0-rc.1)
adds request deadlines, MCP cancellation forwarding, paired database-user
credentials, and origin/redirect checks. Run its package directly with `npx`:

```sh
npx --yes --package https://github.com/originchaindb/mcp-server/releases/download/v0.2.0-rc.1/originchain-mcp-server-0.2.0-rc.1.tgz originchain-mcp
```

That command requires the environment variables below and waits for MCP
messages on stdin. It is not an interactive SQL shell. The first launch may
download the package and its dependencies.

For a host whose configuration accepts an `mcpServers` object, add an entry like
this. Replace the three values with your database's connection details:

```json
{
  "mcpServers": {
    "originchaindb": {
      "command": "npx",
      "args": ["--yes", "--package", "https://github.com/originchaindb/mcp-server/releases/download/v0.2.0-rc.1/originchain-mcp-server-0.2.0-rc.1.tgz", "originchain-mcp"],
      "env": {
        "OC_HOST": "https://your-database-host",
        "OC_TENANT": "your-tenant-id",
        "OC_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

Each host has its own configuration format and tool approval settings. Use its
stdio-server instructions; some Windows launchers require `npx.cmd` or the full
path to the executable. Reload the host after changing its configuration, then
check that `oc_list_schemas` appears in its tool list. Resource attachment and
tool execution depend on the host's settings.

For a preinstalled executable instead of a package download at launch:

```sh
npm install --global https://github.com/originchaindb/mcp-server/releases/download/v0.2.0-rc.1/originchain-mcp-server-0.2.0-rc.1.tgz
originchain-mcp
```

Set your host's command to `originchain-mcp` and omit `args` for that installation.

The npm registry still provides
[`@originchain/mcp-server@0.1.2`](https://www.npmjs.com/package/@originchain/mcp-server/v/0.1.2).
It has the read-only filter defect described below and lacks the new request
controls. This preview is a GitHub release asset; it has not been published to npm.

## Connection settings

| Variable | Required | Value |
| --- | --- | --- |
| `OC_HOST` | Yes | Database origin, such as `https://your-database-host`, without `/v1/tenants/...`. |
| `OC_TENANT` | Yes | Tenant identifier. The server URL-encodes it in the request path. |
| `OC_TOKEN` | Yes | Bearer token accepted by that database. |
| `OC_DB_USER` / `OC_DB_KEY` | No | Database-user name and key. Set both or omit both. Empty or incomplete pairs fail at startup. |
| `OC_MCP_TIMEOUT_MS` | No | Per-HTTP-request deadline in milliseconds, including response-body reads. Default `60000`; integer range `1`–`2147483647`. |
| `OC_ALLOW_INSECURE_HTTP` | No | Exactly `true` permits a non-loopback HTTP origin. Otherwise HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`. |
| `OC_MCP_READONLY` | No | Exactly `true` enables the limited SQL-prefix filter. It applies only to `oc_sql`; see [Permissions and limitations](#permissions-and-limitations). |

Requests use `${OC_HOST}/v1/tenants/${OC_TENANT}` and an
`Authorization: Bearer ...` header. When a database-user pair is configured,
every tool and schema-resource request also sends `X-OC-DB-User` and
`X-OC-DB-Key`. These headers identify the caller; database permissions still
control access. Tokens, database-user names and keys must be nonempty visible
ASCII without spaces or control characters.

`OC_HOST` must be an HTTP(S) origin: scheme, hostname and optional port, with an
optional trailing slash. Userinfo, path prefixes, queries and fragments are
rejected. Tenant and tool path values are URL-encoded. No caller-supplied tool
argument can select another origin. **All redirects are refused**, including
same-origin redirects; configure the direct database origin. Redirect targets
never receive bearer or database-user credentials from this server.

**Migrating from 0.1.x:** remote plain HTTP requires the explicit
`OC_ALLOW_INSECURE_HTTP=true` opt-in, and redirected endpoints must be replaced
with their final origin. Prefer HTTPS: the opt-in sends credentials without
transport encryption. Loopback HTTP remains available for local development.
Requests now time out after 60 seconds unless `OC_MCP_TIMEOUT_MS` overrides the
deadline. Keep credentials out of checked-in host configuration; use your
host's secret handling when available.

## Tools and inputs

These are the arguments supplied to MCP `tools/call`, not separate HTTP APIs.
Names and types are case-sensitive.

| Tool | Required arguments | Optional arguments | Request |
| --- | --- | --- | --- |
| `oc_list_schemas` | None (`{}`) | None | `GET /schemas` |
| `oc_sql` | `sql`: string | None | `POST /sql` with `{ "sql": ... }` |
| `oc_ask` | `nl`: string | `plan_only`: boolean | `POST /ask`; `plan_only: true` requests a plan without execution. |
| `oc_vector_topk` | `table`: string, `vector`: number array | `k`: positive integer (10), `mode`: `"fast"` or `"high_recall"` (`"high_recall"`) | `POST /vector/{table}/topk`; maps `vector` to `query` and sets `dim` to its length. |
| `oc_fts_search` | `table`: string, `field`: string, `query`: string | `limit`: positive integer (20) | `GET /fts/{table}/{field}?q=...&limit=...` |

Start with schema discovery, or run a query that does not require an existing
table:

```json
{
  "name": "oc_sql",
  "arguments": { "sql": "SELECT 42 AS value" }
}
```

For an existing table with indexed text, a full-text call looks like:

```json
{
  "name": "oc_fts_search",
  "arguments": {
    "table": "documents",
    "field": "body",
    "query": "release notes",
    "limit": 5
  }
}
```

Table names, indexed fields, vector dimensions, and Ask availability depend on
your database. The FTS tool does not expose a search-mode argument, so it uses
the engine's default mode; do not assume its results contain BM25 scores.
The SQL tool accepts a statement string only; it has no bound-parameter input.

Successful calls return one MCP text block containing the server response as
formatted JSON, or unchanged text when the HTTP response is not JSON. The
server does not normalize rows into a separate MCP result schema.

The `originchain://schemas` resource makes the same `GET /schemas` request and
returns its JSON with MIME type `application/json`. A host must explicitly read
or attach it; listing the resource does not load schemas into every assistant.

## Permissions and limitations

**SQL is not read-only by default.** `oc_sql` forwards statements, including
writes, to the database. The database's authorization rules determine which
requests are allowed. `oc_ask` can execute a generated plan unless the caller
sets `plan_only: true`; tool availability also depends on server features and
entitlements. Configure host approval prompts and database permissions for the
access you intend to grant.

**Known issue in npm 0.1.2:** setting `OC_MCP_READONLY=true` rejects ordinary
`SELECT` statements because its filter contains a literal backspace character
where a word boundary was intended. It applies only to `oc_sql`, not `oc_ask`.
Do not rely on this flag for read-only access. A statement-prefix check would
also be insufficient as a database authorization boundary.

GitHub previews from 0.1.3-rc.1 onward correct that character, so ordinary
`SELECT` prefixes pass. The filter still rejects queries beginning with `WITH`
or comments and does not parse SQL. For example, checking the prefix does not
validate later statements in a SQL string. It does not constrain `oc_ask`.
Use database permissions for read-only access, not this compatibility flag.

## Deadlines and cancellation

Each HTTP request has its own deadline, covering connection setup and the full
response-body read. A deadline failure returns a tool error identifying the
configured timeout; a schema-resource read returns a protocol error.

When the MCP host cancels a pending tool or resource request, its cancellation
signal aborts the corresponding HTTP fetch and body read. Other requests keep
running. The MCP SDK suppresses the cancelled request's response. A host that
only stops displaying a result without sending cancellation does not cancel
the HTTP request; its configured deadline still applies.

**Timeout or cancellation does not prove a submitted database operation was
rolled back.** The engine may already have executed it. There are no automatic
retries, including for failed SQL writes. Inspect the operation's outcome before
deciding whether to submit it again.

## Errors and troubleshooting

| Symptom | What to check |
| --- | --- |
| Process exits with `FATAL: env var ... is required and missing` | All three required variables must reach the child process; a host may not inherit your terminal environment. |
| Startup rejects an identity pair, origin or timeout | Supply both `OC_DB_USER`/`OC_DB_KEY`, use a direct origin, and choose a positive integer deadline. Configuration errors do not print secret values. |
| Tool reports a refused redirect | Set `OC_HOST` to the direct database origin; the server will not follow the redirect. |
| Tool reports a timeout | Check the database and network, then adjust `OC_MCP_TIMEOUT_MS` if appropriate. A submitted write may already have completed. |
| Host cannot start `npx` | Install Node.js 20+, check the host's executable path, or configure the installed `originchain-mcp` executable. |
| Tool returns `isError: true` with HTTP 401 or 403 | Check the target host, tenant, token, and database permissions. |
| Ask, search, or a table-specific query fails | Check server feature availability, indexes, dimensions, and the returned error body. |
| An ordinary `SELECT` is rejected before an HTTP request | Check the package version: npm 0.1.2 has the filter defect described above; the GitHub preview fixes it. |

HTTP failures are returned as MCP tool errors with the method, path, status,
and server response body. Argument errors are also returned with `isError:
true`. Treat tool outputs as potentially sensitive database content: the
response body is passed through without redaction. Startup diagnostics go to
stderr and report the timeout and whether database identity is enabled, without
printing the host, tenant or credentials. stdout is reserved for MCP.

## Develop from source

```sh
git clone https://github.com/originchaindb/mcp-server.git
cd mcp-server
npm ci
npm test
node dist/index.js
```

Set the required variables before the last command, or point your MCP host at
`node` with the absolute path to `dist/index.js` as its argument. Tool schemas,
argument handling, HTTP mapping, and stdio setup are in
[`src/index.ts`](src/index.ts). Connection validation lives in
[`src/config.ts`](src/config.ts), and HTTP lifecycle handling in
[`src/http.ts`](src/http.ts). `npm run build` type-checks and compiles the
source. `npm test` also exercises the compiled stdio server against a local
HTTP fixture, including SELECT prefixes, timeout and cancellation disconnects,
identity pairing, redirect refusal, credential isolation and the SQL-only scope
of the flag. CI repeats these checks against the packed executable.

Report problems with the package version, Node.js version, tool name, and a
redacted error at [GitHub issues](https://github.com/originchaindb/mcp-server/issues).
Do not include tokens or private query results.

## License

[MIT](LICENSE).
