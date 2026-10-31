/**
 * @file runtimeSeat.ts
 * A seat of a team a GMI launched on the full runtime: a roster member over the one GMI the GMIManager built for it
 * (`createAgencySeat`). Each call runs one turn of that GMI under the call's stop, in the seat session, as the parent
 * turn's user and organization, with the launch frame in its metadata; the seat's calls run one at a time. A failed
 * turn rejects with its error's name and code alone, as a gmi() seat's does, the error itself going to the launch's
 * `logError`. Each call that ran a turn is reported to `onCall` when it ends (the agency registry's seat history).
 * @internal
 */
import { randomUUID } from 'node:crypto';
import type { GenerateTextResult, ToolCallRecord, TokenUsage } from '../../generateText.js';
import {
  GMIInteractionType,
  GMIOutputChunkType,
  type GMIOutput,
  type GMIToolCallGate,
  type IGMI,
  type StepFinishedChunkPayload,
  type ToolCallRequest,
  type ToolResultChunkPayload,
} from '../../../cognition/substrate/IGMI.js';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import { TurnLock } from '../gmiSession.js';
import type { SeatHandle } from './sessionSeat.js';
import { SEAT_SUMMARY_CHARS, type AgencyLaunchFrame, type LaunchSeatRecord } from './types.js';

/** What a runtime seat runs on. */
export interface RuntimeSeatOptions {
  role: string;
  form: 'temporary' | 'persistent';
  /** The personaId of a persistent member. */
  memberRef?: string;
  /** A persistent member's brief, put after its role before every input. */
  brief?: string;
  /** What a hierarchical manager reads about the seat. */
  description?: string;
  dependsOn?: string[];
  /** `seat:<agencyId>:<role>`. */
  seatSessionId: string;
  /** The parent turn's user: the seat's turns run as it. */
  userId: string;
  /** The parent turn's organization; '' for none. */
  organizationId: string;
  frame: AgencyLaunchFrame;
  gmi: IGMI;
  /** The persona the seat's GMI runs. */
  personaId: string;
  /**
   * The output guardrails' tool-call gate the launching turn asks before each of its calls: each of the seat's turns
   * asks it before each call of its own tool round, so a call the guardrails block never runs.
   */
  toolCallGate?: GMIToolCallGate;
  /** Shuts the seat's GMI down and takes it out of the manager. */
  release(): Promise<void>;
  /**
   * True once the launch has stopped (its signal aborted, or its budget is exhausted). A call that fails then was cut,
   * and so is a turn still running when the launch reads the seat's record.
   */
  cutWhen: () => boolean;
  /** Where a failed call's original error goes. */
  logError(error: unknown, where: string): void;
  /**
   * Called once each call that ran a turn has ended, answered or not, with the record as that call left it (the agency
   * registry's seat history). A function that throws changes nothing about the call; its error goes to `logError`.
   */
  onCall?: (record: LaunchSeatRecord) => void;
}

/** A runtime seat: a roster member that names its GMI and the persona the GMI runs (the agency registry's seat). */
export type RuntimeSeatHandle = SeatHandle & { readonly gmiId: string; readonly personaId: string };

/** A turn's usage, from its output. */
function usageOf(output: GMIOutput | undefined): TokenUsage {
  const usage = output?.usage;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const cost = usage?.totalCostUSD;
  return {
    promptTokens: num(usage?.promptTokens),
    completionTokens: num(usage?.completionTokens),
    totalTokens: num(usage?.totalTokens),
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUSD: cost } : {}),
  };
}

/**
 * The error a seat rejects with: the original's name and code alone, the rule sessionSeat()'s seats follow. A
 * provider's or a handler's message can carry a URL or a credential, and a hierarchical manager's delegate tool hands
 * a seat's rejection to the manager's model.
 */
function seatError(name: string, code: string | undefined): Error {
  const error = new Error(code ? `${name} (${code})` : name);
  error.name = name;
  if (code) (error as Error & { code?: string }).code = code;
  return error;
}

/**
 * The error a failed turn reported, whole, for the launch's `logError`: its ERROR chunk's details (a GMIError's plain
 * form: name, message, code, details, stack), else its output's error.
 */
function turnError(details: Record<string, unknown> | undefined, output: GMIOutput['error'], content: unknown): GMIError {
  const text = (key: 'name' | 'message' | 'code' | 'stack'): string | undefined => {
    const value = details?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  const code = text('code') ?? output?.code ?? GMIErrorCode.GMI_PROCESSING_ERROR;
  const message = text('message') ?? output?.message ?? (typeof content === 'string' ? content : 'The turn failed.');
  const error = new GMIError(message, code, output?.details ?? details?.details);
  const name = text('name');
  if (name) error.name = name;
  const stack = text('stack');
  if (stack) error.stack = stack;
  return error;
}

/** The code of a thrown error, when it carries a string or numeric one. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : typeof code === 'number' ? String(code) : undefined;
}

/**
 * @param options - The seat's GMI, persona, session, user, organization, frame and record fields.
 * @returns A roster member for the launch's child agency.
 */
export function runtimeSeat(options: RuntimeSeatOptions): RuntimeSeatHandle {
  const record: LaunchSeatRecord = {
    role: options.role,
    form: options.form,
    ...(options.memberRef ? { member: options.memberRef } : {}),
    status: 'not_run',
    calls: 0,
    summary: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  const lock = new TurnLock();
  let closed = false;
  let closing: Promise<void> | undefined;
  /** The seat's calls in flight, a call waiting for the seat's earlier turn among them. */
  let running = 0;

  /** A persistent member's input, after its role and brief; a temporary seat's instructions are its persona. */
  const framed = (input: string): string => {
    if (options.form !== 'persistent') return input;
    const brief = options.brief?.trim();
    return `Your role in this team: ${options.role}.${brief ? ` ${brief}` : ''}\n\n${input}`;
  };

  /** Adds a turn's usage to the record: a turn that failed after billed steps included. */
  const addUsage = (usage: TokenUsage): void => {
    record.usage.promptTokens += usage.promptTokens;
    record.usage.completionTokens += usage.completionTokens;
    record.usage.totalTokens += usage.totalTokens;
    if (usage.costUSD !== undefined) record.usage.costUSD = (record.usage.costUSD ?? 0) + usage.costUSD;
  };

  /**
   * Hands `onCall` a copy of the record as the call that ran a turn left it, before the seat's next turn can change it.
   * A function that throws changes nothing about the call.
   */
  const reportCall = (): void => {
    if (!options.onCall) return;
    try {
      options.onCall({ ...record, usage: { ...record.usage }, ...(record.error ? { error: { ...record.error } } : {}) });
    } catch (error) {
      options.logError(error, 'launch_agency record');
    }
  };

  /** Records a failed call and returns the error the seat rejects with: the failure's name and code, never its message. */
  const failed = (error: unknown, signal: AbortSignal | undefined): Error => {
    const name = error instanceof Error ? error.name : 'Error';
    const code = codeOf(error);
    record.status = signal?.aborted === true || options.cutWhen() ? 'cut' : 'failed';
    record.error = { name, ...(code ? { code } : {}) };
    options.logError(error, `seat ${options.role}`);
    return seatError(name, code);
  };

  /** One turn of the seat's GMI, under the call's stop. */
  const runTurn = async (prompt: string, signal: AbortSignal | undefined): Promise<GenerateTextResult> => {
    const calls = new Map<string, ToolCallRecord>();
    let output: GMIOutput | undefined;
    let failure: { details?: Record<string, unknown>; content: unknown } | undefined;
    let lastStep: StepFinishedChunkPayload | undefined;
    let streamed = '';
    try {
      const turn = options.gmi.processTurnStream({
        interactionId: `turn-${randomUUID()}`,
        userId: options.userId,
        sessionId: options.seatSessionId,
        type: GMIInteractionType.TEXT,
        content: framed(prompt),
        metadata: {
          ...(signal ? { options: { abortSignal: signal } } : {}),
          agencyLaunch: options.frame,
          agencyId: options.frame.launchId,
          roleId: options.role,
          ...(options.organizationId ? { organizationId: options.organizationId } : {}),
          ...(options.toolCallGate ? { toolCallGate: options.toolCallGate } : {}),
        },
      });
      for (;;) {
        const next = await turn.next();
        if (next.done) {
          output = next.value;
          break;
        }
        const chunk = next.value;
        if (chunk.type === GMIOutputChunkType.TEXT_DELTA && typeof chunk.content === 'string') {
          streamed += chunk.content;
        } else if (chunk.type === GMIOutputChunkType.STEP_FINISHED) {
          lastStep = chunk.content as StepFinishedChunkPayload;
        } else if (chunk.type === GMIOutputChunkType.TOOL_CALL_REQUEST && Array.isArray(chunk.content)) {
          for (const call of chunk.content as ToolCallRequest[]) calls.set(call.id, { name: call.name, args: call.arguments });
        } else if (chunk.type === GMIOutputChunkType.TOOL_RESULT) {
          const result = chunk.content as ToolResultChunkPayload;
          const call = calls.get(result.toolCallId);
          // A tool's error stays out of the record: its message can carry what the seat's model must not echo.
          if (call && result.isError) call.error = 'the tool failed';
          else if (call) call.result = result.result;
        } else if (chunk.type === GMIOutputChunkType.ERROR) {
          failure = { details: chunk.errorDetails as Record<string, unknown> | undefined, content: chunk.content };
        }
      }
    } catch (thrown) {
      throw failed(thrown, signal);
    }
    // A failed turn does not throw: it yields an ERROR chunk and returns its error with the usage of the steps it made.
    if (failure || output?.error) {
      addUsage(usageOf(output));
      throw failed(turnError(failure?.details, output?.error, failure?.content), signal);
    }
    const text = output?.responseText ?? streamed;
    const usage = usageOf(output);
    addUsage(usage);
    record.status = 'completed';
    delete record.error;
    record.summary = text.length > SEAT_SUMMARY_CHARS ? text.slice(0, SEAT_SUMMARY_CHARS) : text;
    const persona = options.gmi.getPersona();
    return {
      provider: lastStep?.providerId ?? persona.defaultProviderId ?? '',
      model: lastStep?.modelId ?? persona.defaultModelId ?? '',
      text,
      usage,
      toolCalls: [...calls.values()],
      finishReason: lastStep?.finishReason === 'length' ? 'length' : 'stop',
    };
  };

  const handle: RuntimeSeatHandle = {
    seatId: options.seatSessionId,
    gmiId: options.gmi.gmiId,
    personaId: options.personaId,
    ...(options.description ? { description: options.description } : {}),
    ...(options.dependsOn ? { dependsOn: [...options.dependsOn] } : {}),

    async generate(prompt: string, opts?: Record<string, unknown>): Promise<GenerateTextResult> {
      if (closed) throw new Error('seat closed');
      record.calls += 1;
      running += 1;
      try {
        // A GMI runs one turn at a time (GMI.ensureReady): a manager that delegates twice at once waits here.
        const release = await lock.acquire();
        let ranTurn = false;
        try {
          if (closed) {
            // The launch closed the seat while this call waited for its earlier turn: the call is cut, and runs nothing.
            record.status = 'cut';
            delete record.error;
            throw new Error('seat closed');
          }
          ranTurn = true;
          return await runTurn(prompt, opts?.abortSignal as AbortSignal | undefined);
        } finally {
          // The registry's seat history hears of every call that ran a turn, answered or not.
          if (ranTurn) reportCall();
          release();
        }
      } finally {
        running -= 1;
      }
    },

    stream(): never {
      throw new Error('a seat of a launched team runs through generate()');
    },

    session(): never {
      throw new Error('a seat runs one session; call generate()');
    },

    async usage() {
      return { ...record.usage };
    },

    close(): Promise<void> {
      closing ??= (async () => {
        closed = true;
        // A turn still running (a tool past the deadline) ends first; then the GMI goes.
        const release = await lock.acquire();
        try {
          await options.release();
        } finally {
          release();
        }
      })();
      return closing;
    },

    record(): LaunchSeatRecord {
      // A turn still running once the launch has stopped (its deadline, its parent's stop, its budget) is cut, whatever
      // the seat's earlier turns came to: the launch reports without that turn's answer, and without the error an
      // earlier turn failed with, which did not end this one.
      const cut = running > 0 && options.cutWhen();
      const { error, ...withoutError } = record;
      return { ...withoutError, ...(cut ? { status: 'cut' as const } : {}), usage: { ...record.usage }, ...(error && !cut ? { error: { ...error } } : {}) };
    },
  };
  return handle;
}
