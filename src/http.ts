import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';

/**
 * What a request can do to the database. Only a `read` is ever resent: the
 * database can answer a write with a 503 and `Retry-After` after the write was
 * applied (a cross-shard transaction whose outcome is pending, or a write that
 * was applied but not acknowledged by enough replicas in time), so resending a
 * write could apply it twice.
 */
export type Effect = 'read' | 'may-write';

/**
 * An HTTP error status from the database. The message is the one tools show; the
 * status and parsed body let a tool recognise a specific refusal.
 */
export class HttpStatusError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/**
 * `Retry-After` as a whole number of seconds, in milliseconds; anything else
 * (absent, an HTTP date, a fraction) is not a retry instruction here.
 */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/** True when a response body states that the request was carried out anyway. */
function saysApplied(text: string): boolean {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && (body as Record<string, unknown>).applied_locally === true;
  } catch {
    return false;
  }
}

// Names that may stand directly before "(" in a statement that is resent: SQL
// keywords that take a parenthesised operand, type names with a modifier, and
// built-in functions that only read. Any other name before "(" may be a
// function that writes, so that statement is never resent.
const READ_ONLY_CALLS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'exists', 'any', 'all', 'some', 'as', 'on', 'using',
  'join', 'lateral', 'over', 'filter', 'within', 'case', 'when', 'then', 'else', 'by', 'having', 'between',
  'like', 'ilike', 'is', 'distinct', 'values', 'union', 'intersect', 'except', 'limit', 'offset', 'array',
  'row', 'cast', 'extract', 'position', 'substring', 'trim',
  'numeric', 'decimal', 'varchar', 'char', 'timestamp', 'time',
  'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'array_agg', 'string_agg', 'json_agg', 'jsonb_agg',
  'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'char_length', 'abs', 'round', 'floor',
  'ceil', 'trunc', 'mod', 'concat', 'substr', 'replace', 'left', 'right', 'date_trunc', 'to_char', 'now',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'json_build_object', 'jsonb_build_object',
]);

/**
 * Conservative test for an `oc_sql` statement that only reads, so it may be
 * resent once. This is not a SQL parser: it answers true only for one plain
 * `SELECT`, and false whenever it cannot tell. All of these must hold:
 * - the statement starts with `SELECT` and is the only one (one trailing `;` at most);
 * - it has no comment, quoted identifier or dollar quote (`$1`, `$2`, ... parameters are fine);
 * - the words `INTO` (creates a table), `FOR` (row locks), `WITH`, `INSERT`,
 *   `UPDATE`, `DELETE` and `MERGE` appear nowhere in it;
 * - every name directly before "(" is in READ_ONLY_CALLS and is not schema-qualified.
 * Words are matched anywhere in the text, string literals included, so a literal
 * can only make a statement count as a possible write, never as a read. The text
 * cannot show a write hidden behind a view, an operator or a cast; a 503 whose
 * body says the request was applied is therefore not resent either.
 */
export function isReadOnlySql(sql: string): boolean {
  const text = sql.replace(/;\s*$/, '').replace(/\$\d+/g, ' ');
  if (!/^\s*select\s/i.test(text)) return false;
  if (/[;"$]|--|\/\*/.test(text)) return false;
  if (/\b(into|for|with|insert|update|delete|merge)\b/i.test(text)) return false;
  for (const call of text.matchAll(/(\.\s*)?([\p{L}\p{N}_]+)\s*\(/gu)) {
    if (call[1] || !READ_ONLY_CALLS.has(call[2].toLowerCase())) return false;
  }
  return true;
}

/**
 * At most two HTTP attempts per MCP call. The only retry is one resend of a
 * `read` after a 503 whose `Retry-After` is a whole number of seconds (the
 * database is waking up or briefly busy) and whose body does not say the
 * request was applied. A `may-write` request, a 503 without that header, every
 * other status, a timeout and a cancellation are never retried. The deadline
 * covers the whole call: both attempts, the wait between them, and reading the
 * response body; a wait that would not fit inside it is not started.
 * Every request goes to OC_URL exactly as configured, with the door path appended.
 */
export function createHttpClient(config: Config) {
  const base = config.url;
  return async function ocFetch(
    method: 'GET' | 'POST', path: string, effect: Effect, body?: unknown, signal?: AbortSignal,
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
      let text: string | undefined;
      if (res.status === 503 && effect === 'read') {
        const waitMs = retryAfterMs(res.headers.get('retry-after'));
        if (waitMs !== undefined && Date.now() - startedAt + waitMs < config.timeoutMs) {
          text = await res.text();
          if (!saysApplied(text)) {
            text = undefined;
            await sleep(waitMs, undefined, { signal: controller.signal });
            res = await fetch(`${base}${path}`, init);
          }
        }
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new Error(`${operation}: HTTP redirect (${res.status}) refused; use OC_URL exactly as copied from Connect`);
      }
      text ??= await res.text();
      let parsed: unknown = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (!res.ok) {
        const detail = typeof parsed === 'object' && parsed !== null
          ? JSON.stringify(parsed) : String(parsed ?? res.statusText);
        throw new HttpStatusError(`${operation} → ${res.status}: ${detail}`, res.status, parsed);
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
