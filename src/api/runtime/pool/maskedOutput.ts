/**
 * @fileoverview What leaves a seat of an agency with a pool or a panel, masked
 * by the call's list: every string of a result, the text of a stream with a
 * secret split between two pieces masked whole, a stream's other parts and the
 * values its promises settle to. A seated config's agent masks its own
 * `generate()` and `stream()` with it; seating wraps a pre-built seat in
 * {@link maskedPrebuilt}. The strategies then pass only masked answers from
 * one seat to the next, to a synthesizer, a manager or a chair.
 */
import type { Agent } from '../../types.js';
import type { CallMask } from './redact.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  isRecord(value) && typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === 'function';

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (isRecord(value) || typeof value === 'function') && typeof (value as Partial<PromiseLike<unknown>>).then === 'function';

/**
 * A stream of text pieces, masked: a secret split between two pieces comes out
 * masked whole, and a piece is released as soon as no secret can start in it.
 * An error the stream ends on leaves through the error mask, after the text
 * held before it.
 *
 * @param pieces - A `textStream`.
 * @param mask - The call's mask.
 * @returns The masked stream.
 */
export function maskTextStream(pieces: AsyncIterable<unknown>, mask: CallMask): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const redactor = mask.chunks();
      try {
        for await (const piece of pieces) {
          const out = redactor.push(String(piece));
          if (out) yield out;
        }
      } catch (error) {
        const rest = redactor.flush();
        if (rest) yield rest;
        throw mask(error);
      }
      const rest = redactor.flush();
      if (rest) yield rest;
    },
  };
}

/**
 * A stream of parts, masked: the text of `text` parts as {@link maskTextStream}
 * masks it, the text held from one agent released before another agent's text
 * and before any other part; an `error` part's error through the error mask;
 * the other strings of a text or error part, and every string of any other
 * part, masked by the listed values.
 *
 * @param parts - A `fullStream`.
 * @param mask - The call's mask.
 * @returns The masked stream.
 */
export function maskPartStream(parts: AsyncIterable<unknown>, mask: CallMask): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const redactor = mask.chunks();
      // The last text part whose text is still held, its other strings masked, for the part that releases it.
      let held: Record<string, unknown> | undefined;
      // That part's agent as it came, for the comparison with the next text part's.
      let heldAgent: unknown;
      const release = (): Record<string, unknown> | undefined => {
        const rest = redactor.flush();
        const part = held && rest ? { ...held, text: rest } : undefined;
        held = undefined;
        heldAgent = undefined;
        return part;
      };
      try {
        for await (const part of parts) {
          if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
            if (held && heldAgent !== part.agent) {
              const released = release();
              if (released) yield released;
            }
            held = mask.strings(part);
            heldAgent = part.agent;
            const out = redactor.push(part.text);
            if (out) yield { ...held, text: out };
            continue;
          }
          const released = release();
          if (released) yield released;
          yield isRecord(part) && part.type === 'error' ? { ...mask.strings(part), error: mask(part.error) } : mask.strings(part);
        }
      } catch (error) {
        const released = release();
        if (released) yield released;
        throw mask(error);
      }
      const released = release();
      if (released) yield released;
    },
  };
}

/**
 * A stream result with its members masked: `textStream` and
 * `finalTextStream` as text ({@link maskTextStream}), any other iterable as
 * parts ({@link maskPartStream}), and each promise settled to a copy of its
 * value with every string masked, or rejected through the error mask. Each
 * masked promise is marked handled, as the result's own members are, so a
 * caller that reads only some of them leaves no rejection unhandled. Every
 * other member is kept as it is.
 *
 * @param result - What a seat's `stream()` returned.
 * @param mask - The call's mask.
 * @returns A result with the same members, masked.
 */
export function maskStreamMembers<T extends object>(result: T, mask: CallMask): T {
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const [key, value] of Object.entries(result)) {
    if (isAsyncIterable(value)) {
      out[key] = key === 'textStream' || key === 'finalTextStream' ? maskTextStream(value, mask) : maskPartStream(value, mask);
    } else if (isThenable(value)) {
      const masked = Promise.resolve(value).then(
        (settled) => mask.strings(settled),
        (error: unknown) => {
          throw mask(error);
        },
      );
      masked.catch(() => undefined);
      out[key] = masked;
    }
  }
  return out as T;
}

/**
 * A pre-built seat whose answers leave it masked: `generate()` resolves to a
 * copy of its result with every string masked, or rejects through the error
 * mask, and `stream()` returns its stream result through
 * {@link maskStreamMembers}. The seat's own loops are its own: what it sends
 * to its provider is not reached. Every other member, its description and
 * dependencies included, is read from the seat itself.
 *
 * @param seat - The pre-built `Agent` in the roster.
 * @param mask - The call's mask.
 * @returns The seat as the call's strategy runs it.
 */
export function maskedPrebuilt(seat: Agent, mask: CallMask): Agent {
  return new Proxy(seat, {
    get(target, key) {
      if (key === 'generate') {
        return async (...args: Parameters<Agent['generate']>) => {
          let result: unknown;
          try {
            result = await target.generate(...args);
          } catch (error) {
            // A rejection leaves the seat masked, as its stream's does: a strategy's error callback reads it next.
            throw mask(error);
          }
          return mask.strings(result);
        };
      }
      if (key === 'stream') {
        return (...args: Parameters<Agent['stream']>) => {
          const streamed = target.stream(...args) as unknown;
          return isRecord(streamed) ? maskStreamMembers(streamed, mask) : streamed;
        };
      }
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
