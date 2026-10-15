/**
 * @module voice-pipeline/providers/DeepgramUsage
 * Project request-cost evidence for supplier-credit reconciliation, read from Deepgram's List Project Requests endpoint
 * (https://developers.deepgram.com/reference/manage/requests/list), read 15 October 2026. Its example response holds
 * each request's cost in `response.details.usd`, and the Logs & Usage guide
 * (https://developers.deepgram.com/docs/using-logs-usage), read the same day, names that field as the request's cost in
 * US dollars. The endpoint takes `start` and `end` as `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS` or
 * `YYYY-MM-DDTHH:MM:SS+HH:MM`, and request logs can be read back for 90 days. The deprecated project usage response and
 * the usage breakdown carry no cost. A host verifies complete cost coverage, interval semantics and reporting delay for
 * its own account before relying on this evidence.
 */

/** Fixed failure codes; never include a response body, URL query or key. */
export type DeepgramUsageFailureCode =
  | 'contract' | 'shape' | 'http' | 'transport' | 'body_limit'
  | 'page_limit' | 'duplicate' | 'unstable';

/** A failed check, carrying only its code; a host keeps its last successful evidence and counts the failed day. */
export class DeepgramUsageReadError extends Error {
  constructor(readonly code: DeepgramUsageFailureCode) {
    super(`Deepgram usage read failed: ${code}`);
    this.name = 'DeepgramUsageReadError';
  }
}

/** Dated host verification, not an inference from an API key or a successful HTTP status. */
export interface DeepgramUsageContract {
  /** Immutable evidence version for scope, totals, boundaries, pagination and lag. */
  readonly version: string;
  /** UTC epoch milliseconds when those facts were verified. */
  readonly verifiedAtMs: number;
  /** UTC epoch milliseconds beyond which the evidence is no longer accepted. */
  readonly validUntilMs: number;
  /** Verified bound from request creation through finalized reported cost. */
  readonly maxReportingLagMs: number;
}

/** One final request cost, with raw request content removed. */
export interface DeepgramRequestCost {
  readonly requestId: string;
  readonly createdAtMs: number;
  readonly completedAtMs: number;
  readonly costMicro: number;
}

/** Two equal complete traversals for a fixed inclusive creation-time interval. */
export interface DeepgramUsageEvidence {
  readonly projectId: string;
  readonly fromMs: number;
  readonly throughMs: number;
  readonly checkedAtMs: number;
  readonly contractVersion: string;
  readonly costMicro: number;
  readonly requests: readonly DeepgramRequestCost[];
}

/** Private server inputs; only the resulting evidence can be stored or exposed. */
export interface DeepgramUsageReadOptions {
  readonly projectId: string;
  readonly apiKey: string;
  /** Interval start, UTC epoch milliseconds on a whole second, less than 90 days before `nowMs`. */
  readonly fromMs: number;
  /** Inclusive interval end, UTC epoch milliseconds on a whole second, at least the contract's lag before `nowMs`. */
  readonly throughMs: number;
  readonly nowMs: number;
  readonly contract: DeepgramUsageContract;
  /** Default 1000, within the documented [1,1000] range. */
  readonly pageSize?: number;
  /** Maximum pages per traversal. Default 500; reaching it is a failed check. */
  readonly maxPages?: number;
  /** Maximum duration for the whole check, including reading bodies. Default 60000. */
  readonly timeoutMs?: number;
}

/** Injectable transport for deterministic CI; production uses the fixed-origin fetch below. */
export type DeepgramUsageFetch = (url: string, init: RequestInit) => Promise<Response>;

/** How long Deepgram keeps request logs readable (the Logs & Usage guide, read 15 October 2026). */
const REQUEST_LOG_RETENTION_MS = 90 * 86_400_000;

const fail = (code: DeepgramUsageFailureCode): never => { throw new DeepgramUsageReadError(code); };
const whole = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('shape');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return fail('shape');
  return value;
}
function timestamp(value: unknown): number {
  const raw = text(value);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) return fail('shape');
  const at = Date.parse(raw);
  if (!whole(at)) return fail('shape');
  return at;
}
/** The documented `YYYY-MM-DDTHH:MM:SS+HH:MM` form in UTC, for an instant on a whole second. */
function queryTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
}

/** Exact decimal ceiling after JSON parsing, including small exponent-form USD values. */
function dollarsMicro(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail('shape');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) return fail('shape');
  const fraction = match[2] ?? '';
  const shift = 6 + Number(match[3] ?? 0) - fraction.length;
  const coefficient = BigInt(match[1]! + fraction);
  const power = 10n ** BigInt(Math.abs(shift));
  const micro = shift >= 0 ? coefficient * power : (coefficient + power - 1n) / power;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) return fail('shape');
  return Number(micro);
}

function requestCost(raw: unknown, options: DeepgramUsageReadOptions): DeepgramRequestCost {
  const row = object(raw);
  if (row.project_uuid !== options.projectId) return fail('shape');
  const requestId = text(row.request_id);
  const createdAtMs = timestamp(row.created);
  const response = object(row.response);
  const completedAtMs = timestamp(response.completed);
  if (createdAtMs < options.fromMs || createdAtMs > options.throughMs
    || completedAtMs < createdAtMs || completedAtMs > options.nowMs) return fail('shape');
  const costMicro = dollarsMicro(object(response.details).usd);
  return Object.freeze({ requestId, createdAtMs, completedAtMs, costMicro });
}

async function bodyJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return fail('shape');
  let size = 0;
  let content = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        return fail('body_limit');
      }
      content += decoder.decode(chunk.value, { stream: true });
    }
    content += decoder.decode();
    try { return JSON.parse(content) as unknown; }
    catch { return fail('shape'); }
  } finally { reader.releaseLock(); }
}

function validate(options: DeepgramUsageReadOptions): void {
  const c = options.contract;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.projectId)
    || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)
    || !whole(options.fromMs) || !whole(options.throughMs) || !whole(options.nowMs)
    || options.fromMs % 1000 !== 0 || options.throughMs % 1000 !== 0
    || options.fromMs > options.throughMs
    || options.fromMs <= options.nowMs - REQUEST_LOG_RETENTION_MS
    || !c || !c.version.trim() || !whole(c.verifiedAtMs) || !whole(c.validUntilMs)
    || !whole(c.maxReportingLagMs) || c.verifiedAtMs > options.nowMs
    || c.validUntilMs <= options.nowMs
    || options.throughMs > options.nowMs - c.maxReportingLagMs) return fail('contract');
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 500;
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) return fail('contract');
}

async function traverse(
  options: DeepgramUsageReadOptions,
  fetcher: DeepgramUsageFetch,
  signal: AbortSignal,
): Promise<readonly DeepgramRequestCost[]> {
  const limit = options.pageSize ?? 1000;
  const costs = new Map<string, DeepgramRequestCost>();
  for (let page = 0; page < (options.maxPages ?? 500); page++) {
    signal.throwIfAborted();
    const url = new URL(`https://api.deepgram.com/v1/projects/${options.projectId}/requests`);
    url.searchParams.set('start', queryTime(options.fromMs));
    url.searchParams.set('end', queryTime(options.throughMs));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    const response = await fetcher(url.toString(), {
      method: 'GET', redirect: 'error', signal,
      headers: { Authorization: `Token ${options.apiKey}`, Accept: 'application/json' },
    });
    if (!response.ok) return fail('http');
    const body = object(await bodyJson(response));
    signal.throwIfAborted();
    if (body.page !== page || body.limit !== limit || !Array.isArray(body.requests)
      || body.requests.length > limit) return fail('shape');
    for (const raw of body.requests) {
      const cost = requestCost(raw, options);
      if (costs.has(cost.requestId)) return fail('duplicate');
      costs.set(cost.requestId, cost);
    }
    if (body.requests.length < limit) {
      return Object.freeze([...costs.values()].sort((a, b) =>
        a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
    }
  }
  return fail('page_limit');
}

/**
 * Reads all project request costs, without a model, status, endpoint or key filter.
 * Two traversals must return the same identities, times and costs. The verified
 * contract bounds reporting delay; this operation cannot establish that bound.
 * No missing field or unknown category is interpreted as zero: a request whose
 * response or cost is not recorded yet fails the check. It returns no balance
 * and no claimed promotional-credit allocation.
 *
 * @param options - Fixed project interval, private credential and verified contract.
 * @param fetcher - Injectable HTTP transport; omitted in production.
 * @returns Frozen sanitized evidence, priced in whole micro-dollars.
 * @throws {DeepgramUsageReadError} For invalid options or evidence, an interval outside the readable request logs, or
 *   an incomplete or failed read.
 */
export async function readDeepgramUsage(
  options: DeepgramUsageReadOptions,
  fetcher: DeepgramUsageFetch = (url, init) => fetch(url, init),
): Promise<DeepgramUsageEvidence> {
  validate(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const first = await traverse(options, fetcher, controller.signal);
    const second = await traverse(options, fetcher, controller.signal);
    if (JSON.stringify(first) !== JSON.stringify(second)) return fail('unstable');
    let costMicro = 0;
    for (const row of second) {
      costMicro += row.costMicro;
      if (!whole(costMicro)) return fail('shape');
    }
    return Object.freeze({
      projectId: options.projectId,
      fromMs: options.fromMs,
      throughMs: options.throughMs,
      checkedAtMs: options.nowMs,
      contractVersion: options.contract.version,
      costMicro,
      requests: second,
    });
  } catch (error) {
    if (error instanceof DeepgramUsageReadError) throw error;
    throw new DeepgramUsageReadError('transport');
  } finally { clearTimeout(timer); }
}
