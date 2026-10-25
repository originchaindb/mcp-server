import type { Config } from './config.js';

/** One HTTP attempt per MCP call; the deadline includes reading the response body. */
export function createHttpClient(config: Config) {
  const base = `${config.origin}/v1/tenants/${encodeURIComponent(config.tenant)}`;
  return async function ocFetch(
    method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let abortedBy: 'caller' | 'timeout' | undefined;
    const abort = (cause: 'caller' | 'timeout') => {
      if (!controller.signal.aborted) {
        abortedBy = cause;
        controller.abort();
      }
    };
    const onCancel = () => abort('caller');
    signal?.addEventListener('abort', onCancel, { once: true });
    if (signal?.aborted) onCancel();
    const timer = setTimeout(() => abort('timeout'), config.timeoutMs);
    timer.unref();
    const operation = `OriginChain ${method} ${path}`;
    try {
      controller.signal.throwIfAborted();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.token}`, Accept: 'application/json',
      };
      if (config.dbUser !== undefined && config.dbKey !== undefined) {
        headers['X-OC-DB-User'] = config.dbUser;
        headers['X-OC-DB-Key'] = config.dbKey;
      }
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'manual' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${base}${path}`, init);
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new Error(`${operation}: HTTP redirect (${res.status}) refused; configure OC_HOST with the direct database origin`);
      }
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (!res.ok) {
        const detail = typeof parsed === 'object' && parsed !== null
          ? JSON.stringify(parsed) : String(parsed ?? res.statusText);
        throw new Error(`${operation} → ${res.status}: ${detail}`);
      }
      return parsed;
    } catch (error) {
      if (abortedBy) {
        const detail = abortedBy === 'timeout' ? `timed out after ${config.timeoutMs} ms` : 'cancelled';
        throw new Error(`${operation} ${detail}; completion of a submitted operation is unknown`);
      }
      // Keep deliberate HTTP errors; runtime fetch errors must not reveal connection settings.
      if (error instanceof Error && error.message.startsWith(operation)) throw error;
      throw new Error(`${operation}: HTTP request failed`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
  };
}
