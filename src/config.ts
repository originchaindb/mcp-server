export interface Config {
  origin: string;
  tenant: string;
  token: string;
  dbUser?: string;
  dbKey?: string;
  timeoutMs: number;
  sqlPrefixOnly: boolean;
}

/** Validate connection settings before accepting MCP requests. Never echo secrets. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`env var ${name} is required and missing`);
    return value;
  };
  const header = (name: string, value: string): string => {
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new Error(`${name} must contain only visible ASCII characters without spaces`);
    }
    return value;
  };
  const rawHost = required('OC_HOST');
  let host: URL;
  try {
    host = new URL(rawHost);
  } catch {
    throw new Error("OC_HOST must be an absolute HTTP(S) origin");
  }
  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(rawHost) || /[\x00-\x20\x7f]/.test(rawHost) || rawHost.includes('@') ||
      !['https:', 'http:'].includes(host.protocol) || host.username || host.password ||
      host.pathname !== '/' || host.search || host.hash) {
    throw new Error("OC_HOST must be an HTTP(S) origin without credentials, a path, query or fragment");
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname);
  if (host.protocol === 'http:' && !loopback && env.OC_ALLOW_INSECURE_HTTP !== 'true') {
    throw new Error("OC_HOST must use HTTPS; non-loopback HTTP requires OC_ALLOW_INSECURE_HTTP=true");
  }
  const tenant = required('OC_TENANT');
  if (!tenant.trim() || tenant === '.' || tenant === '..') {
    throw new Error('OC_TENANT must be a nonempty tenant identifier, not a dot segment');
  }
  const token = header('OC_TOKEN', required('OC_TOKEN'));
  const hasUser = env.OC_DB_USER !== undefined;
  const hasKey = env.OC_DB_KEY !== undefined;
  if (hasUser !== hasKey) throw new Error('OC_DB_USER and OC_DB_KEY must be supplied together');
  const dbUser = hasUser ? header('OC_DB_USER', required('OC_DB_USER')) : undefined;
  const dbKey = hasKey ? header('OC_DB_KEY', required('OC_DB_KEY')) : undefined;
  const rawTimeout = env.OC_MCP_TIMEOUT_MS ?? '60000';
  const timeoutMs = Number(rawTimeout);
  if (!/^[1-9]\d*$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs > 2147483647) {
    throw new Error('OC_MCP_TIMEOUT_MS must be an integer from 1 to 2147483647');
  }
  return { origin: host.origin, tenant, token, dbUser, dbKey, timeoutMs,
    sqlPrefixOnly: env.OC_MCP_READONLY === 'true' };
}
