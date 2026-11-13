import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../hosted/app.mjs";
import { digest, nonce, now } from "../hosted/store.mjs";
import { issuer, resource } from "../hosted/oauth.mjs";
import { managedDatabase } from "../dist/config.js";

class MemoryStore {
  rows = new Map();
  item(type, id, data, expires) {
    return { key: type + ":" + id, data, expires };
  }
  async put(...args) {
    const r = this.item(...args);
    this.rows.set(r.key, r);
  }
  async get(t, id) {
    const r = this.rows.get(t + ":" + id);
    if (r && (!r.expires || r.expires > now())) return r.data;
  }
  async exchange(t, id, rows) {
    if (!this.rows.delete(t + ":" + id)) return false;
    for (const r of rows) this.rows.set(r.key, r);
    return true;
  }
  async revokeGrant(id) {
    this.rows.delete("grant:" + id);
  }
  async seal(_grant, data) {
    return data;
  }
  async unseal(_grant, data) {
    return data;
  }
}
test("only managed HTTPS database addresses can receive a token", () => {
  const good = "https://example.ap-south-1.db.originchain.ai/v1/tenants/abc";
  assert.equal(managedDatabase(good + "/"), good);
  for (const unsafe of [
    good + "/../secret",
    good + "?q=1",
    "https://evil.test/v1/tenants/abc",
    "https://localhost/v1/tenants/a",
    good.replace("https:", "http:"),
    good.replace("originchain.ai", "originchain.ai.evil.test"),
  ])
    assert.ok(!managedDatabase(unsafe));
});
test("authorization, browser binding, PKCE, real MCP tool calls, rotation and revocation", async (t) => {
  const backend = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer oc_pat_local_fixture");
    res.setHeader("Content-Type", "application/json");
    const data = req.url.endsWith("/schemas")
      ? ["public.notes"]
      : req.url.endsWith("/sql")
        ? { columns: ["answer"], rows: [[42]] }
        : [{ id: "note1" }];
    res.end(JSON.stringify(data));
  }).listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => backend.close());
  const store = new MemoryStore();
  // Model the encrypted binding to a real local HTTP fixture; public inputs must still pass the real allowlist.
  store.unseal = async (_grant, data) => ({
    ...data,
    url: "http://127.0.0.1:" + backend.address().port + "/v1/tenants/sample",
  });
  const http = createApp(store, async () => true).listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => http.close());
  const base = "http://127.0.0.1:" + http.address().port;
  const post = (path, data, extra = {}) =>
    fetch(base + path, {
      method: "POST",
      body: new URLSearchParams(data),
      redirect: "manual",
      headers: extra,
    });
  assert.equal((await fetch(base + "/mcp")).status, 401);
  for (const redirect of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector/oauth/test",
  ]) {
    const register = await fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(register.status, 201);
    const { client_id } = await register.json();
    const verifier = nonce();
    const query = new URLSearchParams({
      client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: digest(verifier),
      resource,
      state: "return-to-host",
      scope: "database",
    });
    const auth = await fetch(base + "/authorize?" + query, {
      redirect: "manual",
    });
    assert.equal(auth.status, 303);
    const cookie = auth.headers.get("set-cookie").split(";")[0];
    const path = auth.headers.get("location");
    assert.equal((await fetch(base + path)).status, 403);
    assert.equal(
      (await fetch(base + path, { headers: { cookie } })).status,
      200,
    );
    const request = new URL(path, base).searchParams.get("request");
    const form = {
      request,
      url: "https://demo.free.originchain.ai/v1/tenants/sample",
      token: "oc_pat_local_fixture",
    };
    assert.equal(
      (await post("/connect", form, { cookie, Origin: "https://evil.test" }))
        .status,
      403,
    );
    const consent = await post("/connect", form, { cookie, Origin: issuer });
    assert.equal(consent.status, 303);
    const callback = new URL(consent.headers.get("Location"));
    assert.equal(callback.searchParams.get("state"), "return-to-host");
    assert.equal(callback.origin + callback.pathname, redirect);
    const grant = {
      client_id,
      redirect_uri: redirect,
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      resource,
    };
    assert.equal(
      (await post("/token", { ...grant, code_verifier: nonce() })).status,
      400,
    );
    assert.equal(
      (
        await post("/token", {
          ...grant,
          resource: "https://other.example/mcp",
        })
      ).status,
      400,
    );
    const issued = await post("/token", grant);
    assert.equal(issued.status, 200);
    const tokens = await issued.json();
    assert.equal((await post("/token", grant)).status, 400);
    const rpc = async (method, params = {}) => {
      const res = await fetch(base + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + tokens.access_token,
          "Content-Type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!body.error, JSON.stringify(body));
      return body.result;
    };
    assert.equal(
      (
        await rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        })
      ).serverInfo.name,
      "originchain-mcp",
    );
    const { tools } = await rpc("tools/list");
    assert.equal(tools.length, 4);
    for (const tool of tools) {
      assert.ok(tool.title);
      assert.equal(tool.annotations.title, tool.title);
      assert.equal(tool.annotations.readOnlyHint, tool.name !== "oc_sql");
      assert.equal(tool.annotations.destructiveHint, tool.name === "oc_sql");
    }
    for (const [name, args] of [
      ["oc_sql", { sql: "SELECT 42 AS answer" }],
      ["oc_list_schemas", {}],
      ["oc_vector_topk", { table: "notes", vector: [0, 1] }],
      ["oc_fts_search", { table: "notes", field: "body", query: "release" }],
    ]) {
      const result = await rpc("tools/call", { name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(result.content[0].text);
    }
    const refresh = {
      client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      resource,
    };
    const rotated = await post("/token", refresh);
    assert.equal(rotated.status, 200);
    assert.equal((await post("/token", refresh)).status, 400);
    assert.equal(
      (
        await post("/revoke", {
          client_id,
          token: (await rotated.json()).refresh_token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/mcp", {
          headers: { Authorization: "Bearer " + tokens.access_token },
        })
      ).status,
      401,
    );
  }
});
