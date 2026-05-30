import type { ITool, ToolExecutionContext } from '../../../core/tools/ITool';
import { renderToolSystemBlock } from './renderer';
import { parseToolCalls } from './parser';
import { formatToolResponse } from './activation';

export interface EmulatedLoopMessage { role: string; content: string; }

export interface EmulatedToolCallRecord { name: string; args: Record<string, unknown>; error?: string; }

export interface RunEmulatedToolLoopOptions {
  tools: ITool[];
  messages: EmulatedLoopMessage[];
  /** Buffered model call. Returns the full assistant text + usage. */
  callModel: (messages: EmulatedLoopMessage[]) => Promise<{ text: string; usage?: { totalTokens?: number } }>;
  maxRoundtrips: number;
  /** Execution context passed to each tool.execute(). */
  toolContext?: ToolExecutionContext;
}

export interface EmulatedToolLoopResult {
  text: string;
  toolCalls: EmulatedToolCallRecord[];
  finishReason: 'stop' | 'tool-calls';
  totalTokens: number;
}

/**
 * Buffered prompt-based tool loop. Renders the tool system block, then on each
 * roundtrip calls the model (buffered), parses <tool_call> blocks, executes the
 * matched tools, appends <tool_response> blocks, and repeats until the model
 * replies with no tool calls or maxRoundtrips is hit.
 */
export async function runEmulatedToolLoop(
  opts: RunEmulatedToolLoopOptions
): Promise<EmulatedToolLoopResult> {
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: EmulatedLoopMessage[] = [
    { role: 'system', content: renderToolSystemBlock(opts.tools) },
    ...opts.messages,
  ];
  const toolCalls: EmulatedToolCallRecord[] = [];
  let totalTokens = 0;

  for (let step = 0; step < opts.maxRoundtrips; step++) {
    const { text, usage } = await opts.callModel(messages);
    totalTokens += usage?.totalTokens ?? 0;
    const { calls, cleanedText, parseErrors } = parseToolCalls(text);

    if (calls.length === 0 && parseErrors.length === 0) {
      return { text: cleanedText, toolCalls, finishReason: 'stop', totalTokens };
    }

    messages.push({ role: 'assistant', content: text });

    const responses: string[] = [];
    for (const pe of parseErrors) {
      responses.push(`<tool_response>${JSON.stringify({ error: pe.message })}</tool_response>`);
    }
    // Execute all calls in the turn (batch / parallel within the turn).
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = toolMap.get(call.name);
        if (!tool) {
          return formatToolResponse(call.name, { success: false, error: `unknown tool "${call.name}"` });
        }
        try {
          const result = await tool.execute(call.arguments, opts.toolContext as ToolExecutionContext);
          toolCalls.push({ name: call.name, args: call.arguments });
          return formatToolResponse(call.name, result);
        } catch (err) {
          toolCalls.push({ name: call.name, args: call.arguments, error: String(err) });
          return formatToolResponse(call.name, { success: false, error: String(err) });
        }
      })
    );
    messages.push({ role: 'user', content: [...responses, ...results].join('\n') });
  }

  // Cap hit — best-effort: re-parse the last assistant turn's cleaned text.
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  const cleaned = last ? parseToolCalls(last.content).cleanedText : '';
  return { text: cleaned, toolCalls, finishReason: 'tool-calls', totalTokens };
}
