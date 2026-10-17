import { readLimited, RESPONSE_BODY_LIMIT, truncateBytes } from '../lib/http-body'
import type { SendOutcome } from './types'

export const SEND_TIMEOUT_MS = 10_000
/** Enough for any provider's JSON reply; only RESPONSE_BODY_LIMIT is kept. */
const READ_LIMIT = 64 * 1024

/** A provider-level failure inside an HTTP response (e.g. `{"errcode": 45009}` with status 200). */
export interface AppError {
  error: string
  retryable?: boolean
  retryAfterMs?: number | null
}

/**
 * Inspect a response. Return an AppError for failures, null for success.
 * Called for every response; for non-2xx it only refines the error message
 * and may mark the failure retryable.
 */
export type ResponseCheck = (json: any, status: number) => AppError | null

/** Seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/** Common error fields of the APIs we call. */
function describe(json: any): string | null {
  if (!json || typeof json !== 'object') return null
  const msg = json.message ?? json.description ?? json.msg ?? json.errmsg ?? json.StatusMessage ?? json.error
  return typeof msg === 'string' && msg ? msg : null
}

/**
 * Send one request and classify the result. Network errors, timeouts, 408,
 * 429 and 5xx are retryable; other 4xx are not.
 */
export async function deliverHttp(url: string, init: RequestInit, check?: ResponseCheck): Promise<SendOutcome> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
    return {
      ok: false,
      retryable: true,
      retryAfterMs: null,
      httpStatus: null,
      responseBody: null,
      error: timedOut ? `timeout after ${SEND_TIMEOUT_MS}ms` : `network error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    }
  }
  let text = ''
  try {
    text = await readLimited(res, READ_LIMIT)
  } catch {
    // The status is what matters; a broken body only loses the diagnostics.
  }
  const durationMs = Date.now() - started
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  const responseBody = text ? truncateBytes(text, RESPONSE_BODY_LIMIT) : null
  const app = check?.(json, res.status) ?? null

  if (!res.ok) {
    const rateLimited = res.status === 429
    const j = json as any
    const jsonRetryAfter = j?.parameters?.retry_after ?? j?.retry_after
    const retryAfterMs = rateLimited
      ? (parseRetryAfter(res.headers.get('retry-after')) ??
        (typeof jsonRetryAfter === 'number' ? Math.ceil(jsonRetryAfter * 1000) : null))
      : null
    const detail = app?.error ?? describe(json)
    return {
      ok: false,
      retryable: rateLimited || res.status === 408 || res.status >= 500 || app?.retryable === true,
      retryAfterMs: retryAfterMs ?? app?.retryAfterMs ?? null,
      httpStatus: res.status,
      responseBody,
      error: detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`,
      durationMs,
    }
  }
  if (app) {
    return {
      ok: false,
      retryable: app.retryable ?? false,
      retryAfterMs: app.retryAfterMs ?? null,
      httpStatus: res.status,
      responseBody,
      error: app.error,
      durationMs,
    }
  }
  return { ok: true, httpStatus: res.status, responseBody, durationMs }
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}, check?: ResponseCheck) {
  return deliverHttp(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'cf-sender', ...headers },
      body: JSON.stringify(body),
    },
    check,
  )
}
