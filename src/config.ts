export interface Config {
  /** The database's address (OC_URL), used as given; door paths such as `/sql` are appended. */
  url: string;
  token: string;
  timeoutMs: number;
  /** OC_MCP_READONLY=true: oc_sql forwards only a statement `isReadOnlySql` accepts. */
  sqlReadOnly: boolean;
}

const REPLACEMENT = "set OC_URL to your database's address from Connect";

/**
 * Validate connection settings before accepting MCP requests. Never echo secrets
 * or the configured address.
 *
 * The connection is exactly two values: OC_URL (opaque: never built, edited or
 * parsed here; door paths are appended) and OC_TOKEN (sent unchanged as
 * `Authorization: Bearer`). Every earlier connection setting is refused, even
 * alongside them, so a configuration never runs on something it does not say.
 */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  rejectRetiredAddress(env);
  rejectRetiredIdentity(env);
  const token = readToken(env);
  const url = readUrl(env);
  const rawTimeout = env.OC_MCP_TIMEOUT_MS ?? '60000';
  const timeoutMs = Number(rawTimeout);
  if (!/^[1-9]\d*$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs > 2147483647) {
    throw new Error('OC_MCP_TIMEOUT_MS must be an integer from 1 to 2147483647');
  }
  return { url, token, timeoutMs, sqlReadOnly: env.OC_MCP_READONLY === 'true' };
}

function readToken(env: NodeJS.ProcessEnv): string {
  const token = env.OC_TOKEN;
  if (!token) {
    throw new Error('env var OC_TOKEN is required and missing; set it to an access token from Access tokens');
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('OC_TOKEN must contain only visible ASCII characters without spaces');
  }
  return token;
}

/**
 * OC_URL is checked, never rewritten. It must be an absolute HTTP(S) URL with no
 * userinfo, query or fragment, and its path must already be in the form a URL
 * parser would send (no `.`/`..` segments or characters that would be
 * re-encoded), so the request goes exactly where the copied address points.
 * Trailing slashes are dropped before a door path is appended.
 */
function readUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.OC_URL ?? '';
  if (!raw) throw new Error(`env var OC_URL is required and missing; ${REPLACEMENT}`);
  const shape = /^(https?):\/\/([^/?#\\@]+)(\/[^?#\\]*)?$/i.exec(raw);
  let parsed: URL | undefined;
  try { parsed = new URL(raw); } catch { parsed = undefined; }
  if (!shape || !parsed || /[\x00-\x20\x7f]/.test(raw) ||
      !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw new Error("OC_URL must be your database's HTTP(S) address from Connect, without credentials, a query or a fragment");
  }
  const givenPath = (shape[3] ?? '').replace(/\/+$/, '');
  if (givenPath !== parsed.pathname.replace(/\/+$/, '')) {
    throw new Error('OC_URL must be used exactly as copied from Connect; its path contains a segment a URL parser would rewrite');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && !loopback && env.OC_ALLOW_INSECURE_HTTP !== 'true') {
    throw new Error('OC_URL must use HTTPS; non-loopback HTTP requires OC_ALLOW_INSECURE_HTTP=true');
  }
  return raw.replace(/\/+$/, '');
}

/**
 * The two-part address of 0.2.x and earlier is no longer read. Startup fails
 * while either part is set, even empty and even alongside OC_URL, and the error
 * names the replacement; the configured values are never printed.
 */
function rejectRetiredAddress(env: NodeJS.ProcessEnv): void {
  const set = ['OC_HOST', 'OC_TENANT'].filter(name => env[name] !== undefined);
  if (set.length) {
    throw new Error(`${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} retired; ${REPLACEMENT} ` +
      `and remove ${set.length > 1 ? 'them' : 'it'}.`);
  }
}

/**
 * Database-user headers are no longer sent. Ignoring these settings could run
 * requests with the bearer's own, possibly wider, permissions, so startup fails
 * instead and names the replacement.
 */
function rejectRetiredIdentity(env: NodeJS.ProcessEnv): void {
  const set = ['OC_DB_USER', 'OC_DB_KEY'].filter(name => env[name] !== undefined);
  if (set.length) {
    throw new Error(`${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} no longer supported; ` +
      'create an access token for that database identity, set it as OC_TOKEN, and remove the database-user settings.');
  }
}
