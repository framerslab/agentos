/**
 * @module voice-pipeline/VoiceEventEmitter
 *
 * The voice pipeline's event emitter, with no import: the streaming speech
 * contracts and every module a browser bundle takes from
 * `@framers/agentos/io/voice-pipeline/browser` emit through it, so that bundle
 * holds no `node:events`.
 *
 * - {@link EventEmitterLike} is the instance surface of Node's `EventEmitter`
 *   with Node's signatures. The contracts in `types.ts` extend it, so a class
 *   that extends Node's `EventEmitter` fits them as before, and a value typed
 *   by a contract still fits where Node's type is expected.
 * - {@link VoiceEventEmitter} implements it with Node's semantics: listeners
 *   run synchronously in the order they were added (`prependListener` puts one
 *   first), each with the emitter as `this`; a `once` listener is removed
 *   before it runs, and runs once even when an emit already under way reaches
 *   it again; `removeListener` removes the most recently added instance
 *   of a listener; an emit calls the listeners present when it began, even
 *   one removed meanwhile; and an `'error'` emitted with no `'error'` listener
 *   is thrown. It emits no `'newListener'` or `'removeListener'` events and
 *   prints no warning past the listener limit, which it keeps for
 *   `getMaxListeners()`.
 */

/** A listener: any function; it runs with the emitter as `this`. */
export type VoiceEventListener = (...args: any[]) => void;

/**
 * The instance surface of Node's `EventEmitter`, as `@types/node` declares it
 * with its default event map (names are strings or symbols, listeners take
 * any arguments). Node's `EventEmitter` and {@link VoiceEventEmitter} both
 * satisfy it, and it satisfies Node's type.
 */
export interface EventEmitterLike {
  /** Same as `on`. */
  addListener(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Adds a listener at the end of the event's list. */
  on(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Adds a listener that is removed before its first call. */
  once(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Adds a listener at the start of the event's list. */
  prependListener(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Adds a one-time listener at the start of the event's list. */
  prependOnceListener(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Removes the most recently added instance of a listener. */
  removeListener(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Same as `removeListener`. */
  off(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Removes every listener of one event, or of every event. */
  removeAllListeners(eventName?: string | symbol): this;
  /** Sets the listener limit. */
  setMaxListeners(n: number): this;
  /** The listener limit. */
  getMaxListeners(): number;
  /** The event's listeners, a `once` listener as the function that was added. */
  listeners(eventName: string | symbol): Function[]; // eslint-disable-line @typescript-eslint/no-unsafe-function-type -- Node declares Function[]; the same type keeps Node's emitter a fit
  /** The event's listeners as stored, a `once` listener as its wrapper. */
  rawListeners(eventName: string | symbol): Function[]; // eslint-disable-line @typescript-eslint/no-unsafe-function-type -- as listeners()
  /** Calls the event's listeners with the arguments; `true` when there were any. */
  emit(eventName: string | symbol, ...args: any[]): boolean;
  /** The number of the event's listeners, or of one listener among them. */
  listenerCount(eventName: string | symbol, listener?: VoiceEventListener): number;
  /** The names of the events that have listeners. */
  eventNames(): Array<string | symbol>;
}

/** A stored listener, or the wrapper `once` stores, which names the listener it wraps. */
type StoredListener = VoiceEventListener & { listener?: VoiceEventListener };

/**
 * An event emitter with Node's semantics and no import (see the module
 * notes): the base of the browser-safe sessions and of the STT chain's
 * failover facade.
 *
 * @example
 * ```typescript
 * class MySession extends VoiceEventEmitter implements StreamingSTTSession {
 *   pushAudio(frame: AudioFrame): void {}
 *   async flush(): Promise<void> {}
 *   close(): void {
 *     this.emit('close');
 *   }
 * }
 * ```
 */
export class VoiceEventEmitter implements EventEmitterLike {
  private readonly stored = new Map<string | symbol, StoredListener[]>();
  private maxListeners = 10;

  addListener(eventName: string | symbol, listener: VoiceEventListener): this {
    return this.add(eventName, listener, false);
  }

  on(eventName: string | symbol, listener: VoiceEventListener): this {
    return this.add(eventName, listener, false);
  }

  once(eventName: string | symbol, listener: VoiceEventListener): this {
    return this.add(eventName, this.wrapOnce(eventName, listener), false);
  }

  prependListener(eventName: string | symbol, listener: VoiceEventListener): this {
    return this.add(eventName, listener, true);
  }

  prependOnceListener(eventName: string | symbol, listener: VoiceEventListener): this {
    return this.add(eventName, this.wrapOnce(eventName, listener), true);
  }

  removeListener(eventName: string | symbol, listener: VoiceEventListener): this {
    const list = this.stored.get(eventName);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        list.splice(i, 1);
        if (list.length === 0) this.stored.delete(eventName);
        break;
      }
    }
    return this;
  }

  off(eventName: string | symbol, listener: VoiceEventListener): this {
    return this.removeListener(eventName, listener);
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) this.stored.clear();
    else this.stored.delete(eventName);
    return this;
  }

  /** @throws {RangeError} When `n` is negative or not a number. */
  setMaxListeners(n: number): this {
    if (!(n >= 0)) {
      throw new RangeError(`The value of "n" is out of range. It must be a non-negative number. Received ${n}`);
    }
    this.maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this.maxListeners;
  }

  listeners(eventName: string | symbol): Function[] { // eslint-disable-line @typescript-eslint/no-unsafe-function-type -- the interface's type
    return (this.stored.get(eventName) ?? []).map((stored) => stored.listener ?? stored);
  }

  rawListeners(eventName: string | symbol): Function[] { // eslint-disable-line @typescript-eslint/no-unsafe-function-type -- the interface's type
    return [...(this.stored.get(eventName) ?? [])];
  }

  /**
   * Calls the event's listeners in order, with the arguments.
   *
   * @throws The `'error'` event's error (or an `Error` naming the value) when
   *   no `'error'` listener exists, as Node's `EventEmitter` does; any error a
   *   listener throws.
   */
  emit(eventName: string | symbol, ...args: any[]): boolean {
    const list = this.stored.get(eventName);
    if (!list || list.length === 0) {
      if (eventName === 'error') {
        const [err] = args;
        throw err instanceof Error ? err : new Error(`Unhandled error. (${String(err)})`);
      }
      return false;
    }
    for (const listener of [...list]) listener.apply(this, args);
    return true;
  }

  listenerCount(eventName: string | symbol, listener?: VoiceEventListener): number {
    const list = this.stored.get(eventName) ?? [];
    if (!listener) return list.length;
    return list.filter((stored) => stored === listener || stored.listener === listener).length;
  }

  eventNames(): Array<string | symbol> {
    return [...this.stored.keys()];
  }

  private add(eventName: string | symbol, listener: StoredListener, prepend: boolean): this {
    if (typeof listener !== 'function') {
      throw new TypeError(`The "listener" argument must be of type function. Received ${typeof listener}`);
    }
    const list = this.stored.get(eventName);
    if (!list) this.stored.set(eventName, [listener]);
    else if (prepend) list.unshift(listener);
    else list.push(listener);
    return this;
  }

  private wrapOnce(eventName: string | symbol, listener: VoiceEventListener): StoredListener {
    if (typeof listener !== 'function') {
      throw new TypeError(`The "listener" argument must be of type function. Received ${typeof listener}`);
    }
    // An emit already under way holds the wrapper in its snapshot, and may
    // reach it after a nested emit has run it; as Node's does, it runs once.
    let fired = false;
    const wrapper: StoredListener = (...args: any[]) => {
      if (fired) return;
      fired = true;
      this.removeListener(eventName, wrapper);
      listener.apply(this, args);
    };
    wrapper.listener = listener;
    return wrapper;
  }
}
