import type { ChatMessage, ModelCompletionOptions } from '../llm/providers/IProvider';
import type { ConversationMessage } from './ConversationMessage';
// No runtime imports needed from ConversationMessage (type-only above).
import { toolRoundBounds } from './toolRounds';

export interface RollingSummaryCompactionConfig {
  enabled: boolean;
  /**
   * Model id used for compaction.
   *
   * Note: model ids are provider-specific:
   * - OpenAI provider: `gpt-4o-mini`
   * - OpenRouter provider: `openai/gpt-4o-mini`
   *
   * Keep this cheap/fast by default; it runs occasionally.
   */
  modelId: string;
  /** Provider id override (optional). */
  providerId?: string;
  /** Minimum time between compaction passes per conversation. */
  cooldownMs: number;
  /**
   * Preserve the first N messages verbatim (usually system + initial user): the conversation's first N messages,
   * thoughts and errors not counted, which the next turn sends after every pass and no pass summarizes. A tool round the
   * first N messages reach into is kept whole with them.
   */
  headMessagesToKeep: number;
  /** Preserve the last N messages verbatim (fresh context). */
  tailMessagesToKeep: number;
  /** Minimum number of messages to summarize in a pass. */
  minMessagesToSummarize: number;
  /**
   * Maximum number of messages summarized per pass (older-first). A pass never ends inside a tool round, nor right
   * before a message the next turn sends that was recorded in the millisecond of the last message it takes, since the
   * next turn keeps messages by timestamp: it takes fewer when the limit falls at such a place, or, when taking fewer
   * would leave less than `minMessagesToSummarize`, goes on past the limit to the next place a pass may end before the
   * kept tail. The limit counts messages, not tokens.
   */
  maxMessagesToSummarizePerPass: number;
  /** Maximum output tokens for the compactor model. */
  maxOutputTokens: number;
  /** Optional temperature for the compactor model. */
  temperature?: number;
}

export interface RollingSummaryCompactionResult {
  enabled: boolean;
  didCompact: boolean;
  summaryText: string | null;
  summaryJson: any | null;
  summaryUptoTimestamp: number | null;
  summaryUpdatedAt: number | null;
  compactedMessageCount?: number;
  reason?: string;
}

export type RollingSummaryLlmCaller = (input: {
  providerId?: string;
  modelId: string;
  messages: ChatMessage[];
  options: ModelCompletionOptions;
}) => Promise<string>;

export const DEFAULT_ROLLING_SUMMARY_COMPACTION_CONFIG: RollingSummaryCompactionConfig = {
  enabled: false,
  modelId: 'gpt-4o-mini',
  cooldownMs: 60_000,
  headMessagesToKeep: 2,
  tailMessagesToKeep: 12,
  minMessagesToSummarize: 12,
  maxMessagesToSummarizePerPass: 48,
  maxOutputTokens: 900,
  temperature: 0.1,
};

export const DEFAULT_ROLLING_SUMMARY_SYSTEM_PROMPT_V1 = [
  'You are AgentOS Rolling Memory Compactor.',
  '',
  'Goal: Update a rolling memory summary + structured memory JSON from an existing summary and new conversation messages.',
  '',
  'You MUST output a single JSON object and nothing else.',
  '',
  'Output JSON schema (keys required):',
  '{',
  '  "summary_markdown": string,',
  '  "memory_json": {',
  '    "facts": Array<{ "text": string, "confidence"?: number, "sources"?: string[] }>,',
  '    "preferences": Array<{ "text": string, "sources"?: string[] }>,',
  '    "people": Array<{ "name": string, "notes"?: string, "sources"?: string[] }>,',
  '    "projects": Array<{ "name": string, "status"?: string, "notes"?: string, "sources"?: string[] }>,',
  '    "decisions": Array<{ "text": string, "sources"?: string[] }>,',
  '    "open_loops": Array<{ "text": string, "sources"?: string[] }>,',
  '    "todo": Array<{ "text": string, "sources"?: string[] }>,',
  '    "tags": string[]',
  '  }',
  '}',
  '',
  'Rules:',
  '- Prefer correctness over verbosity.',
  '- Never invent facts; if unsure, omit.',
  '- Keep "summary_markdown" concise (<= ~20 bullets total).',
  '- Use source message ids in "sources" when helpful.',
].join('\n');

type RollingSummaryState = {
  updatedAt?: number | null;
  summaryText?: string | null;
  summaryJson?: any | null;
  summaryUptoTimestamp?: number | null;
};

type ParsedCompactorOutput = {
  summary_markdown?: unknown;
  memory_json?: unknown;
};

function safeJsonParse(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): any | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const direct = safeJsonParse(trimmed);
  if (direct) return direct;

  // Try fenced block
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const fenced = safeJsonParse(fenceMatch[1].trim());
    if (fenced) return fenced;
  }

  // Try substring from first { to last }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = safeJsonParse(trimmed.slice(first, last + 1));
    if (sliced) return sliced;
  }
  return null;
}

function normalizeContentForCompactor(message: ConversationMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part: any) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.type === 'string') return `[${part.type}]`;
        return '[part]';
      })
      .filter(Boolean);
    return parts.join('\n');
  }
  if (message.content === null) {
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolNames = message.tool_calls.map((tc) => tc.name).filter(Boolean);
      return toolNames.length > 0 ? `[tool_calls:${toolNames.join(',')}]` : '[tool_calls]';
    }
    return '';
  }
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

/**
 * The text the compaction model reads for `message`. A tool result with no text, as a tool with no output returns,
 * still answers its call, so it reads as `[empty result]`: a pass summarizes it with its call and may end on it.
 */
function compactorText(message: ConversationMessage): string {
  const text = normalizeContentForCompactor(message).trim();
  return text.length === 0 && message.role === 'tool' ? '[empty result]' : text;
}

function isEligibleForRollingSummary(message: ConversationMessage): boolean {
  if (message.role === 'thought' || message.role === 'error' || message.role === 'summary') {
    return false;
  }
  return compactorText(message).length > 0;
}

/**
 * Whether the history the next turn sends leaves `message` out: `assembleConversationHistory` sends no thoughts and no
 * errors.
 */
function isLeftOutOfHistory(message: ConversationMessage): boolean {
  return message.role === 'thought' || message.role === 'error';
}

/**
 * The index just past the head the next turn sends after every pass: the conversation's first `headCount` messages
 * that are not thoughts or errors, and the rest of a tool round they reach into.
 *
 * @param messages - The conversation's messages, oldest first.
 * @param headCount - How many messages the head holds.
 * @param roundEnd - For each message, the index of the last message of its tool round (`toolRoundBounds(messages).end`).
 * @returns The index of the first message after the head.
 */
function keptHeadEnd(messages: ConversationMessage[], headCount: number, roundEnd: number[]): number {
  if (headCount <= 0) return 0;
  let counted = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (isLeftOutOfHistory(messages[index])) continue;
    counted += 1;
    if (counted === headCount) return roundEnd[index] + 1;
  }
  return messages.length;
}

function buildTurnsForCompactor(messages: ConversationMessage[]): Array<{ id: string; role: string; name?: string; content: string }> {
  return messages
    .map((m) => ({
      id: m.id,
      role: m.role,
      name: m.name,
      content: compactorText(m),
    }))
    .filter((m) => m.content.length > 0);
}

function resolveSystemPrompt(systemPrompt?: string): string {
  return (systemPrompt && systemPrompt.trim()) ? systemPrompt.trim() : DEFAULT_ROLLING_SUMMARY_SYSTEM_PROMPT_V1;
}

function resolveStateKey(stateKey?: string): string {
  return (stateKey && stateKey.trim()) ? stateKey.trim() : 'rollingSummaryState';
}

/**
 * Runs one rolling-summary pass over a conversation when it is due: once the cooldown since the last pass has run out,
 * it leaves the conversation's first `headMessagesToKeep` messages, takes the messages after them that the last
 * summary does not cover, leaves the last `tailMessagesToKeep` of those, summarizes up to
 * `maxMessagesToSummarizePerPass` of the rest, oldest first, and moves the summary's boundary (`summaryUptoTimestamp`)
 * to the newest message it summarized. The next turn sends the conversation's first `headMessagesToKeep` messages and
 * the messages newer than the boundary, so the next pass starts where this one ended.
 *
 * A tool round (an assistant message that names tool calls, the tool messages that answer them and anything between)
 * stays on one side of the boundary, since providers refuse a call without its result and a result without its call:
 * the kept head takes the rest of a round it reaches into, and the summary ends where a round ends and where the next
 * message the next turn sends is newer than the last one summarized, so no message it sends shares the boundary's
 * millisecond on the kept side. A boundary an earlier release stored inside a round leaves the rest of the round to
 * the next pass, which reads the round from its call. A tool result with no text reads as `[empty result]`, so the
 * compaction model reads each call it summarizes with its results.
 *
 * @param params - The conversation's messages, oldest first; its metadata, which holds the summary state under
 *   `stateKey`; the compaction settings; and the call that runs the compaction model.
 * @returns The summary state after the pass, with `updatedSessionMetadata` when the pass wrote a new summary.
 */
export async function maybeCompactConversationMessages(params: {
  messages: ConversationMessage[];
  sessionMetadata: Record<string, any>;
  config: RollingSummaryCompactionConfig;
  llmCaller: RollingSummaryLlmCaller;
  systemPrompt?: string;
  stateKey?: string;
  now?: number;
}): Promise<
  RollingSummaryCompactionResult & {
    updatedSessionMetadata?: Record<string, any>;
  }
> {
  const { config } = params;
  const now = typeof params.now === 'number' ? params.now : Date.now();
  const stateKey = resolveStateKey(params.stateKey);

  if (!config.enabled) {
    const state = params.sessionMetadata?.[stateKey] as RollingSummaryState | undefined;
    return {
      enabled: false,
      didCompact: false,
      summaryText: state?.summaryText ?? null,
      summaryJson: state?.summaryJson ?? null,
      summaryUptoTimestamp: typeof state?.summaryUptoTimestamp === 'number' ? state.summaryUptoTimestamp : null,
      summaryUpdatedAt: state?.updatedAt ?? null,
      reason: 'disabled',
    };
  }

  const priorState = (params.sessionMetadata?.[stateKey] as RollingSummaryState | undefined) ?? {};
  const lastUpdatedAt = typeof priorState.updatedAt === 'number' ? priorState.updatedAt : null;
  const summaryUptoTimestamp = typeof priorState.summaryUptoTimestamp === 'number' ? priorState.summaryUptoTimestamp : null;
  if (lastUpdatedAt && now - lastUpdatedAt < Math.max(0, config.cooldownMs)) {
    return {
      enabled: true,
      didCompact: false,
      summaryText: priorState.summaryText ?? null,
      summaryJson: priorState.summaryJson ?? null,
      summaryUptoTimestamp,
      summaryUpdatedAt: lastUpdatedAt,
      reason: 'cooldown',
    };
  }

  const messages = params.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      enabled: true,
      didCompact: false,
      summaryText: priorState.summaryText ?? null,
      summaryJson: priorState.summaryJson ?? null,
      summaryUptoTimestamp,
      summaryUpdatedAt: lastUpdatedAt,
      reason: 'no_messages',
    };
  }

  const headCount = Math.max(0, config.headMessagesToKeep);
  const tailCount = Math.max(0, config.tailMessagesToKeep);
  const afterTimestamp = typeof summaryUptoTimestamp === 'number' ? summaryUptoTimestamp : undefined;

  // Every tool round stays on one side of the boundary.
  const rounds = toolRoundBounds(messages);
  // The next turn sends the conversation's head after every pass, so no pass summarizes it: a pass takes the messages
  // after the head that the summary does not cover yet. `at[position]` is the index in `messages` of
  // `unsummarized[position]`.
  const headEnd = keptHeadEnd(messages, headCount, rounds.end);
  const at: number[] = [];
  messages.forEach((message, index) => {
    if (index < headEnd || !isEligibleForRollingSummary(message)) return;
    if (afterTimestamp && !(message.timestamp > afterTimestamp)) return;
    at.push(index);
  });
  // A boundary an earlier release stored inside a tool round summarized the round's first messages and not the rest:
  // the pass reads the round from its start, so the compaction model reads its results with the call they answer.
  if (at.length > 0 && rounds.start[at[0]] < at[0]) {
    const earlierMembers: number[] = [];
    for (let index = Math.max(rounds.start[at[0]], headEnd); index < at[0]; index += 1) {
      if (isEligibleForRollingSummary(messages[index])) earlierMembers.push(index);
    }
    at.unshift(...earlierMembers);
  }
  const unsummarized = at.map((index) => messages[index]);
  /** Whether the tool round of `unsummarized[position]` goes on after it. */
  const roundGoesOn = (position: number): boolean => rounds.end[at[position]] > at[position];
  /**
   * Whether a summary may end after the first `count` unsummarized messages: the last of them ends its tool round, and
   * the next message the next turn sends is newer than it, since the next turn keeps a message by its timestamp alone
   * and would hide one recorded in the boundary's millisecond. A thought or an error in that millisecond hides
   * nothing, since the next turn sends neither.
   */
  const endsCleanly = (count: number): boolean => {
    const last = at[count - 1];
    if (roundGoesOn(count - 1)) return false;
    let next = last + 1;
    while (next < messages.length && isLeftOutOfHistory(messages[next])) next += 1;
    return next === messages.length || messages[next].timestamp > messages[last].timestamp;
  };

  const tailStart = Math.max(0, unsummarized.length - tailCount);
  const minimum = Math.max(1, config.minMessagesToSummarize);
  const windowEnd = Math.min(tailStart, Math.max(1, config.maxMessagesToSummarizePerPass));

  // The summary ends at the latest clean cut that the kept tail and the limit for one pass allow.
  let summaryEnd = windowEnd;
  while (summaryEnd > 0 && !endsCleanly(summaryEnd)) {
    summaryEnd -= 1;
  }
  // The limit for one pass fell where no summary may end, and ending before that leaves too little: the summary goes
  // on to the next clean cut before the kept tail, so a tool round longer than the limit does not hold every later
  // pass at the same place.
  if (summaryEnd < windowEnd && summaryEnd < minimum) {
    let past = windowEnd + 1;
    while (past <= tailStart && !endsCleanly(past)) {
      past += 1;
    }
    if (past <= tailStart) summaryEnd = past;
  }

  const limitedCandidates = unsummarized.slice(0, summaryEnd);

  if (limitedCandidates.length < minimum) {
    return {
      enabled: true,
      didCompact: false,
      summaryText: priorState.summaryText ?? null,
      summaryJson: priorState.summaryJson ?? null,
      summaryUptoTimestamp,
      summaryUpdatedAt: lastUpdatedAt,
      reason: 'below_threshold',
    };
  }

  const previousSummaryText = priorState.summaryText ?? null;
  const previousSummaryJson = priorState.summaryJson ?? null;

  const compactorInput = {
    previous: {
      summary_markdown: previousSummaryText,
      memory_json: previousSummaryJson,
    },
    new_turns: buildTurnsForCompactor(limitedCandidates),
  };

  const systemPrompt = resolveSystemPrompt(params.systemPrompt);
  const userPrompt = `Update rolling memory.\n\nINPUT_JSON:\n${JSON.stringify(compactorInput, null, 2)}`;

  const raw = await params.llmCaller({
    providerId: config.providerId,
    modelId: config.modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    options: {
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.1,
      maxTokens: Math.max(64, config.maxOutputTokens),
      responseFormat: { type: 'json_object' },
    },
  });

  const parsed = extractJsonObject(raw) as ParsedCompactorOutput | null;
  const summaryText =
    parsed && typeof parsed.summary_markdown === 'string'
      ? parsed.summary_markdown.trim()
      : raw?.trim() || '';

  const summaryJson = parsed && parsed.memory_json && typeof parsed.memory_json === 'object'
    ? parsed.memory_json
    : null;

  if (!summaryText) {
    return {
      enabled: true,
      didCompact: false,
      summaryText: priorState.summaryText ?? null,
      summaryJson: priorState.summaryJson ?? null,
      summaryUptoTimestamp,
      summaryUpdatedAt: lastUpdatedAt,
      reason: 'empty_summary',
    };
  }

  const nextSummaryUptoTimestamp = limitedCandidates[limitedCandidates.length - 1]?.timestamp ?? summaryUptoTimestamp;
  const updatedSessionMetadata: Record<string, any> = {
    ...(params.sessionMetadata || {}),
    [stateKey]: {
      updatedAt: now,
      summaryText,
      summaryJson,
      summaryUptoTimestamp: typeof nextSummaryUptoTimestamp === 'number' ? nextSummaryUptoTimestamp : null,
    } satisfies RollingSummaryState,
  };

  return {
    enabled: true,
    didCompact: true,
    summaryText,
    summaryJson,
    summaryUptoTimestamp: typeof nextSummaryUptoTimestamp === 'number' ? nextSummaryUptoTimestamp : null,
    summaryUpdatedAt: now,
    compactedMessageCount: limitedCandidates.length,
    updatedSessionMetadata,
  };
}
