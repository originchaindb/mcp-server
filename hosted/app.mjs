import express from "express";
import serverless from "serverless-http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createDatabaseServer } from "../dist/database-server.js";
import { GrantStore, digest } from "./store.mjs";
import { issuer, resource, scope, marketplaceClient, Provider } from "./oauth.mjs";

import { managedDatabase } from "../dist/config.js";

const css = 'body{font:17px/1.55 system-ui,sans-serif;color:#172b3a;max-width:37rem;margin:6vh auto;padding:2rem}h1{font-size:2rem;line-height:1.2}label{display:block;margin:1rem 0;font-weight:600}input{display:block;font:inherit;width:95%;padding:.6rem;margin-top:.3rem;border:1px solid #8795a0;border-radius:5px}button{font:inherit;font-weight:650;background:#123f53;color:white;padding:.65rem 1rem;border:0;border-radius:5px}a{color:#095577}footer{font-size:.9rem;margin-top:2rem}code{overflow-wrap:anywhere}';
const page = (title, body) => '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + ' | OriginChainDB</title><style>' + css + '</style><main><h1>' + title + '</h1>' + body + '</main><footer><a href="https://originchaindb.com/privacy">Privacy</a> · <a href="https://originchaindb.com/terms">Terms</a> · <a href="https://originchaindb.com/contact">Support</a></footer></html>';
const docs = "https://originchaindb.com/docs/integrations/mcp/";
const home = page("OriginChainDB MCP", '<p>Connect a managed OriginChainDB database to Claude or ChatGPT to inspect its schemas, run SQL, and search indexed text and vectors.</p><p>In your AI client, add the remote MCP server at <code>' + resource + '</code> and choose OAuth. During authorization, enter the database address and a personal access token from the <a href="https://app.originchaindb.com">OriginChainDB console</a>.</p><p>Use a read-only database identity for research. SQL can change data when the connected identity has write access.</p><p><a href="/privacy">How this connector handles data</a></p>');

function consentForm(client, ticket) {
  return page("Connect your database to " + client, '<p>Authorize ' + client + ' to inspect schemas, search and execute SQL on one OriginChainDB database. Queries, parameters and results pass between your database and ' + client + ' through this connector. SQL can modify or delete data if your token permits it.</p>' +
    '<form action="/connect" method="post"><input type="hidden" name="request" value="' + ticket + '"><label>Database address (OC_URL)<input type="url" name="url" required maxlength="350" autocomplete="off"></label><label>Personal access token (OC_TOKEN)<input type="password" name="token" required maxlength="1500" autocomplete="off"></label><p>Copy the complete API address and an active database-scoped token from the <a href="https://app.originchaindb.com" target="_blank" rel="noreferrer">OriginChainDB console</a>. Use an identity with the permissions you want to grant.</p><button type="submit">Authorize ' + client + '</button></form><p>Close this page to cancel. Revoke the database token in the console to stop access.</p>');
}
async function verifyDatabase(url, token) {
  const response = await fetch(url + "/schemas", { headers: { Authorization: "Bearer " + token, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(9000) });
  await response.body?.cancel();
  return response.ok;
}

export function createApp(store, validate = verifyDatabase) {
  const app = express();
  app.disable("x-powered-by");
  const provider = new Provider(store);
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=31536000", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  });
  app.get("/", (_req, res) => res.type("html").send(home));
  app.get("/privacy", (_req, res) => res.type("html").send(page("How the connector handles data",
    '<p>Silicoyn Technologies Pvt Ltd operates this connector. It forwards tool requests to the database you authorize and returns its results to the AI client you choose.</p><p>We store the database address and personal access token encrypted with AWS KMS, and use them only for this connection. The grant expires after 30 days. Disconnecting through OAuth revocation removes the grant. You can also revoke your database token in the console. Expired records are scheduled for deletion. The connector does not persist query text or results. Your database and AI provider apply their own retention settings.</p><p>The service runs in AWS Mumbai. For account and data requests, <a href="https://originchaindb.com/contact">contact OriginChainDB</a> and consult the company privacy policy below.</p>')));
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    if (!process.env.OPENAI_DOMAIN_CHALLENGE) return res.sendStatus(404);
    res.type("text/plain").send(process.env.OPENAI_DOMAIN_CHALLENGE);
  });
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({ resource, authorization_servers: [issuer + "/"], scopes_supported: [scope] }));
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(issuer), resourceServerUrl: new URL(resource),
    scopesSupported: [scope], resourceName: "OriginChainDB", serviceDocumentationUrl: new URL(issuer),
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));
  app.use("/connect", express.urlencoded({ extended: false, limit: "4kb" }));
  app.all("/connect", async (req, res) => {
    if (!["GET", "POST"].includes(req.method)) return res.sendStatus(405);
    const ticket = req.method === "POST" ? req.body?.request : req.query.request;
    if (typeof ticket !== "string" || !/^[\w-]{43}$/.test(ticket)) return res.status(400).send("Start the connection in your AI client.");
    const request = await store.get("request", ticket);
    const browser = /(?:^|;\s*)__Host-oc_mcp=([\w-]{43})(?:;|$)/.exec(req.get("Cookie") ?? "")?.[1];
    if (!browser || !request || digest(browser) !== request.browser) return res.status(403).send("This connection request expired or belongs to another browser. Restart it in your AI client.");
    if (req.method === "GET") return res.type("html").send(consentForm(marketplaceClient(request.redirect), ticket));
    if (req.get("Origin") !== issuer) return res.sendStatus(403);
    const url = managedDatabase(req.body.url);
    const token = req.body.token;
    if (!url || typeof token !== "string" || !/^oc_pat_[A-Za-z0-9._~-]{8,1493}$/.test(token)) return res.status(400).send("Enter the complete managed database URL from Connect and a personal access token beginning with oc_pat_.");
    let valid;
    try { valid = await validate(url, token); } catch { return res.status(502).send("The managed database could not be reached. Check its address and try again."); }
    if (!valid) return res.status(403).send("The database declined schema access. Check that the token is active for the selected database.");
    const target = await provider.authorizeDatabase(ticket, request, url, token);
    res.clearCookie("__Host-oc_mcp", { secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    return res.redirect(303, target);
  });
  app.all("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
    if (req.get("Origin") && ![issuer, "https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://platform.openai.com"].includes(req.get("Origin"))) return res.sendStatus(403);
    const token = /^Bearer ([\w-]{43})$/i.exec(req.get("Authorization") ?? "")?.[1];
    let connection;
    try {
      if (!token) throw new InvalidTokenError();
      connection = await provider.connection(token);
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) throw error;
      res.set("WWW-Authenticate", 'Bearer resource_metadata="' + issuer + '/.well-known/oauth-protected-resource/mcp", scope="database"');
      return res.status(401).json({ error: "invalid_token" });
    }
    if (req.method !== "POST") return res.set("Allow", "POST").sendStatus(405);
    const server = createDatabaseServer({ ...connection, timeoutMs: 18000, sqlPrefixOnly: false, warnings: [] });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const h of ["content-type", "accept", "mcp-protocol-version"]) if (req.get(h)) headers.set(h, req.get(h));
      const response = await transport.handleRequest(new Request(resource, { method: "POST", headers }), { parsedBody: req.body });
      response.headers.forEach((value, key) => res.set(key, value));
      res.status(response.status).send(await response.text());
    } finally { await server.close(); }
  });
  app.use((error, _req, res, _next) => {
    if (error instanceof InvalidGrantError) return res.status(400).send("Authorization expired. Restart the connection.");
    const status = [400, 413, 415].includes(error.status) ? error.status : 500;
    res.status(status).send(status === 500 ? "The connector could not complete this request." : "Invalid request.");
  });
  return app;
}
export const handler = serverless(createApp(new GrantStore(process.env.GRANT_TABLE, process.env.GRANT_KEY)));
