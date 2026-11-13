# OriginChainDB MCP server

Connect an MCP host to an OriginChainDB database through four tools: SQL,
vector search, full-text search, and schema discovery.
Claude and ChatGPT can connect to the hosted server at
`https://mcp.originchain.ai/mcp` using Streamable HTTP and OAuth.
Add this URL as a custom connector in either client. In the authorization
page, enter the complete database address from Connect and an active personal
access token. Use a read-only database identity for research. SQL can modify
or delete data when the identity has write access.

The hosted service supports managed OriginChainDB instances. See its
[connection guide](https://mcp.originchain.ai/) and
[data handling details](https://mcp.originchain.ai/privacy).
The local Node.js server uses stdio and sends HTTPS requests directly to the
database. Its installation and configuration instructions follow below.

<!-- connect:begin -->
<!-- TODO(connect.v1.json): generate this block from the connect contract's "answer" once the contract is published; until then it is copied verbatim. -->
Connect over HTTPS with two values: OC_URL (your database's address, from Connect) and OC_TOKEN (an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.
<!-- connect:end -->

This server needs exactly those two values and makes those requests for you.

See the [SDK support matrix](https://github.com/originchaindb/.github/blob/main/SDK-SUPPORT.md) for the current source version, earlier
preview and tested scope. Graph queries are not exposed as a dedicated MCP tool;
applications send them over HTTPS to `$OC_URL/cypher` with the same token.

## Repository structure

| Path | Purpose |
| --- | --- |
| [`src/`](src/) | MCP tools, connection configuration and HTTP transport. |
| [`test/`](test/) | Real stdio protocol tests against a local HTTP fixture. |
| [`examples/`](examples/) | Runnable MCP client for SQL, full-text, vector and schema tools. |
| [`scripts/`](scripts/) | Preview verification and publication tooling. |
| [`.github/workflows/`](.github/workflows/) | Source, installed-package and release checks. |

Start with the [runnable examples](examples/README.md). For setup, tests and package checks, see [Contributing](CONTRIBUTING.md).

## Install and connect

Use Node.js 20 or later. This branch prepares `0.3.0-rc.1`; it has not been
published. Build a local package first:

```sh
git clone https://github.com/originchaindb/mcp-server.git
cd mcp-server
npm ci
npm test
npm pack
npx --yes --package ./originchain-mcp-server-0.3.0-rc.1.tgz originchain-mcp
```

That command requires the environment variables below and waits for MCP
messages on stdin. It is not an interactive SQL shell. The first launch may
download the package and its dependencies.

For a host whose configuration accepts an `mcpServers` object, add an entry like
this. Replace the two values with your database's address, copied from
Connect, and an access token from Access tokens:

```json
{
  "mcpServers": {
    "originchaindb": {
      "command": "npx",
      "args": ["--yes", "--package", "/absolute/path/originchain-mcp-server-0.3.0-rc.1.tgz", "originchain-mcp"],
      "env": {
        "OC_URL": "paste your database's address from Connect",
        "OC_TOKEN": "paste an access token from Access tokens"
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
npm install --global /absolute/path/originchain-mcp-server-0.3.0-rc.1.tgz
originchain-mcp
```

Set your host's command to `originchain-mcp` and omit `args` for that installation.

The previous [0.2.0-rc.1 release](https://github.com/originchaindb/mcp-server/releases/tag/v0.2.0-rc.1)
remains unchanged. This development version removes the natural-language query
tool. Reload your host to refresh its tool list after upgrading.

## Connection settings

| Variable | Required | Value |
| --- | --- | --- |
| `OC_URL` | Yes | Your database's address, copied from Connect. Use it exactly as shown: the server appends each tool's path, such as `/sql`, and never builds, edits or parses the address. A trailing slash is ignored. |
| `OC_TOKEN` | Yes | An access token (`oc_pat_...`) from Access tokens, sent unchanged as `Authorization: Bearer <OC_TOKEN>`. On databases where access tokens are not supported yet, use that database's key. |
| `OC_MCP_TIMEOUT_MS` | No | Deadline in milliseconds for each tool call or resource read, covering the HTTP request, the response-body read and the one resend after a `503` with `Retry-After`. Default `60000`; integer range `1`–`2147483647`. |
| `OC_ALLOW_INSECURE_HTTP` | No | Exactly `true` permits a non-loopback HTTP address. Otherwise HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`. |
| `OC_MCP_READONLY` | No | Exactly `true` enables the limited SQL-prefix filter. It applies only to `oc_sql`; see [Permissions and limitations](#permissions-and-limitations). |

An access token reaches data only once its owner has a database identity on
that database; until then every request returns 401 `unknown token`. Set the
identity up from the token's details, or ask an admin. The token's database
permissions decide what each tool may read or write. Tokens must be nonempty
visible ASCII without spaces or control characters.

`OC_URL` must be an absolute HTTP(S) address without userinfo, a query or a
fragment, and its path must not contain `.` or `..` segments or characters a
URL parser would rewrite. Tool path values are URL-encoded, and a `table` or
`field` that is empty, `.` or `..` is refused before any request, so no tool
argument can leave `OC_URL`'s path or select another address. **All redirects
are refused**, including same-origin redirects; use `OC_URL` exactly as copied
from Connect. Redirect targets never receive the token from this server.

**Upgrading from 0.2.x and earlier:** the address is now one value, `OC_URL`,
copied from Connect, in place of the earlier separate host and database-id
settings. For this release only, the server still reads those earlier settings
when `OC_URL` is unset and prints a warning on stderr naming the replacement;
the next minor release drops them. Database-user name and key settings are no
longer supported: the server refuses to start while either is set, rather than
send requests with the token's own permissions. Create an access token for that
database identity and use it as `OC_TOKEN`. If your database does not support
access tokens yet, keep using 0.2.0-rc.1 until it does.

**Migrating from 0.1.x:** remote plain HTTP requires the explicit
`OC_ALLOW_INSECURE_HTTP=true` opt-in, and redirected endpoints must be replaced
with their final address. Prefer HTTPS: the opt-in sends credentials without
transport encryption. Loopback HTTP remains available for local development.
Requests now time out after 60 seconds unless `OC_MCP_TIMEOUT_MS` overrides the
deadline. Keep credentials out of checked-in host configuration; use your
host's secret handling when available.

## Tools and inputs

These are the arguments supplied to MCP `tools/call`, not separate HTTP APIs.
Names and types are case-sensitive.

| Tool | Required arguments | Optional arguments | HTTPS request |
| --- | --- | --- | --- |
| `oc_list_schemas` | None (`{}`) | None | `GET $OC_URL/schemas` |
| `oc_sql` | `sql`: string | `params`: array of values for `$1`, `$2`, ... | `POST $OC_URL/sql` with `{ "sql": ..., "params": [...] }`; `params` is sent only when given. |
| `oc_vector_topk` | `table`: string, `vector`: number array | `k`: positive integer (10), `mode`: `"fast"` or `"high_recall"` (`"high_recall"`) | `POST $OC_URL/vector/{table}/topk`; maps `vector` to `query` and sets `dim` to its length. |
| `oc_fts_search` | `table`: string, `field`: string, `query`: string | `limit`: positive integer (20) | `GET $OC_URL/fts/{table}/{field}?q=...&limit=...` |

The only credential on each request is `Authorization: Bearer <OC_TOKEN>`; no
other identity header is sent.

Only `oc_sql` uses the documented access path, `$OC_URL/sql`. The schema,
vector and full-text tools call other paths at the same address with the same
token; whether every database accepts an access token on those paths has not
been verified yet.

Start with schema discovery, or run a query that does not require an existing
table:

```json
{
  "name": "oc_sql",
  "arguments": { "sql": "SELECT 42 AS value" }
}
```

Put values in `params` and refer to them as `$1`, `$2`, ... in the statement;
the database binds them in order. Never splice values into the SQL text:

```json
{
  "name": "oc_sql",
  "arguments": {
    "sql": "SELECT id, title FROM documents WHERE id = $1",
    "params": [7]
  }
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

Table names, indexed fields and vector dimensions depend on
your database. The FTS tool does not expose a search-mode argument, so it uses
the engine's default mode; do not assume its results contain BM25 scores.

Successful calls return one MCP text block containing the server response as
formatted JSON, or unchanged text when the HTTP response is not JSON. The
server does not normalize rows into a separate MCP result schema. A `SELECT`
through `oc_sql` returns `{"kind":"select","columns":[...],"rows":[{...}]}`:
only `kind: "select"` has `rows`, a NULL cell is an absent key, and numeric,
date and time values arrive as strings.

The `originchain://schemas` resource makes the same `GET $OC_URL/schemas` request and
returns its JSON with MIME type `application/json`. A host must explicitly read
or attach it; listing the resource does not load schemas into every assistant.

## Permissions and limitations

**SQL is not read-only by default.** `oc_sql` forwards statements, including
writes, to the database. The database's authorization rules determine which
requests are allowed. Configure host approval prompts and database permissions
for the access you intend to grant.

**Known issue in npm 0.1.2:** setting `OC_MCP_READONLY=true` rejects ordinary
`SELECT` statements because its filter contains a literal backspace character
where a word boundary was intended. It applies only to `oc_sql`.
Do not rely on this flag for read-only access. A statement-prefix check would
also be insufficient as a database authorization boundary.

GitHub previews from 0.1.3-rc.1 onward correct that character, so ordinary
`SELECT` prefixes pass. The filter still rejects queries beginning with `WITH`
or comments and does not parse SQL. For example, checking the prefix does not
validate later statements in a SQL string. Other tools do not use this SQL-prefix filter.
Use database permissions for read-only access, not this compatibility flag.

## Deadlines and cancellation

Each tool call or resource read has one deadline, covering connection setup,
the full response-body read and, after a `503` with `Retry-After`, the wait and
the one resend. A deadline failure returns a tool error identifying the
configured timeout; a schema-resource read returns a protocol error.

When the MCP host cancels a pending tool or resource request, its cancellation
signal aborts the corresponding HTTP fetch and body read. Other requests keep
running. The MCP SDK suppresses the cancelled request's response. A host that
only stops displaying a result without sending cancellation does not cancel
the HTTP request; its configured deadline still applies.

**Timeout or cancellation does not prove a submitted database operation was
rolled back.** The engine may already have executed it. The only automatic
retry is one resend after HTTP 503 with a `Retry-After` in whole seconds, which
the database returns when it has not carried out the request; it is sent only
if the wait fits inside the deadline. Timeouts, cancellations, a 503 without
`Retry-After` and every other error are never retried, including for SQL
writes. Inspect the operation's outcome before deciding whether to submit it
again.

## Errors and troubleshooting

| Symptom | What to check |
| --- | --- |
| Process exits with `FATAL: env var ... is required and missing` | Both `OC_URL` and `OC_TOKEN` must reach the child process; a host may not inherit your terminal environment. |
| Startup rejects the address, token, a retired setting or the timeout | Copy `OC_URL` from Connect unchanged, use an access token as `OC_TOKEN` and remove database-user settings, and choose a positive integer deadline. Configuration errors do not print secret values. |
| Startup prints a `WARNING` on stderr | A retired setting is still configured. Follow the warning: set `OC_URL` from Connect and remove the retired settings. |
| Tool reports a refused redirect | Use `OC_URL` exactly as copied from Connect; the server will not follow the redirect. |
| Tool reports a timeout | Check the database and network, then adjust `OC_MCP_TIMEOUT_MS` if appropriate. A submitted write may already have completed. |
| Host cannot start `npx` | Install Node.js 20+, check the host's executable path, or configure the installed `originchain-mcp` executable. |
| Tool returns HTTP 400 | Malformed request, or this address is not a database: use `OC_URL` exactly as copied from Connect. |
| Tool returns HTTP 401 | This database does not accept this token: wrong database, revoked, expired, not active yet, or no database identity yet (`unknown token`). Set up your database identity from the token's details, or ask an admin. |
| Tool returns HTTP 402 | A usage limit was reached. |
| Tool returns HTTP 403 | `OC_URL` was changed, or a read-only token tried to write. |
| Tool returns HTTP 404 | Wrong path: use `OC_URL` exactly as copied from Connect. |
| Tool returns HTTP 429 | Too many requests; wait before sending more. This server does not retry it. |
| Tool returns HTTP 503 | The database is waking up or briefly busy. When the response carries `Retry-After` in seconds and the wait fits inside `OC_MCP_TIMEOUT_MS`, this server waits and sends the request once more; if that also fails, retry after the number of seconds in `Retry-After`. |
| Search or a table-specific query fails | Check server feature availability, indexes, dimensions, and the returned error body. |
| An ordinary `SELECT` is rejected before an HTTP request | Check the package version: npm 0.1.2 has the filter defect described above; the GitHub preview fixes it. |

HTTP failures are returned as MCP tool errors with the method, path, status,
and server response body. Argument errors are also returned with `isError:
true`. Treat tool outputs as potentially sensitive database content: the
response body is passed through without redaction. Startup diagnostics go to
stderr and report the timeout, plus a one-time warning for any retired setting,
without printing the address or credentials. stdout is reserved for MCP.

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
address handling, retired settings, redirect refusal, credential isolation,
bound parameters, the one resend after a `503` with `Retry-After`, and the
SQL-only scope of the flag. `test/access-terms.test.mjs` fails if a retired
connection name, a database-client term or the address's path appears in the
documentation, the examples or the tool descriptions. CI repeats these checks
against the packed executable.

Maintainers can promote the current, verified GitHub preview through
[`release.yml`](.github/workflows/release.yml) after configuring the npm trusted
publisher for this repository and the `production-npm` environment. It downloads
the existing release archive, checks it against the tagged source, repeats the
installed-package tests, and publishes those bytes with the `next` tag. It does
not rebuild the published package or advance `latest`. Pull requests test source and packed archives without publishing to npm.
Promotion remains unavailable until a separately approved, verified GitHub release exists.

Report problems with the package version, Node.js version, tool name, and a
redacted error at [GitHub issues](https://github.com/originchaindb/mcp-server/issues).
Do not include tokens or private query results.

## License

[MIT](LICENSE).
