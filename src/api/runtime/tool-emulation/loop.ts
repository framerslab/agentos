import type { ITool, ToolExecutionContext } from '../../../core/tools/ITool';
import { APPROVAL_GRANTED, askApprovalGate, type ApprovalGateFn } from '../approval-gate';
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
  /**
   * Called with the tool's name right before a parsed call runs the tool.
   * Callers use it to learn that a tool had side effects, for example to
   * refuse a failover that would run the call again.
   */
  onToolExecute?: (toolName: string) => void;
  /**
   * Called before each parsed call runs, on `{ name, args, id: '', step }`.
   * The returned `args` replace the call's; `null` skips the tool. A hook
   * that throws is logged and the tool runs.
   */
  onBeforeToolExecution?: (info: { name: string; args: Record<string, unknown>; id: string; step: number }) => Promise<{ args: Record<string, unknown> } | null>;
  /** The agency approval gate, called after the hook: anything but its exact approval skips the tool. */
  approvalGate?: ApprovalGateFn;
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
        let args: Record<string, unknown> = call.arguments;
        if (opts.onBeforeToolExecution) {
          try {
            const hooked = await opts.onBeforeToolExecution({ name: call.name, args, id: '', step });
            if (hooked === null) {
              toolCalls.push({ name: call.name, args, error: 'Skipped by onBeforeToolExecution hook' });
              return formatToolResponse(call.name, { success: false, error: 'skipped by onBeforeToolExecution hook' });
            }
            args = hooked.args;
          } catch (hookErr) {
            console.warn('[agentos] onBeforeToolExecution hook error:', hookErr);
          }
        }
        if (opts.approvalGate) {
          const verdict = await askApprovalGate(opts.approvalGate, { name: call.name, args: args ?? {}, id: '', step });
          if (verdict !== APPROVAL_GRANTED) {
            toolCalls.push({ name: call.name, args, error: `Skipped: ${verdict.reason}` });
            return formatToolResponse(call.name, { success: false, error: `skipped: ${verdict.reason}` });
          }
        }
        try {
          opts.onToolExecute?.(call.name);
          const result = await tool.execute(args, opts.toolContext as ToolExecutionContext);
          toolCalls.push({ name: call.name, args });
          return formatToolResponse(call.name, result);
        } catch (err) {
          toolCalls.push({ name: call.name, args, error: String(err) });
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
