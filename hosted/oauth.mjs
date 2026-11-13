import { InvalidGrantError, InvalidClientMetadataError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { nonce, digest, now } from "./store.mjs";

export const issuer = "https://mcp.originchain.ai";
export const resource = issuer + "/mcp";
export const scope = "database";
const grantLifetime = 30 * 86400;
export function marketplaceClient(uri) {
  if (uri === "https://claude.ai/api/mcp/auth_callback" || uri === "https://claude.com/api/mcp/auth_callback") return "Claude";
  if (uri === "https://chatgpt.com/connector_platform_oauth_redirect" || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri)) return "ChatGPT";
}
function checkResource(value) {
  if (value !== undefined && String(value) !== resource) throw new InvalidTargetError("Resource does not match this MCP server.");
}
function checkScope(scopes) {
  if (scopes?.some(s => s !== scope)) throw new InvalidScopeError("Only the database scope is supported.");
}
export class Provider {
  constructor(store) {
    this.store = store;
    this.clientsStore = {
      getClient: id => this.store.get("client", id),
      registerClient: async c => {
        if (!c.redirect_uris?.length || c.redirect_uris.length > 8 || c.redirect_uris.some(uri => !marketplaceClient(uri)) ||
            ![undefined, "none", "client_secret_post"].includes(c.token_endpoint_auth_method)) {
          throw new InvalidClientMetadataError("Register the exact Claude or ChatGPT callback, using none or client_secret_post.");
        }
        // Keep only the metadata needed to authenticate the registered client.
        const saved = { client_id: c.client_id, redirect_uris: c.redirect_uris, client_secret: c.client_secret,
          client_secret_expires_at: c.client_secret_expires_at, token_endpoint_auth_method: c.token_endpoint_auth_method };
        await this.store.put("client", c.client_id, saved);
        return { ...c, ...saved };
      },
    };
  }
  async authorize(client, params, res) {
    checkResource(params.resource);
    checkScope(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 1024) throw new InvalidRequestError("Invalid authorization parameters.");
    const ticket = nonce();
    const browser = nonce();
    await this.store.put("request", ticket, { client: client.client_id, redirect: params.redirectUri, challenge: params.codeChallenge,
      state: params.state, browser: digest(browser) }, now() + 600);
    res.cookie("__Host-oc_mcp", browser, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600000 });
    res.redirect(303, "/connect?request=" + ticket);
  }
  async authorizeDatabase(ticket, request, url, token) {
    const grant = nonce();
    const code = nonce();
    const expires = now() + grantLifetime;
    const ciphertext = await this.store.seal(grant, { url, token });
    const ok = await this.store.exchange("request", ticket, [
      this.store.item("grant", grant, { ciphertext, client: request.client }, expires),
      this.store.item("code", code, { client: request.client, grant, expires, challenge: request.challenge, redirect: request.redirect }, now() + 120),
    ]);
    if (!ok) throw new InvalidGrantError("Authorization request expired or was already used.");
    const target = new URL(request.redirect);
    target.searchParams.set("code", code);
    if (request.state) target.searchParams.set("state", request.state);
    return target.href;
  }
  async challengeForAuthorizationCode(client, code) {
    const data = await this.store.get("code", code);
    if (!data || data.client !== client.client_id) throw new InvalidGrantError("Invalid authorization code.");
    return data.challenge;
  }
  async issue(type, id, data) {
    const access = nonce();
    const refresh = nonce();
    const tokenData = { grant: data.grant, client: data.client, expires: data.expires, resource, scope };
    const expires = Math.min(now() + 3600, data.expires);
    const ok = await this.store.exchange(type, id, [
      this.store.item("access", access, tokenData, expires), this.store.item("refresh", refresh, tokenData, data.expires),
    ]);
    if (!ok) throw new InvalidGrantError("Token was already exchanged or expired.");
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", scope, expires_in: expires - now() };
  }
  async exchangeAuthorizationCode(client, code, _verifier, redirect, audience) {
    checkResource(audience);
    const data = await this.store.get("code", code);
    if (!data || data.client !== client.client_id || redirect !== data.redirect) throw new InvalidGrantError("Invalid code or redirect URI.");
    return this.issue("code", code, data);
  }
  async exchangeRefreshToken(client, refresh, scopes, audience) {
    checkScope(scopes);
    checkResource(audience);
    const data = await this.store.get("refresh", refresh);
    if (!data || data.client !== client.client_id || !(await this.store.get("grant", data.grant))) throw new InvalidGrantError("Refresh token is invalid or expired.");
    return this.issue("refresh", refresh, data);
  }
  async connection(access) {
    const data = await this.store.get("access", access);
    if (!data || data.resource !== resource || data.scope !== scope) throw new InvalidTokenError("Invalid MCP access token.");
    const grant = await this.store.get("grant", data.grant);
    if (!grant || grant.client !== data.client) throw new InvalidTokenError("Connection has expired.");
    return this.store.unseal(data.grant, grant.ciphertext);
  }
  async revokeToken(client, { token }) {
    const data = await this.store.get("refresh", token) ?? await this.store.get("access", token);
    if (data?.client === client.client_id) await this.store.revokeGrant(data.grant);
  }
}
