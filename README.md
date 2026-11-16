# OriginChainDB MCP server

Connect an MCP host to an OriginChainDB database through five tools: SQL,
read-only graph queries, vector search, full-text search, and schema discovery.
The host starts this Node.js process and communicates over stdin/stdout. The
process sends HTTPS requests to your database's address with your access token;
it does not start an HTTP MCP server.

<!-- connect:begin -->
<!-- TODO(connect.v1.json): generate this block from the connect contract's "answer" once the contract is published; until then it is copied verbatim. -->
Connect over HTTPS with two values: OC_URL (your database's address, from Connect) and OC_TOKEN (an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.
<!-- connect:end -->

This server needs exactly those two values and makes those requests for you.

See the [SDK support matrix](https://github.com/originchaindb/.github/blob/main/SDK-SUPPORT.md) for the current source version, earlier
preview and tested scope. Graph queries go through `oc_cypher`, which only
reads; applications can also send them over HTTPS to `$OC_URL/cypher` with the
same token.

## Repository structure

| Path | Purpose |
| --- | --- |
| [`src/`](src/) | MCP tools, connection configuration and HTTP transport. |
| [`test/`](test/) | Real stdio protocol tests against a local HTTP fixture. |
| [`examples/`](examples/) | Runnable MCP client for SQL, full-text, vector and schema tools. |
| [`scripts/`](scripts/) | Preview verification, publication tooling, the registry entry check and the install-link generator. |
| [`server.json`](server.json) | This server's entry for the MCP Registry; see [Publishing](PUBLISHING.md). |
| [`.github/workflows/`](.github/workflows/) | Source, installed-package and release checks. |

Start with the [runnable examples](examples/README.md). For setup, tests and package checks, see [Contributing](CONTRIBUTING.md).

## Install and connect

Use Node.js 20 or later. The server is published on npm as
[`@originchain-db/mcp-server`](https://www.npmjs.com/package/@originchain-db/mcp-server).

### One-click install

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=originchaindb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyItLXllcyIsIi0tcGFja2FnZSIsIkBvcmlnaW5jaGFpbi1kYi9tY3Atc2VydmVyQDAuNC4wIiwib3JpZ2luY2hhaW4tbWNwIl0sImVudiI6eyJPQ19VUkwiOiIke2VudjpPQ19VUkx9IiwiT0NfVE9LRU4iOiIke2VudjpPQ19UT0tFTn0ifX0%3D)
[![Add to VS Code](https://img.shields.io/badge/VS_Code-Add_to_VS_Code-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522originchaindb%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522--yes%2522%252C%2522--package%2522%252C%2522%2540originchain-db%252Fmcp-server%25400.4.0%2522%252C%2522originchain-mcp%2522%255D%252C%2522env%2522%253A%257B%2522OC_URL%2522%253A%2522%2524%257Binput%253Aoc_url%257D%2522%252C%2522OC_TOKEN%2522%253A%2522%2524%257Binput%253Aoc_token%257D%2522%257D%252C%2522inputs%2522%253A%255B%257B%2522type%2522%253A%2522promptString%2522%252C%2522id%2522%253A%2522oc_url%2522%252C%2522description%2522%253A%2522OC_URL%253A%2520the%2520database%2520address%252C%2520copied%2520from%2520Connect%2522%257D%252C%257B%2522type%2522%253A%2522promptString%2522%252C%2522id%2522%253A%2522oc_token%2522%252C%2522description%2522%253A%2522OC_TOKEN%253A%2520an%2520access%2520token%2520from%2520Access%2520tokens%2522%252C%2522password%2522%253Atrue%257D%255D%257D)

No link or command below contains a token or an address. Each one installs
version 0.4.0 of the package.

- **Cursor** adds the server with `OC_URL` and `OC_TOKEN` set to `${env:OC_URL}`
  and `${env:OC_TOKEN}`, which Cursor reads from the environment it was started
  in; Cursor has no prompt for them. Set both before you start Cursor, or replace
  the two references in Cursor's MCP settings after installing.
- **VS Code** opens the server's install page for you to review. The first time
  it starts the server, it asks for `OC_URL` and, as a hidden password,
  `OC_TOKEN`.
- **Claude Code**: set `OC_URL` and `OC_TOKEN` in your shell, then run:

```sh
claude mcp add --env OC_URL="$OC_URL" --env OC_TOKEN="$OC_TOKEN" --transport stdio originchaindb -- npx --yes --package @originchain-db/mcp-server@0.4.0 originchain-mcp
```

The shell substitutes both values, and Claude Code keeps them in its own
configuration for this server (local scope by default; add `--scope user` to use
it in every project). In PowerShell, write `$env:OC_URL` and `$env:OC_TOKEN`
instead. Maintainers regenerate these links for a new version with
`node scripts/install-links.mjs`.

### Any other host

```sh
npx --yes --package @originchain-db/mcp-server@0.4.0 originchain-mcp
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
      "args": ["--yes", "--package", "@originchain-db/mcp-server@0.4.0", "originchain-mcp"],
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
npm install --global @originchain-db/mcp-server@0.4.0
originchain-mcp
```

To build the same package from source instead:

```sh
git clone https://github.com/originchaindb/mcp-server.git
cd mcp-server
npm ci
npm test
npm pack
npx --yes --package ./originchain-db-mcp-server-0.4.0.tgz originchain-mcp
```

Set your host's command to `originchain-mcp` and omit `args` for that installation.

Version 0.4.0 adds the read-only graph tool `oc_cypher`, tool titles and
annotations, and structured results, and makes `OC_MCP_READONLY=true` refuse
every SQL statement this server cannot tell only reads (see
[Permissions and limitations](#permissions-and-limitations)). Version 0.3.0
removed the natural-language query tool of earlier previews. Reload your host to
refresh its tool list after upgrading.

## Connection settings

| Variable | Required | Value |
| --- | --- | --- |
| `OC_URL` | Yes | Your database's address, copied from Connect. Use it exactly as shown: the server appends each tool's path, such as `/sql`, and never builds, edits or parses the address. A trailing slash is ignored. |
| `OC_TOKEN` | Yes | An access token (`oc_pat_...`) from Access tokens, sent unchanged as `Authorization: Bearer <OC_TOKEN>`. |
| `OC_MCP_TIMEOUT_MS` | No | Deadline in milliseconds for each tool call or resource read, covering the HTTP request, the response-body read and, for a read, the one resend after a `503` with `Retry-After`. Default `60000`; integer range `1`–`2147483647`. |
| `OC_ALLOW_INSECURE_HTTP` | No | Exactly `true` permits a non-loopback HTTP address. Otherwise HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`. |
| `OC_MCP_READONLY` | No | Exactly `true` makes `oc_sql` read-only: it forwards only a single plain `SELECT` that this server can tell only reads. It changes only `oc_sql`; see [Permissions and limitations](#permissions-and-limitations). |

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

**Upgrading from 0.2.x and earlier:** 0.3.0 and later connect with `OC_URL` and
`OC_TOKEN` only. The earlier separate host and database-id settings, and the
database-user name and key settings, are no longer read: the server refuses to
start while any of them is set, even empty or beside `OC_URL`, and its error
names the replacement, rather than run on settings it ignores. Set `OC_URL` to
your database's address from Connect, set `OC_TOKEN` to an access token for your
database identity, and remove the earlier settings.

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
| `oc_cypher` | `cypher`: string | `params`: object of string, number, boolean or null values for `$name`; `default_schema`: string | `POST $OC_URL/cypher` with `{ "cypher": ..., "params": {...}, "read_only": true }`, plus `default_schema` when given. |
| `oc_vector_topk` | `table`: string, `vector`: number array | `k`: positive integer (10), `mode`: `"fast"` or `"high_recall"` (`"high_recall"`) | `POST $OC_URL/vector/{table}/topk`; maps `vector` to `query` and sets `dim` to its length. |
| `oc_fts_search` | `table`: string, `field`: string, `query`: string | `limit`: positive integer (20) | `GET $OC_URL/fts/{table}/{field}?q=...&limit=...` |

The only credential on each request is `Authorization: Bearer <OC_TOKEN>`; no
other identity header is sent.

Only `oc_sql` uses the documented access path, `$OC_URL/sql`. The graph,
schema, vector and full-text tools call other paths at the same address with
the same token; whether every database accepts an access token on those paths
has not been verified yet.

Each tool has a title and MCP tool annotations, which a host can use to label it
and to decide when to ask before running it:

| Tool | Title | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- | --- |
| `oc_sql` | Run SQL | `false` | `true` | `false` | `false` |
| `oc_sql` with `OC_MCP_READONLY=true` | Run read-only SQL | `true` | `false` | `true` | `false` |
| `oc_cypher` | Read-only graph query | `true` | `false` | `true` | `false` |
| `oc_vector_topk` | Vector similarity search | `true` | `false` | `true` | `false` |
| `oc_fts_search` | Full-text search | `true` | `false` | `true` | `false` |
| `oc_list_schemas` | List schemas | `true` | `false` | `true` | `false` |

Annotations are hints to the host, not permissions: the token's database
permissions decide what each request may do.

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

A graph query reads with `MATCH`, `OPTIONAL MATCH`, `WITH`, `UNWIND` and
`RETURN` (with `WHERE`, `ORDER BY`, `SKIP` and `LIMIT`), and `CALL { ... }`
subqueries made of those. Refer to values as `$name` and pass them in `params`;
`default_schema` names the schema for node patterns without a `:Label`:

```json
{
  "name": "oc_cypher",
  "arguments": {
    "cypher": "MATCH (a)-[:follows]->(b) WHERE a.id = $id RETURN b.email LIMIT 10",
    "params": { "id": "alice" },
    "default_schema": "social.users"
  }
}
```

It returns `{"kind":"select","rows":[{"email":"..."}]}`. **Graph queries are
read-only here; use `oc_sql` for writes.** Every request carries
`"read_only": true`, and the database refuses a write in it with
`403 read_only_query`, which this tool returns as an error that says so. A
database version that predates read-only graph requests may ignore that flag
(or refuse every request that carries it, with HTTP 400), so this server also
refuses, before sending anything, a query that contains
`CREATE`, `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`, `FOREACH`, `DROP` or
`LOAD` as a word anywhere in its text, in any letter case, string literals and
property names included. Pass a value that contains such a word in `params`,
which this check does not read. Each `params` value must be a string, number,
boolean or null; lists and objects are refused before any request.

Successful calls return one MCP text block containing the server response as
formatted JSON, or unchanged text when the HTTP response is not JSON, as in
earlier versions. They also return `structuredContent`, the same response in
the shape each tool's `outputSchema` declares:

| Tool | `structuredContent` |
| --- | --- |
| `oc_sql`, `oc_cypher` | The database's response object itself, such as `{"kind":"select","columns":[...],"rows":[...]}`. |
| `oc_vector_topk` | `{"hits": [{"id": ..., "score": ...}, ...]}` |
| `oc_fts_search` | `{"result": ...}`, the search response, whose shape depends on the default search mode. |
| `oc_list_schemas` | `{"schemas": [...]}` |

A response that does not have that shape, such as text that is not JSON, is
returned as `{"value": ...}`. Errors carry text only. A `SELECT` through
`oc_sql` returns `{"kind":"select","columns":[...],"rows":[{...}]}`: only
`kind: "select"` has `rows`, a NULL cell is an absent key, and numeric, date and
time values arrive as strings.

The `originchain://schemas` resource makes the same `GET $OC_URL/schemas` request and
returns its JSON with MIME type `application/json`. A host must explicitly read
or attach it; listing the resource does not load schemas into every assistant.

## Permissions and limitations

**SQL is not read-only by default.** `oc_sql` forwards statements, including
writes, to the database. The database's authorization rules determine which
requests are allowed. Configure host approval prompts and database permissions
for the access you intend to grant.

**`OC_MCP_READONLY=true` makes `oc_sql` read-only.** It then forwards only a
statement that passes the conservative check this server also uses to decide
whether a statement may be resent (see
[Deadlines and cancellation](#deadlines-and-cancellation)): a single plain
`SELECT` with no second statement, comment, quoted identifier or dollar quote,
none of the words `INTO`, `FOR`, `WITH`, `INSERT`, `UPDATE`, `DELETE` or `MERGE`
anywhere in its text, and no function outside a short list of built-in
read-only functions. Put values in `params`, which the check does not read.
Everything else is refused before any request, including reads the check cannot
tell from writes, such as a `WITH` query or a quoted column name. Before 0.4.0
this setting checked only the `SELECT` prefix and forwarded, for example,
`SELECT 1; DELETE FROM t`. The check reads text, so it cannot see a write hidden
behind a view, an operator or a cast: for a limit the database enforces, use an
access token whose database identity can only read. The setting does not change
the other tools, which only read.

**Known issue in npm 0.1.2:** setting `OC_MCP_READONLY=true` rejects ordinary
`SELECT` statements because its filter contains a literal backspace character
where a word boundary was intended. Upgrade to a later version.

## Deadlines and cancellation

Each tool call or resource read has one deadline, covering connection setup,
the full response-body read and, when a read is resent after a `503` with
`Retry-After`, the wait and the resend. A deadline failure returns a tool error
identifying the configured timeout; a schema-resource read returns a protocol
error.

When the MCP host cancels a pending tool or resource request, its cancellation
signal aborts the corresponding HTTP fetch and body read. Other requests keep
running. The MCP SDK suppresses the cancelled request's response. A host that
only stops displaying a result without sending cancellation does not cancel
the HTTP request; its configured deadline still applies.

**Timeout or cancellation does not prove a submitted database operation was
rolled back.** The engine may already have executed it. The only automatic
retry is one resend of a **read** after HTTP 503 with a `Retry-After` in whole
seconds, sent only if the wait fits inside the deadline. A read is
`oc_list_schemas`, `oc_cypher`, `oc_vector_topk`, `oc_fts_search`, the schema
resource, and an `oc_sql` statement that is a single plain `SELECT`. The
database can return the same 503 for a write that it has already applied, so an
`oc_sql` statement is never resent unless it starts with `SELECT`, is the only
statement, has no comment, quoted identifier or dollar quote, does not contain
the words `INTO`, `FOR`, `WITH`, `INSERT`, `UPDATE`, `DELETE` or `MERGE` (even
inside a string), and calls no function outside a short list of built-in
read-only functions. A 503 whose body says the request was applied
(`"applied_locally": true`) is never resent. Timeouts, cancellations, a 503
without `Retry-After` and every other error are never retried. Inspect the
operation's outcome before deciding whether to submit it again.

## Errors and troubleshooting

| Symptom | What to check |
| --- | --- |
| Process exits with `FATAL: env var ... is required and missing` | Both `OC_URL` and `OC_TOKEN` must reach the child process; a host may not inherit your terminal environment. With the Cursor link, set both in the environment Cursor starts in. |
| Startup rejects the address, token, a retired setting or the timeout | Copy `OC_URL` from Connect unchanged, use an access token as `OC_TOKEN`, remove the retired setting the error names, and choose a positive integer deadline. Configuration errors do not print secret values. |
| Tool reports a refused redirect | Use `OC_URL` exactly as copied from Connect; the server will not follow the redirect. |
| Tool reports a timeout | Check the database and network, then adjust `OC_MCP_TIMEOUT_MS` if appropriate. A submitted write may already have completed. |
| Host cannot start `npx` | Install Node.js 20+, check the host's executable path, or configure the installed `originchain-mcp` executable. |
| Tool returns HTTP 400 | Malformed request, or this address is not a database: use `OC_URL` exactly as copied from Connect. |
| Tool returns HTTP 401 | This database does not accept this token: wrong database, revoked, expired, not active yet, or no database identity yet (`unknown token`). Set up your database identity from the token's details, or ask an admin. |
| Tool returns HTTP 402 | A usage limit was reached. |
| Tool returns HTTP 403 | `OC_URL` was changed, or a read-only token tried to write. |
| `oc_cypher` says graph queries are read-only here | The query writes, or contains a write keyword in its text: use `oc_sql` for writes, and pass a value that contains such a word in `params`. |
| `oc_cypher` returns HTTP 400 naming `read_only` | This database version does not accept read-only graph requests yet, so this tool cannot run graph queries on it. |
| `oc_sql` says `OC_MCP_READONLY=true: oc_sql is read-only` | The statement is not one plain `SELECT` this server can tell only reads. Move values into `params`, or unset `OC_MCP_READONLY` and rely on the token's database permissions. |
| Tool returns HTTP 404 | Wrong path: use `OC_URL` exactly as copied from Connect. |
| Tool returns HTTP 429 | Too many requests; wait before sending more. This server does not retry it. |
| Tool returns HTTP 503 | The database is waking up or briefly busy, or could not confirm a write. For a read whose response carries `Retry-After` in seconds, when the wait fits inside `OC_MCP_TIMEOUT_MS`, this server waits and sends the request once more. A write is never resent: check whether it was applied before you submit it again. |
| Search or a table-specific query fails | Check server feature availability, indexes, dimensions, and the returned error body. |

HTTP failures are returned as MCP tool errors with the method, path, status,
and server response body. Argument errors are also returned with `isError:
true`. Treat tool outputs as potentially sensitive database content: the
response body is passed through without redaction. Startup diagnostics go to
stderr and report the timeout, or why startup was refused, without printing the
address or credentials. stdout is reserved for MCP.

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
annotations, argument handling, HTTP mapping, and stdio setup are in
[`src/index.ts`](src/index.ts). Connection validation lives in
[`src/config.ts`](src/config.ts), and HTTP lifecycle handling in
[`src/http.ts`](src/http.ts). `npm run build` type-checks and compiles the
source. `npm test` also exercises the compiled stdio server against a local
HTTP fixture, including tool annotations, output schemas and structured
results, the read-only graph tool and its refusals, the read-only SQL mode,
timeout and cancellation disconnects, address handling, refusal of retired
settings, redirect refusal, credential isolation, bound parameters, the one
resend of a read after a `503` with `Retry-After` and no resend of a write. It
also checks `server.json` against the MCP Registry's published schema and
decodes every install link above. `test/access-terms.test.mjs` fails if a
retired connection name, a database-client term or the address's path appears
in the documentation, the examples or the tool descriptions. CI repeats these
checks against the packed executable.

Maintainers can promote the current, verified GitHub preview through
[`release.yml`](.github/workflows/release.yml) after configuring the npm trusted
publisher for this repository and the `production-npm` environment. It downloads
the existing release archive, checks it against the tagged source, repeats the
installed-package tests, and publishes those bytes with the `next` tag. It does
not rebuild the published package or advance `latest`. Pull requests test source and packed archives without publishing to npm.
Promotion remains unavailable until a separately approved, verified GitHub release exists.
Listing a published version in the MCP Registry is a separate, manual step; see
[Publishing](PUBLISHING.md).

Report problems with the package version, Node.js version, tool name, and a
redacted error at [GitHub issues](https://github.com/originchaindb/mcp-server/issues).
Do not include tokens or private query results.

## License

[MIT](LICENSE).
