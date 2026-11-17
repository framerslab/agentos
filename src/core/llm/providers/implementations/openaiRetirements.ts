/**
 * @file openaiRetirements.ts
 * @description The OpenAI text models OpenAI has shut down or has set a shutdown date for, each with the current
 * model that does its job for the least money. OpenAIProvider refuses a call to a shut-down model on OpenAI's own
 * endpoint before it draws a key or sends anything, with an error that names the replacement, and leaves shut-down
 * models out of the models it lists. A model with a shutdown date still to come is served until OpenAI ends it; its row
 * says when, and is marked shut down when the deprecations page is read again after that date.
 *
 * Source: https://developers.openai.com/api/docs/deprecations and the model pages under
 * https://developers.openai.com/api/docs/models, read on 17 November 2026. A call to each shut-down id that day
 * answered HTTP 404 `model_not_found`, while `GET /v1/models/{id}` still answered 200 for most of them, so the models
 * list, not a model lookup, tells a served model from a retired one.
 *
 * A replacement is chosen by the job, then the price, among the models OpenAI serves and has not deprecated
 * (US dollars per 1M tokens, input / cached input / output, https://developers.openai.com/api/docs/pricing):
 *
 * | Job | Replacement | Price |
 * |---|---|---|
 * | small and quick: classify, extract, tag, route, a short reply (the mini and nano models, `gpt-3.5-turbo`) | `gpt-6-luna` | $0.10 / $0.01 / $0.50 |
 * | general work and reasoning (`gpt-4-turbo`, `chatgpt-4o-latest`, `o1`, `o3`, `gpt-5`, `gpt-5.1`, the dated `gpt-4o` and `gpt-4.1` snapshots) | `gpt-6.2-sol` | $2.00 / $0.10 / $10.00 |
 * | the pro reasoning tier (`gpt-5-pro`, `o3-pro`) | `gpt-6.2-astra` | $8.00 / $0.40 / $40.00 |
 *
 * `gpt-6.2-sol` and `gpt-6.2-astra` always reason and bill their reasoning tokens as output, and refuse `temperature`,
 * `top_p`, `stop`, the sampling penalties and function tools on Chat Completions; OpenAIProvider sends neither model
 * what it refuses and sends its tool calls to the Responses API.
 */

/** One OpenAI model OpenAI has shut down or set a shutdown date for. */
export interface OpenAIModelShutdown {
  /** The model id as OpenAI names it, an alias or a dated snapshot. */
  readonly modelId: string;
  /** `shut-down`: OpenAI no longer serves it. `scheduled`: OpenAI serves it until {@link shutdownOn}. */
  readonly state: 'shut-down' | 'scheduled';
  /** The UTC day OpenAI ends it, `YYYY-MM-DD`; absent where the model page says "Shut down" and gives no day. */
  readonly shutdownOn?: string;
  /** The current model that does this model's job for the least money (see the table in this module's header). */
  readonly replacement: string;
  /** The public page the row was read from. */
  readonly source: string;
}

const DEPRECATIONS = 'https://developers.openai.com/api/docs/deprecations';

function rows(
  state: OpenAIModelShutdown['state'],
  shutdownOn: string | undefined,
  replacement: string,
  modelIds: readonly string[],
  source: string = DEPRECATIONS,
): OpenAIModelShutdown[] {
  return modelIds.map((modelId) => Object.freeze({ modelId, state, ...(shutdownOn ? { shutdownOn } : {}), replacement, source }));
}

/**
 * Every row, frozen. The deprecations page's "Past deprecations" lists the 23 October 2026 and 17 February 2026
 * shutdowns; its "Upcoming deprecations" lists the scheduled ones. `gpt-4o-2024-05-13` is marked "Shut down" on the
 * gpt-4o model page, which gives no day. The `gpt-4o`, `gpt-4o-mini`, `gpt-4.1` and `gpt-4.1-mini` aliases are not
 * rows: the page names only their dated snapshots for 14 January 2027.
 */
export const OPENAI_MODEL_SHUTDOWNS: readonly OpenAIModelShutdown[] = Object.freeze([
  ...rows('shut-down', '2026-10-23', 'gpt-6-luna', [
    'gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14',
    'o3-mini', 'o3-mini-2025-01-31', 'o4-mini', 'o4-mini-2025-04-16',
  ]),
  ...rows('shut-down', '2026-10-23', 'gpt-6.2-sol', ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'o1', 'o1-2024-12-17']),
  ...rows('shut-down', '2026-02-17', 'gpt-6.2-sol', ['chatgpt-4o-latest']),
  ...rows('shut-down', undefined, 'gpt-6.2-sol', ['gpt-4o-2024-05-13'], 'https://developers.openai.com/api/docs/models/gpt-4o'),
  ...rows('scheduled', '2026-12-11', 'gpt-6-luna', ['gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5-nano', 'gpt-5-nano-2025-08-07']),
  ...rows('scheduled', '2026-12-11', 'gpt-6.2-sol', ['gpt-5', 'gpt-5-2025-08-07', 'o3', 'o3-2025-04-16']),
  ...rows('scheduled', '2026-12-11', 'gpt-6.2-astra', ['gpt-5-pro', 'gpt-5-pro-2025-10-06', 'o3-pro', 'o3-pro-2025-06-10']),
  ...rows('scheduled', '2027-01-14', 'gpt-6-luna', ['gpt-4o-mini-2024-07-18', 'gpt-4.1-mini-2025-04-14']),
  ...rows('scheduled', '2027-01-14', 'gpt-6.2-sol', ['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4.1-2025-04-14']),
  ...rows('scheduled', '2027-04-01', 'gpt-6.2-sol', ['gpt-5.1', 'gpt-5.1-2025-11-13']),
]);

const BY_ID: ReadonlyMap<string, OpenAIModelShutdown> = new Map(OPENAI_MODEL_SHUTDOWNS.map((row) => [row.modelId, row]));

/**
 * The shutdown row of `modelId`, shut down or scheduled: its own row, else, for a dated snapshot the table does not
 * list, its base model's. Case-insensitive. A model with no row returns `undefined`.
 *
 * @param modelId Model id as a caller names it (e.g. `'o4-mini'`, `'gpt-5-2025-08-07'`).
 */
export function openAIModelShutdown(modelId: string | undefined): OpenAIModelShutdown | undefined {
  if (!modelId) return undefined;
  const id = modelId.trim().toLowerCase();
  return BY_ID.get(id) ?? BY_ID.get(id.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
}

/**
 * The row of `modelId` when OpenAI no longer serves it, else `undefined` (a scheduled shutdown is still served).
 *
 * @param modelId Model id as a caller names it.
 */
export function retiredOpenAIModel(modelId: string | undefined): OpenAIModelShutdown | undefined {
  const row = openAIModelShutdown(modelId);
  return row?.state === 'shut-down' ? row : undefined;
}

/**
 * The message of the error a call to a shut-down model ends with: what was asked for, since when OpenAI no longer
 * serves it, and the model to use instead.
 *
 * @param modelId The model id the call named.
 * @param row Its row from {@link retiredOpenAIModel}.
 */
export function retiredOpenAIModelMessage(modelId: string, row: OpenAIModelShutdown): string {
  const since = row.shutdownOn ? ` on ${row.shutdownOn}` : '';
  return `OpenAI shut down ${modelId}${since} and answers a call to it with 404. Use ${row.replacement} instead (${row.source}).`;
}
