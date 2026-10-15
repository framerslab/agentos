import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { checkedStream, type CheckedRequestInput } from '../../../safety/egress/CheckedEgress.js';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.strictObject({ prompt_tokens: count, completion_tokens: count, total_tokens: count,
  prompt_tokens_details: z.strictObject({ cached_tokens: count, text_tokens: count.optional(), audio_tokens: z.literal(0).optional(), image_tokens: z.literal(0).optional(), cache_write_tokens: z.literal(0).optional() }),
  completion_tokens_details: z.strictObject({ reasoning_tokens: count, text_tokens: count.optional(), audio_tokens: z.literal(0).optional(), accepted_prediction_tokens: z.literal(0).optional(), rejected_prediction_tokens: z.literal(0).optional() }) });
const deltaSchema = z.object({ content: z.string().nullable().optional(), role: z.literal('assistant').optional(), refusal: z.string().nullable().optional(),
  tool_calls: z.array(z.strictObject({ index: count.max(31), id: z.string().max(128).optional(), type: z.literal('function').optional(), function: z.strictObject({ name: z.string().max(128).optional(), arguments: z.string().max(32768).optional() }).optional() })).max(32).optional() }).strict();
const chunkSchema = z.object({ choices: z.array(z.object({ index: z.literal(0), delta: deltaSchema, finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable() })).max(1), usage: usageSchema.nullable().optional() });
/** Exact bounded function invocation reconstructed from indexed wire deltas. */
export interface ReasoningToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
/** Captured conversation messages; there is no caller-supplied provider, URL or budget field. */
export type ReasoningMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: ReasoningToolCall[] };
/** Wire events use usage components already defined by the attempt budget. */
export type ReasoningWireEvent = { type: 'text'; text: string } | { type: 'result'; tools: ReasoningToolCall[]; usage: Record<string, number> };
/** One checked streaming request, with bounded SSE lines, tool accumulation and mandatory final usage. */
export async function* openaiChatCompletions(input: CheckedRequestInput): AsyncIterable<ReasoningWireEvent> {
  const response = await checkedStream(input); if (response.status !== 200) throw new Error('reasoning endpoint refused');
  let pending = ''; const decoder = new StringDecoder('utf8'); let finished = false; let done = false;
  let usage: Record<string, number> | undefined; const calls = new Map<number, ReasoningToolCall>();
  const parse = (line: string): ReasoningWireEvent | undefined => {
    if (!line || line.startsWith(':')) return;
    if (!line.startsWith('data:')) throw new Error('reasoning stream field refused');
    const data = line.slice(5).trim(); if (!data) return;
    if (done) throw new Error('reasoning after completion');
    if (data === '[DONE]') { if (!finished || !usage) throw new Error('reasoning usage incomplete'); done = true; return; }
    const chunk = chunkSchema.parse(JSON.parse(data));
    if (chunk.usage) {
      if (usage || !finished || chunk.choices.length) throw new Error('reasoning usage order');
      const u = chunk.usage; const cached = u.prompt_tokens_details.cached_tokens; const reasoning = u.completion_tokens_details.reasoning_tokens;
      if (cached > u.prompt_tokens || reasoning > u.completion_tokens || u.total_tokens !== u.prompt_tokens + u.completion_tokens) throw new Error('reasoning usage inconsistent');
      usage = { input_token: u.prompt_tokens - cached, cached_input_token: cached, output_token: u.completion_tokens, reasoning_token: reasoning, request: 1 }; return;
    }
    const choice = chunk.choices[0]; if (!choice) return;
    if (finished || choice.delta.refusal) throw new Error('reasoning completion refused');
    for (const fragment of choice.delta.tool_calls ?? []) {
      let call = calls.get(fragment.index); if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(fragment.index, call); }
      if (fragment.id) { if (call.id && call.id !== fragment.id) throw new Error('tool identity changed'); call.id = fragment.id; }
      if (fragment.function?.name) { if (call.function.name && call.function.name !== fragment.function.name) throw new Error('tool name changed'); call.function.name = fragment.function.name; }
      call.function.arguments += fragment.function?.arguments ?? '';
      if (Buffer.byteLength(call.function.arguments) > 32768) throw new Error('tool arguments bound');
    }
    if (choice.finish_reason) { if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('reasoning incomplete'); finished = true; }
    if (choice.delta.content) return { type: 'text', text: choice.delta.content };
  };
  for await (const bytes of response.body) {
    pending += decoder.write(bytes); if (Buffer.byteLength(pending) > 131072) throw new Error('reasoning frame bound');
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); const event = parse(line); if (event) yield event; }
  }
  pending += decoder.end(); if (pending.trim()) throw new Error('reasoning truncated frame');
  if (!done || !finished || !usage) throw new Error('reasoning usage incomplete');
  const tools = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (tools.some((call) => !call.id || !call.function.name) || new Set(tools.map((call) => call.id)).size !== tools.length) throw new Error('tool identity refused');
  yield { type: 'result', tools, usage };
}
