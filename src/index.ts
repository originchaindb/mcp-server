#!/usr/bin/env node
/** Stdio MCP tools and a schema resource for the OriginChainDB database at OC_URL, over HTTPS with OC_TOKEN. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readConfig } from './config.js';
import { HttpStatusError, createHttpClient, isReadOnlySql } from './http.js';

const config = (() => {
  try { return readConfig(process.env); }
  catch (error) {
    process.stderr.write(`[originchain-mcp] FATAL: ${error instanceof Error ? error.message : 'invalid configuration'}\n`);
    process.exit(1);
  }
})();
const ocFetch = createHttpClient(config);

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The text block is what every host reads, and is unchanged from earlier versions:
// the response as formatted JSON, or unchanged text when it is not JSON.
// structuredContent is the same response in the shape the tool's outputSchema
// declares, for hosts that read it.
function asResult(payload: unknown, structuredContent: JsonObject) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent,
  };
}

// oc_sql and oc_cypher: the database's response object itself. Anything else (an
// array, or text that is not JSON) is wrapped, so structuredContent is always an object.
const responseObject = (payload: unknown): JsonObject => (isObject(payload) ? payload : { value: payload });
// A list under its own key, when the response is a list; otherwise wrapped the same way.
const listUnder = (key: string) => (payload: unknown): JsonObject =>
  Array.isArray(payload) ? { [key]: payload } : { value: payload };

function asErrorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// Hints for the host, per the MCP tool annotations. A database is a closed domain,
// so no tool is open-world.
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const titled = (title: string, hints: typeof READS | typeof WRITES) => ({ title, annotations: { title, ...hints } });

const VALUE = {
  description: "The response, unchanged, when it is not a JSON object (for example text that is not JSON); then it is the only key.",
};
const ROWS = {
  type: "array",
  items: { type: "object" },
  description: "One object per row, keyed by column name. A NULL cell is an absent key; numeric, date and time values are strings.",
};

const SQL_RESULT = {
  type: "object",
  properties: {
    kind: { type: "string", description: "What the statement was: \"select\" for a query; other statements report their own kind and counts." },
    columns: { type: "array", items: { type: "string" }, description: "A select's column names, in order." },
    rows: ROWS,
    value: VALUE,
  },
};
const GRAPH_RESULT = {
  type: "object",
  properties: {
    kind: { type: "string", description: "\"select\" for a graph query's rows." },
    rows: { ...ROWS, description: "One object per returned row, keyed by the RETURN item names." },
    value: VALUE,
  },
};
const listResult = (key: string, items: JsonObject, description: string) => ({
  type: "object",
  properties: { [key]: { type: "array", items, description }, value: VALUE },
  additionalProperties: false,
});

const SQL_READ_ONLY_REFUSAL =
  "OC_MCP_READONLY=true: oc_sql is read-only and forwards only a single plain SELECT that this server can tell only reads. " +
  "It refuses a second statement, a comment, a quoted identifier or dollar quote, the words INTO, FOR, WITH, INSERT, UPDATE, " +
  "DELETE or MERGE anywhere in the text (string literals included: put values in `params` and refer to them as $1, $2, ...), " +
  "and any function outside a short list of built-in read-only functions.";

function sqlTool(readOnly: boolean) {
  return {
    name: "oc_sql",
    ...(readOnly ? titled("Run read-only SQL", READS) : titled("Run SQL", WRITES)),
    description: readOnly
      ? "Run a read-only SQL query against the OriginChainDB database (POST $OC_URL/sql). OC_MCP_READONLY=true is set, so this tool is read-only: it forwards only a single plain SELECT that this server can tell only reads, and refuses anything else before sending it (a second statement, a comment, a quoted identifier, the words INTO, FOR, WITH, INSERT, UPDATE, DELETE or MERGE anywhere in the text, or a function outside a short list of built-in read-only functions). Put values in `params` and refer to them as $1, $2, ... in `sql`. The access token's database permissions still decide what may be read. Returns {\"kind\":\"select\",\"columns\":[...],\"rows\":[...]}. A query is resent once after a 503 with Retry-After."
      : "Run a SQL statement against the OriginChainDB database (POST $OC_URL/sql). This tool forwards statements, including writes; the access token's database permissions govern what is allowed. Put values in `params` and refer to them as $1, $2, ... in `sql`. Returns the database response as JSON; a SELECT returns {\"kind\":\"select\",\"columns\":[...],\"rows\":[...]}. Only a single plain SELECT is resent, once, after a 503 with Retry-After; any other statement is never resent. With OC_MCP_READONLY=true this tool is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: readOnly
            ? "One plain SELECT statement. Values go in `params`, not in the text."
            : "SQL statement.",
        },
        params: {
          type: "array",
          description: "Values the database binds to $1, $2, ... in `sql`, in order (the first value is $1). Pass values here; never splice them into the SQL text.",
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    outputSchema: SQL_RESULT,
  };
}

const TOOLS = [
  sqlTool(config.sqlReadOnly),
  {
    name: "oc_cypher",
    ...titled("Read-only graph query", READS),
    description:
      "Run a read-only openCypher graph query against the OriginChainDB database (POST $OC_URL/cypher, sent with \"read_only\": true). It reads with MATCH, OPTIONAL MATCH, WITH, UNWIND and RETURN (with WHERE, ORDER BY, SKIP and LIMIT) and CALL { ... } subqueries of those. Graph queries are read-only here; use oc_sql for writes. A query containing CREATE, MERGE, SET, DELETE, DETACH, REMOVE, FOREACH, DROP or LOAD anywhere in its text, string literals included, is refused before it is sent, and the database refuses any other write. Refer to values as $name in `cypher` and pass them in `params`. Returns {\"kind\":\"select\",\"rows\":[...]}. A query is resent once after a 503 with Retry-After.",
    inputSchema: {
      type: "object",
      properties: {
        cypher: {
          type: "string",
          description: "A read-only openCypher query, for example MATCH (a:users)-[:follows]->(b) WHERE a.id = $id RETURN b.email LIMIT 10.",
        },
        params: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean", "null"] },
          description: "Values for $name references in `cypher`, by name; each is a string, number, boolean or null. The database binds them; never splice values into the query text.",
        },
        default_schema: {
          type: "string",
          description: "Schema, as <namespace>.<table>, for node patterns without a :Label. Without it, every node pattern needs a :Label.",
        },
      },
      required: ["cypher"],
      additionalProperties: false,
    },
    outputSchema: GRAPH_RESULT,
  },
  {
    name: "oc_vector_topk",
    ...titled("Vector similarity search", READS),
    description:
      "Vector similarity search in the OriginChainDB database. Returns the top-k nearest rows in `table` to the supplied query vector.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table containing the vector column." },
        vector: {
          type: "array",
          items: { type: "number" },
          description: "Query embedding.",
        },
        k: {
          type: "integer",
          minimum: 1,
          description: "Number of neighbours to return. Default 10.",
        },
        mode: {
          type: "string",
          enum: ["fast", "high_recall"],
          description:
            "Search mode. `high_recall` is the default; `fast` trades recall for latency.",
        },
      },
      required: ["table", "vector"],
      additionalProperties: false,
    },
    outputSchema: listResult("hits", {
      type: "object",
      properties: { id: { type: "string" }, score: { type: "number" } },
    }, "Nearest rows first: each row's id and similarity score."),
  },
  {
    name: "oc_fts_search",
    ...titled("Full-text search", READS),
    description:
      "Full-text search over an indexed string field in `table` in the OriginChainDB database, using the default search mode. Response shape depends on that mode.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name." },
        field: { type: "string", description: "Indexed text field." },
        query: { type: "string", description: "Search terms." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Max rows to return. Default 20.",
        },
      },
      required: ["table", "field", "query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        result: { description: "The search response; its shape depends on the default search mode." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "oc_list_schemas",
    ...titled("List schemas", READS),
    description:
      "List all schema IDs registered in the OriginChainDB database. Use this for discovery before issuing typed queries.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: listResult("schemas", { type: "string" }, "Schema IDs, as <namespace>.<table>."),
  },
];

// ---------------------------------------------------------------------------
// Tool implementations (one short comment each)
// ---------------------------------------------------------------------------

// POST /sql {sql, params?}; params is sent only when the caller gave it. Only a
// statement that isReadOnlySql accepts may be resent; anything else may write.
async function callSql(args: { sql: string; params?: unknown[] }, signal: AbortSignal) {
  const body = args.params === undefined ? { sql: args.sql } : { sql: args.sql, params: args.params };
  return ocFetch("POST", `/sql`, isReadOnlySql(args.sql) ? "read" : "may-write", body, signal);
}

// Words that begin a write clause, or a statement this read-only tool never sends.
// A database that predates read-only graph requests may ignore `read_only`, so these
// are refused before any request. They are matched as whole words anywhere in the
// text, string literals and property names included, so a value that contains one
// can only make a query count as a write; such values belong in `params`, which
// are never scanned.
// IMPORT too, as the control plane's Cypher classifier lists it. CALL is not here: a CALL can write only through
// a write clause inside it, which these words already refuse, and read-only CALL { ... } subqueries must work.
const CYPHER_WRITE_WORDS = /\b(create|merge|set|delete|detach|remove|foreach|drop|load|import)\b/i;
const GRAPH_READ_ONLY = "graph queries are read-only here; use oc_sql for writes";

// POST /cypher {cypher, params, read_only: true, default_schema?}. With read_only
// the database refuses any write (403 read_only_query), and the text has no write
// word, so it is a read and may be resent.
async function callCypher(args: { cypher: string; params: JsonObject; default_schema?: string }, signal: AbortSignal) {
  const word = CYPHER_WRITE_WORDS.exec(args.cypher)?.[1];
  if (word) {
    throw new Error(
      `${GRAPH_READ_ONLY}. \`${word.toUpperCase()}\` is a write keyword, and this server refuses it anywhere in the query text before sending it; pass a value that contains it in \`params\`.`,
    );
  }
  const body: JsonObject = { cypher: args.cypher, params: args.params, read_only: true };
  if (args.default_schema !== undefined) body.default_schema = args.default_schema;
  try {
    return await ocFetch("POST", `/cypher`, "read", body, signal);
  } catch (err) {
    if (isReadOnlyRefusal(err)) throw new Error(`${GRAPH_READ_ONLY}. ${err.message}`);
    throw err;
  }
}

// The database's refusal of a write in a read_only request: 403 with
// {"error":"read_only_query"} (or {"error":{"code":"read_only_query"}}).
function isReadOnlyRefusal(err: unknown): err is HttpStatusError {
  if (!(err instanceof HttpStatusError) || err.status !== 403 || !isObject(err.body)) return false;
  const error = err.body.error;
  return error === "read_only_query" || (isObject(error) && error.code === "read_only_query");
}

// A path value of "", "." or ".." would make the URL parser drop or climb a path
// segment, so the request would leave OC_URL's path. Everything else is encoded.
function requirePathNames(...values: string[]) {
  if (values.some((v) => v === "" || v === "." || v === "..")) {
    throw new Error("`table` and `field` must not be empty, `.` or `..`");
  }
}

// POST /vector/{table}/topk {query, dim, k, mode}
// NOTE: the engine's VecTopkReq requires `query` (the embedding) and `dim`
// (its length) — not `vector`. The tool's public arg stays `vector` for
// intuitiveness; we map it here. Missing/renamed fields → 422.
async function callVectorTopk(args: {
  table: string;
  vector: number[];
  k?: number;
  mode?: "fast" | "high_recall";
}, signal: AbortSignal) {
  const body = {
    query: args.vector,
    dim: args.vector.length,
    k: args.k ?? 10,
    mode: args.mode ?? "high_recall",
  };
  // A nearest-neighbour search only reads.
  return ocFetch(
    "POST",
    `/vector/${encodeURIComponent(args.table)}/topk`,
    "read",
    body,
    signal,
  );
}

// GET /fts/{table}/{field}?q=…&limit=…
async function callFtsSearch(args: {
  table: string;
  field: string;
  query: string;
  limit?: number;
}, signal: AbortSignal) {
  const limit = args.limit ?? 20;
  const qs = `?q=${encodeURIComponent(args.query)}&limit=${limit}`;
  return ocFetch(
    "GET",
    `/fts/${encodeURIComponent(args.table)}/${encodeURIComponent(args.field)}${qs}`,
    "read",
    undefined,
    signal,
  );
}

// GET /schemas — discovery, also backs the originchain://schemas resource.
async function callListSchemas(signal: AbortSignal) {
  return ocFetch("GET", `/schemas`, "read", undefined, signal);
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

// Version comes from package.json so the MCP handshake can never drift from
// the published artifact again (0.1.1 shipped announcing itself as 0.1.0).
import { createRequire } from "node:module";
const pkgVersion: string = createRequire(import.meta.url)("../package.json").version;

const server = new Server(
  {
    name: "originchain-mcp",
    version: pkgVersion,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  })),
}));

const isScalar = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "oc_sql": {
        if (typeof args.sql !== "string") throw new Error("`sql` must be a string");
        if (args.params !== undefined && !Array.isArray(args.params))
          throw new Error("`params` must be an array of values for $1, $2, ...");
        // OC_MCP_READONLY=true: forward only a statement the conservative read check
        // accepts, the same check that decides whether a statement may be resent.
        if (config.sqlReadOnly && !isReadOnlySql(args.sql)) {
          throw new Error(SQL_READ_ONLY_REFUSAL);
        }
        const payload = await callSql({ sql: args.sql, params: args.params as unknown[] | undefined }, extra.signal);
        return asResult(payload, responseObject(payload));
      }
      case "oc_cypher": {
        if (typeof args.cypher !== "string") throw new Error("`cypher` must be a string");
        if (args.params !== undefined && !isObject(args.params))
          throw new Error("`params` must be an object of values for $name references");
        const params = (args.params ?? {}) as JsonObject;
        if (!Object.values(params).every(isScalar))
          throw new Error("`params` values must be strings, numbers, booleans or null");
        if (args.default_schema !== undefined && typeof args.default_schema !== "string")
          throw new Error("`default_schema` must be a string");
        const payload = await callCypher({ cypher: args.cypher, params, default_schema: args.default_schema }, extra.signal);
        return asResult(payload, responseObject(payload));
      }
      case "oc_vector_topk": {
        if (typeof args.table !== "string")
          throw new Error("`table` must be a string");
        requirePathNames(args.table);
        if (!Array.isArray(args.vector) || !args.vector.every((v) => typeof v === "number"))
          throw new Error("`vector` must be an array of numbers");
        const k = args.k === undefined ? undefined : Number(args.k);
        const mode =
          args.mode === "fast" || args.mode === "high_recall" ? args.mode : undefined;
        const payload = await callVectorTopk({
          table: args.table,
          vector: args.vector as number[],
          k,
          mode,
        }, extra.signal);
        return asResult(payload, listUnder("hits")(payload));
      }
      case "oc_fts_search": {
        if (typeof args.table !== "string") throw new Error("`table` must be a string");
        if (typeof args.field !== "string") throw new Error("`field` must be a string");
        if (typeof args.query !== "string") throw new Error("`query` must be a string");
        requirePathNames(args.table, args.field);
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        const payload = await callFtsSearch({
          table: args.table,
          field: args.field,
          query: args.query,
          limit,
        }, extra.signal);
        return asResult(payload, { result: payload });
      }
      case "oc_list_schemas": {
        const payload = await callListSchemas(extra.signal);
        return asResult(payload, listUnder("schemas")(payload));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return asErrorResult(err);
  }
});

// Resource: originchain://schemas — eager schema dump for context attach.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "originchain://schemas",
      name: "OriginChain schemas",
      description:
        "List of schema IDs registered in this database. Auto-discoverable for context attach.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
  if (req.params.uri !== "originchain://schemas") {
    throw new Error(`Unknown resource: ${req.params.uri}`);
  }
  const schemas = await callListSchemas(extra.signal);
  return {
    contents: [
      {
        uri: req.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(schemas, null, 2),
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[originchain-mcp] ready; request timeout=${config.timeoutMs}ms\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[originchain-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
