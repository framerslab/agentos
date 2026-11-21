/**
 * @module memory/io/facade/handedBrain
 *
 * A `Memory` facade's own Brain, handed to code inside the library that reads or writes the facade's store beside it
 * (the rows the facade has no call for). Internal: exported from neither package index.
 */
import type { Brain } from '../../retrieval/store/Brain.js';
import type { Memory } from './Memory.js';

/** Each facade's Brain, registered by the facade's constructor. */
const brains = new WeakMap<Memory, Brain>();

/**
 * Registers the Brain a facade was built on. The `Memory` constructor calls it once.
 *
 * @internal
 */
export function registerHandedBrain(memory: Memory, brain: Brain): void {
  brains.set(memory, brain);
}

/**
 * The Brain a facade was built on.
 *
 * @internal
 * @throws TypeError for an object no `Memory` constructor registered.
 */
export function brainOf(memory: Memory): Brain {
  const brain = brains.get(memory);
  if (!brain) throw new TypeError('brainOf: not a Memory store this library opened');
  return brain;
}
