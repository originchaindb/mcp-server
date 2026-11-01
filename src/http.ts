import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';

/**
 * `Retry-After` as a whole number of seconds, in milliseconds; anything else
 * (absent, an HTTP date, a fraction) is not a retry instruction here.
 */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/**
 * At most two HTTP attempts per MCP call. The only retry is one resend after a
 * 503 whose `Retry-After` is a whole number of seconds: the database answers that
 * way when it has not carried out the request (waking up, or briefly busy) and it
 * can be sent again. A 503 without that header, every other
 * status, a timeout and a cancellation are never retried. The deadline covers the
 * whole call: both attempts, the wait between them, and reading the response body;
 * a wait that would not fit inside it is not started.
 * Every request goes to OC_URL exactly as configured, with the door path appended.
 */
export function createHttpClient(config: Config) {
  const base = config.url;
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
    const startedAt = Date.now();
    const timer = setTimeout(() => abort('timeout'), config.timeoutMs);
    timer.unref();
    const operation = `OriginChain ${method} ${path}`;
    try {
      controller.signal.throwIfAborted();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.token}`, Accept: 'application/json',
      };
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'manual' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      let res = await fetch(`${base}${path}`, init);
      if (res.status === 503) {
        const waitMs = retryAfterMs(res.headers.get('retry-after'));
        if (waitMs !== undefined && Date.now() - startedAt + waitMs < config.timeoutMs) {
          await res.body?.cancel();
          await sleep(waitMs, undefined, { signal: controller.signal });
          res = await fetch(`${base}${path}`, init);
        }
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new Error(`${operation}: HTTP redirect (${res.status}) refused; use OC_URL exactly as copied from Connect`);
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
