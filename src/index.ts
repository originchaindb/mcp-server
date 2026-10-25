#!/usr/bin/env node
/** Stdio MCP tools and a schema resource backed by the configured OriginChainDB origin. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readConfig } from './config.js';
import { createHttpClient } from './http.js';

const config = (() => {
  try { return readConfig(process.env); }
  catch (error) {
    process.stderr.write(`[originchain-mcp] FATAL: ${error instanceof Error ? error.message : 'invalid configuration'}\n`);
    process.exit(1);
  }
})();
const ocFetch = createHttpClient(config);

function asTextResult(payload: unknown) {
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
  };
}

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

const TOOLS = [
  {
    name: "oc_sql",
    description:
      "Run a SQL statement against the OriginChain tenant; database permissions govern what is allowed. Returns the engine response as JSON. OC_MCP_READONLY=true applies a SELECT-prefix filter to this tool only; it is not a database authorization boundary.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement. The optional SQL-prefix filter permits SELECT prefixes only." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "oc_vector_topk",
    description:
      "Vector similarity search. Returns the top-k nearest rows in `table` to the supplied query vector.",
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
  },
  {
    name: "oc_fts_search",
    description:
      "Full-text search over an indexed string field in `table`, using the engine's default search mode. Response shape depends on that mode.",
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
  },
  {
    name: "oc_list_schemas",
    description:
      "List all schema IDs registered in the tenant. Use this for discovery before issuing typed queries.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool implementations (one short comment each)
// ---------------------------------------------------------------------------

// POST /sql {sql}
async function callSql(args: { sql: string }, signal: AbortSignal) {
  return ocFetch("POST", `/sql`, { sql: args.sql }, signal);
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
  return ocFetch(
    "POST",
    `/vector/${encodeURIComponent(args.table)}/topk`,
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
    undefined,
    signal,
  );
}

// GET /schemas — discovery, also backs the originchain://schemas resource.
async function callListSchemas(signal: AbortSignal) {
  return ocFetch("GET", `/schemas`, undefined, signal);
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
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "oc_sql": {
        if (typeof args.sql !== "string") throw new Error("`sql` must be a string");
        // Optional SQL prefix filter only. This is not a SQL parser or an
        // authorization boundary, and it does not restrict other tools.
        if (
          config.sqlPrefixOnly &&
          !/^\s*select\b/i.test(args.sql)
        ) {
          throw new Error(
            "OC_MCP_READONLY=true — oc_sql requires a SELECT prefix",
          );
        }
        return asTextResult(await callSql({ sql: args.sql }, extra.signal));
      }
      case "oc_vector_topk": {
        if (typeof args.table !== "string")
          throw new Error("`table` must be a string");
        if (!Array.isArray(args.vector) || !args.vector.every((v) => typeof v === "number"))
          throw new Error("`vector` must be an array of numbers");
        const k = args.k === undefined ? undefined : Number(args.k);
        const mode =
          args.mode === "fast" || args.mode === "high_recall" ? args.mode : undefined;
        return asTextResult(
          await callVectorTopk({
            table: args.table,
            vector: args.vector as number[],
            k,
            mode,
          }, extra.signal),
        );
      }
      case "oc_fts_search": {
        if (typeof args.table !== "string") throw new Error("`table` must be a string");
        if (typeof args.field !== "string") throw new Error("`field` must be a string");
        if (typeof args.query !== "string") throw new Error("`query` must be a string");
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        return asTextResult(
          await callFtsSearch({
            table: args.table,
            field: args.field,
            query: args.query,
            limit,
          }, extra.signal),
        );
      }
      case "oc_list_schemas": {
        return asTextResult(await callListSchemas(extra.signal));
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
        "List of schema IDs registered in this tenant. Auto-discoverable for context attach.",
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
    `[originchain-mcp] ready; request timeout=${config.timeoutMs}ms; database identity=${config.dbUser === undefined ? 'disabled' : 'enabled'}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[originchain-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
