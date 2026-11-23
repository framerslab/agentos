/**
 * @fileoverview Slot-based cognitive working memory (Baddeley's model).
 *
 * Wraps the existing IWorkingMemory interface and adds:
 * - Capacity-limited slots (7±2, personality-modulated)
 * - Activation levels per slot (0-1)
 * - Attention weights and rehearsal
 * - Overflow eviction → episodic encoding callback
 *
 * @module agentos/memory/working/CognitiveWorkingMemory
 */

import type { IWorkingMemory } from '../../../substrate/memory/IWorkingMemory.js';
import type { WorkingMemorySlot, MemoryTrace } from '../types.js';
import type { HexacoTraits } from '../config.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CognitiveWorkingMemoryConfig {
  /** Base capacity (Miller's number). @default 7 */
  baseCapacity: number;
  /** HEXACO traits for personality-modulated capacity. */
  traits: HexacoTraits;
  /** Callback when a slot is evicted (should encode into episodic LTM). */
  onEvict?: (slotId: string, traceId: string) => Promise<void>;
  /** Activation decay rate per turn (0-1). @default 0.1 */
  activationDecayRate: number;
  /** Minimum activation before a slot is eligible for eviction. @default 0.15 */
  minActivation: number;
}

const DEFAULT_CONFIG: CognitiveWorkingMemoryConfig = {
  baseCapacity: 7,
  traits: {},
  activationDecayRate: 0.1,
  minActivation: 0.15,
};

// ---------------------------------------------------------------------------
// Personality → capacity modulation
// ---------------------------------------------------------------------------

const clamp01 = (v: number | undefined): number =>
  v == null ? 0.5 : Math.max(0, Math.min(1, v));

/**
 * Personality-modulated slot capacity:
 * - High openness → +1 slot (broader attention)
 * - High conscientiousness → -1 slot (deeper focus per slot)
 * - Result clamped to [5, 9] (Miller's 7±2)
 */
function computeCapacity(base: number, traits: HexacoTraits): number {
  const o = clamp01(traits.openness);
  const c = clamp01(traits.conscientiousness);
  let capacity = base;
  if (o > 0.6) capacity += 1;
  if (c > 0.6) capacity -= 1;
  return Math.max(5, Math.min(9, capacity));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Cognitive working memory with Baddeley-inspired slot management.
 *
 * Implements `IWorkingMemory` for the basic key-value surface
 * (`get/set/delete/clear/has/size/getAll`), with slot management
 * (phonological loop, visuospatial sketchpad, episodic buffer)
 * layered on top.
 */
export class CognitiveWorkingMemory implements IWorkingMemory {
  readonly id: string;

  private backing: IWorkingMemory;
  private config: CognitiveWorkingMemoryConfig;
  private capacity: number;
  private slots: Map<string, WorkingMemorySlot> = new Map();
  private nextSlotIndex = 0;

  constructor(backing: IWorkingMemory, config?: Partial<CognitiveWorkingMemoryConfig>) {
    this.backing = backing;
    this.id = backing.id;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.capacity = computeCapacity(this.config.baseCapacity, this.config.traits);
  }

  // =========================================================================
  // IWorkingMemory delegation
  // =========================================================================

  async initialize(gmiInstanceId: string, config?: Record<string, any>): Promise<void> {
    return this.backing.initialize(gmiInstanceId, config);
  }

  async set<T = any>(key: string, value: T): Promise<void> {
    return this.backing.set(key, value);
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    return this.backing.get<T>(key);
  }

  async delete(key: string): Promise<void> {
    return this.backing.delete(key);
  }

  async getAll(): Promise<Record<string, any>> {
    return this.backing.getAll();
  }

  async clear(): Promise<void> {
    this.slots.clear();
    return this.backing.clear();
  }

  /**
   * Empties the slot list and leaves the backing store as it is: what a session drops of a person whose memory was
   * deleted. No slot goes through `onEvict`, so nothing is encoded on its way out.
   */
  clearSlots(): void {
    this.slots.clear();
  }

  /**
   * Removes the slots of the given traces and leaves the backing store and every other slot as they are: what a
   * session drops of traces deleted for good, by a correction or a retention sweep. No slot goes through `onEvict`, so
   * nothing is encoded on its way out.
   *
   * @returns How many slots it removed.
   */
  dropTraces(traceIds: Iterable<string>): number {
    const gone = new Set(traceIds);
    let dropped = 0;
    for (const [slotId, slot] of this.slots) {
      if (!gone.has(slot.traceId)) continue;
      this.slots.delete(slotId);
      dropped += 1;
    }
    if (dropped > 0) this.rebalanceAttention();
    return dropped;
  }

  async size(): Promise<number> {
    return this.backing.size();
  }

  async has(key: string): Promise<boolean> {
    return this.backing.has(key);
  }

  async close(): Promise<void> {
    return this.backing.close?.();
  }

  // =========================================================================
  // Cognitive slot management
  // =========================================================================

  /** Current number of occupied slots. */
  getSlotCount(): number {
    return this.slots.size;
  }

  /** Maximum slot capacity (personality-modulated). */
  getCapacity(): number {
    return this.capacity;
  }

  /** Get all active slots. */
  getSlots(): WorkingMemorySlot[] {
    return Array.from(this.slots.values());
  }

  /** Get a specific slot by ID. */
  getSlot(slotId: string): WorkingMemorySlot | undefined {
    return this.slots.get(slotId);
  }

  /**
   * Focus attention on a trace, adding it to working memory.
   * If at capacity, the lowest-activation slot is evicted first.
   *
   * @returns The slot ID assigned to this trace.
   */
  async focus(traceId: string, initialActivation: number = 0.8): Promise<string> {
    // Check if this trace already has a slot
    for (const [slotId, slot] of this.slots) {
      if (slot.traceId === traceId) {
        // Refresh activation
        slot.activationLevel = Math.min(1.0, slot.activationLevel + 0.2);
        slot.rehearsalCount++;
        return slotId;
      }
    }

    // Evict if at capacity
    if (this.slots.size >= this.capacity) {
      await this.evictLowestActivation();
    }

    const slotId = `wm-slot-${this.nextSlotIndex++}`;
    const slot: WorkingMemorySlot = {
      slotId,
      traceId,
      activationLevel: Math.min(1.0, initialActivation),
      enteredAt: Date.now(),
      rehearsalCount: 0,
      attentionWeight: 1.0 / (this.slots.size + 1),
    };

    this.slots.set(slotId, slot);
    this.rebalanceAttention();
    return slotId;
  }

  /**
   * Rehearse a slot (maintenance rehearsal), bumping its activation.
   */
  rehearse(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    slot.activationLevel = Math.min(1.0, slot.activationLevel + 0.15);
    slot.rehearsalCount++;
  }

  /**
   * Apply per-turn activation decay to all slots.
   * Slots that drop below minActivation become eviction candidates.
   */
  async decayActivations(): Promise<string[]> {
    const evicted: string[] = [];

    for (const [slotId, slot] of this.slots) {
      slot.activationLevel = Math.max(0, slot.activationLevel - this.config.activationDecayRate);

      if (slot.activationLevel < this.config.minActivation) {
        await this.evictSlot(slotId);
        evicted.push(slotId);
      }
    }

    if (evicted.length > 0) {
      this.rebalanceAttention();
    }

    return evicted;
  }

  /**
   * Get working memory utilisation (0-1).
   */
  getUtilization(): number {
    return this.slots.size / this.capacity;
  }

  /**
   * Serialise current slots as a formatted string for prompt injection.
   */
  formatForPrompt(): string {
    if (this.slots.size === 0) return '';

    const lines: string[] = [];
    const sorted = Array.from(this.slots.values())
      .sort((a, b) => b.activationLevel - a.activationLevel);

    for (const slot of sorted) {
      const focus = slot.activationLevel > 0.7 ? '[ACTIVE]' : slot.activationLevel > 0.4 ? '[fading]' : '[weak]';
      lines.push(`- ${focus} ${slot.traceId} (activation: ${slot.activationLevel.toFixed(2)})`);
    }

    return lines.join('\n');
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private async evictLowestActivation(): Promise<void> {
    let lowestSlotId: string | null = null;
    let lowestActivation = Infinity;

    for (const [slotId, slot] of this.slots) {
      if (slot.activationLevel < lowestActivation) {
        lowestActivation = slot.activationLevel;
        lowestSlotId = slotId;
      }
    }

    if (lowestSlotId) {
      await this.evictSlot(lowestSlotId);
    }
  }

  private async evictSlot(slotId: string): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) return;

    if (this.config.onEvict) {
      await this.config.onEvict(slotId, slot.traceId);
    }

    this.slots.delete(slotId);
  }

  private rebalanceAttention(): void {
    const total = this.slots.size;
    if (total === 0) return;

    // Distribute attention proportional to activation level
    let totalActivation = 0;
    for (const slot of this.slots.values()) {
      totalActivation += slot.activationLevel;
    }

    if (totalActivation === 0) return;

    for (const slot of this.slots.values()) {
      slot.attentionWeight = slot.activationLevel / totalActivation;
    }
  }
}
