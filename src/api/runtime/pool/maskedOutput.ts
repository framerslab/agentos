/**
 * @fileoverview What leaves a seat of an agency with a pool or a panel, masked
 * by the call's list: every string of a result, the text of a stream with a
 * secret split between two pieces, or around a tool call between two steps,
 * masked whole, a stream's other parts and the values its promises settle to.
 * A seated config's agent masks its own `generate()` and `stream()` with it;
 * seating wraps a pre-built seat in {@link maskedPrebuilt}. The strategies
 * then pass only masked answers from one seat to the next, to a synthesizer,
 * a manager or a chair.
 */
import type { Agent } from '../../types.js';
import type { CallMask, ChunkRedactor } from './redact.js';

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
 * A part with every string masked by the listed values, and a `tool-result`
 * part's result and a `tool-call` part's arguments as a tool's output is
 * masked: a number whose digits hold a listed value becomes `[redacted]` too,
 * as in the tool calls of a `generate()` result. A count, a duration or a
 * timestamp of any other part stays a number.
 *
 * @param part - A stream part.
 * @param mask - The call's mask.
 * @returns The masked part.
 */
export function maskedPart<T>(part: T, mask: CallMask): T {
  const masked = mask.strings(part);
  if (!isRecord(part) || !isRecord(masked)) return masked;
  if (part.type === 'tool-result' && 'result' in part) return { ...masked, result: mask.strings(part.result, true) } as T;
  if (part.type === 'tool-call' && 'args' in part) return { ...masked, args: mask.strings(part.args, true) } as T;
  return masked;
}

/**
 * A seat's `generate()` result with every string masked by the listed values,
 * and its tool calls as a tool's output is masked: a number whose digits hold
 * a listed value becomes `[redacted]` too, while the result's counts stay
 * numbers.
 *
 * @param result - What a seat's `generate()` resolved to.
 * @param mask - The call's mask.
 * @returns The masked result.
 */
export function maskedResult<T>(result: T, mask: CallMask): T {
  const masked = mask.strings(result);
  // A result the mask kept as it was (no list, or an instance of a class with no listed value) keeps its class.
  if (masked === result || !isRecord(result) || Array.isArray(result) || !Array.isArray(result.toolCalls) || !isRecord(masked)) return masked;
  return { ...masked, toolCalls: mask.strings(result.toolCalls, true) } as T;
}

/**
 * One agent's text in flight: its redactor, the last text part's other strings
 * (what held text is released with), the held text by the part that brought
 * it, and the parts waiting behind the held tail, each with the count of held
 * characters before it and its place in the stream.
 */
interface TextLane {
  redactor: ChunkRedactor;
  template?: Record<string, unknown>;
  /** The held text, first to last, as runs of the characters one part brought: that part's place in the stream and how many. */
  runs: Array<{ seq: number; length: number }>;
  waiting: Array<{ part: unknown; at: number; seq: number }>;
}

/** What a lane releases, a part or a piece of text, with the place in the stream of the part it came from. */
interface Released {
  item: unknown;
  seq: number;
}

/**
 * A stream of parts, masked: the text of `text` parts as {@link maskTextStream}
 * masks it, agent by agent (a nested agency's parts name theirs); an `error`
 * part's error through the error mask; the other strings of a text or error
 * part, and every string of any other part, masked by the listed values. A
 * tail that could start a secret stays held across the agent's other parts (a
 * tool call and its result between two steps), so a secret split around them
 * is masked whole. Those parts wait behind the tail and come out in their
 * place once the text around them is settled: between the characters that
 * were held before and after them when no secret ran through the place they
 * waited at, and after the text before the first masked secret and ahead of
 * the masked text when one did. Another agent's parts pass meanwhile. At the
 * end of the stream, and before a stream error, every agent's held text and
 * waiting parts come out the same way, merged in the order the stream brought
 * them: an agent's own in their order, and between agents whichever arrived
 * first.
 *
 * @param parts - A `fullStream`.
 * @param mask - The call's mask.
 * @returns The masked stream.
 */
export function maskPartStream(parts: AsyncIterable<unknown>, mask: CallMask): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const lanes = new Map<unknown, TextLane>();
      // The place in the stream of the next part to arrive.
      let arrived = 0;
      const laneOf = (agent: unknown): TextLane => {
        let lane = lanes.get(agent);
        if (!lane) {
          lane = { redactor: mask.chunks(), runs: [], waiting: [] };
          lanes.set(agent, lane);
        }
        return lane;
      };
      /** The place in the stream of the part that brought the held character at `offset`, or `past` beyond the held text. */
      const arrivalAt = (lane: TextLane, offset: number, past: number): number => {
        let left = offset;
        for (const run of lane.runs) {
          if (left < run.length) return run.seq;
          left -= run.length;
        }
        return past;
      };
      /** Drops the runs of the characters a push released, so the runs cover what is still held. */
      const keepHeldRuns = (lane: TextLane): void => {
        let drop = lane.runs.reduce((total, run) => total + run.length, 0) - lane.redactor.held().length;
        while (drop > 0 && lane.runs.length > 0) {
          const first = lane.runs[0];
          if (first.length > drop) {
            lane.runs[0] = { seq: first.seq, length: first.length - drop };
            return;
          }
          drop -= first.length;
          lane.runs.shift();
        }
      };
      /**
       * The released text between two offsets of what was held and then
       * pushed: what was held goes out with the template it was held with,
       * the rest with this piece's, which arrived at `seq`.
       */
      const textBetween = function* (lane: TextLane, template: Record<string, unknown>, released: string, heldLength: number, from: number, to: number, seq: number): Generator<Released> {
        if (from >= to) return;
        const heldEnd = Math.min(to, heldLength);
        if (from < heldEnd) yield { item: { ...(lane.template ?? template), text: released.slice(from, heldEnd) }, seq: arrivalAt(lane, from, seq) };
        if (to > heldLength) yield { item: { ...template, text: released.slice(Math.max(from, heldLength), to) }, seq };
      };
      /**
       * What `out`, the masked form of `released` (the first characters of the
       * held text and the piece just pushed, up to what is still held), comes
       * out as: the text before the first masked secret is the same in both,
       * so a waiting part that arrived inside it comes out in its place among
       * that text, and a part that arrived from the first masked secret on
       * comes out after it and before the rest of `out`. A part behind text
       * still held stays, its offset moved up. `seq` is the place in the
       * stream of the piece just pushed.
       */
      const release = function* (lane: TextLane, template: Record<string, unknown>, released: string, out: string, heldLength: number, seq: number): Generator<Released> {
        const cut = released.length;
        // Where the first masked secret starts: `out` and `released` agree up to there, and from there `out` reads
        // `[redacted]`. A secret is masked only by that marker, so it starts at the last marker in `out` that begins
        // no later than the first character where the two differ.
        let same = 0;
        while (same < released.length && same < out.length && released[same] === out[same]) same += 1;
        const masked = out === released ? cut : Math.max(0, out.lastIndexOf('[redacted]', same));
        const staying: TextLane['waiting'] = [];
        const inside: TextLane['waiting'] = [];
        let from = 0;
        for (const entry of lane.waiting) {
          if (entry.at > cut) staying.push({ ...entry, at: entry.at - cut });
          else if (entry.at > masked) inside.push(entry);
          else {
            yield* textBetween(lane, template, released, heldLength, from, entry.at, seq);
            from = entry.at;
            yield { item: entry.part, seq: entry.seq };
          }
        }
        yield* textBetween(lane, template, released, heldLength, from, masked, seq);
        for (const entry of inside) yield { item: entry.part, seq: entry.seq };
        if (out.length > masked) yield { item: { ...template, text: out.slice(masked) }, seq: arrivalAt(lane, masked, seq) };
        lane.waiting = staying;
      };
      /** What a lane releases when the stream ends: its held tail, masked, with the parts that waited in their place. */
      const settle = (lane: TextLane): Released[] => {
        const held = lane.redactor.held();
        const rest = lane.redactor.flush();
        const settled = [...release(lane, lane.template ?? {}, held, rest, held.length, arrived)];
        lane.runs = [];
        return settled;
      };
      /**
       * What every lane releases when the stream ends, in the order the stream
       * brought it: each lane's text and parts in their own order, and between
       * lanes whichever arrived first, so a part that waited behind one
       * agent's tail never comes out ahead of one that arrived before it
       * behind another's.
       */
      const settleAll = function* (): Generator<unknown> {
        const queues = [...lanes.values()].map(settle).filter((queue) => queue.length > 0);
        while (queues.length > 0) {
          let first = 0;
          for (let i = 1; i < queues.length; i += 1) if (queues[i][0].seq < queues[first][0].seq) first = i;
          const head = queues[first].shift() as Released;
          if (queues[first].length === 0) queues.splice(first, 1);
          yield head.item;
        }
      };
      try {
        for await (const part of parts) {
          const seq = arrived;
          arrived += 1;
          if (!isRecord(part)) {
            yield mask.strings(part);
            continue;
          }
          const lane = laneOf(part.agent);
          if (part.type === 'text' && typeof part.text === 'string') {
            const held = lane.redactor.held();
            const out = lane.redactor.push(part.text);
            const template = mask.strings(part);
            if (out) {
              if (lane.waiting.length === 0) yield { ...template, text: out };
              else {
                const released = (held + part.text).slice(0, held.length + part.text.length - lane.redactor.held().length);
                for (const { item } of release(lane, template, released, out, held.length, seq)) yield item;
              }
            }
            lane.template = template;
            if (part.text.length > 0) lane.runs.push({ seq, length: part.text.length });
            keepHeldRuns(lane);
            continue;
          }
          const masked = part.type === 'error' ? { ...mask.strings(part), error: mask(part.error) } : maskedPart(part, mask);
          const heldLength = lane.redactor.held().length;
          if (heldLength > 0) lane.waiting.push({ part: masked, at: heldLength, seq });
          else yield masked;
        }
      } catch (error) {
        yield* settleAll();
        throw mask(error);
      }
      yield* settleAll();
    },
  };
}

/**
 * A stream result with its members masked: `textStream` and
 * `finalTextStream` as text ({@link maskTextStream}), any other iterable as
 * parts ({@link maskPartStream}), and each promise settled to a copy of its
 * value with every string masked (the `toolCalls` promise's as a tool's
 * output is masked, a number whose digits hold a listed value included), or
 * rejected through the error mask. Each
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
        (settled) => (key === 'toolCalls' ? mask.strings(settled, true) : mask.strings(settled)),
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
 * copy of its result with every string masked ({@link maskedResult}), or
 * rejects through the error mask, and `stream()` returns its stream result
 * through {@link maskStreamMembers}. The seat's own loops are its own: what it
 * sends to its provider is not reached. Every other member, its description
 * and dependencies included, is read from the seat itself, a method bound to
 * it. The proxy's target is a blank object, never the seat: a proxy must
 * return the own value of a target's property that is neither writable nor
 * configurable, so over a frozen seat it could hand out no masking
 * `generate` or `stream`.
 *
 * @param seat - The pre-built `Agent` in the roster.
 * @param mask - The call's mask.
 * @returns The seat as the call's strategy runs it.
 */
export function maskedPrebuilt(seat: Agent, mask: CallMask): Agent {
  const generate = async (...args: Parameters<Agent['generate']>): Promise<unknown> => {
    let result: unknown;
    try {
      result = await seat.generate(...args);
    } catch (error) {
      // A rejection leaves the seat masked, as its stream's does: a strategy's error callback reads it next.
      throw mask(error);
    }
    return maskedResult(result, mask);
  };
  const stream = (...args: Parameters<Agent['stream']>): unknown => {
    let streamed: unknown;
    try {
      streamed = seat.stream(...args) as unknown;
    } catch (error) {
      // An error the seat throws while building its stream leaves it masked, as a rejected generate() does.
      throw mask(error);
    }
    return isRecord(streamed) ? maskStreamMembers(streamed, mask) : streamed;
  };
  const own = (key: PropertyKey): unknown => (key === 'generate' ? generate : key === 'stream' ? stream : undefined);
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      const wrapped = own(key);
      if (wrapped) return wrapped;
      const value = Reflect.get(seat, key, seat) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(seat) : value;
    },
    set: (_target, key, value) => Reflect.set(seat, key, value, seat),
    has: (_target, key) => Reflect.has(seat, key),
    ownKeys: () => Reflect.ownKeys(seat),
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(seat, key);
      if (!descriptor) return undefined;
      // Reported configurable: the blank target holds no such property, and a proxy may report a property the
      // target lacks only as configurable.
      const wrapped = own(key);
      return { ...descriptor, ...(wrapped && 'value' in descriptor ? { value: wrapped } : {}), configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(seat),
  }) as Agent;
}
