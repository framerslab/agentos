/**
 * @fileoverview Reconsolidation — emotional drift on memory retrieval.
 *
 * Cognitive science foundations:
 * - **Reconsolidation** (Nader, Schafe & Le Doux, 2000): Retrieved memories
 *   re-enter a labile state and are restabilized with influence from the
 *   current emotional context. Each retrieval is a potential modification event.
 * - **Reconsolidation review** (Nader, 2003): Comprehensive review establishing
 *   reconsolidation as a general memory phenomenon beyond fear conditioning.
 *
 * @module agentos/memory/mechanisms/retrieval/Reconsolidation
 */

import type { MemoryTrace } from '../../core/types.js';
import type { PADState } from '../../core/config.js';
import type { ResolvedReconsolidationConfig, MechanismMetadata } from '../types.js';
import { CORRECTION_TAG } from '../types.js';

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Read mechanism metadata from trace.structuredData, initializing if absent.
 * Metadata is stored under `structuredData.mechanismMetadata` to avoid
 * polluting the core MemoryTrace interface.
 */
function getMeta(trace: MemoryTrace): MechanismMetadata {
  if (!trace.structuredData) trace.structuredData = {};
  if (!trace.structuredData.mechanismMetadata) {
    trace.structuredData.mechanismMetadata = {};
  }
  return trace.structuredData.mechanismMetadata as MechanismMetadata;
}

// ---------------------------------------------------------------------------
// Reconsolidation
// ---------------------------------------------------------------------------

/**
 * Apply reconsolidation drift to a trace's emotional context.
 *
 * Blends the trace's PAD values toward the current mood by `driftRate`.
 * Respects importance immunity and cumulative drift caps.
 * Records a DriftEvent in trace metadata for auditability.
 * A trace tagged `correction` (a person's own correction of what is remembered of them) never drifts.
 *
 * @param trace       The memory trace being accessed (mutated in place).
 * @param currentMood Current GMI mood at retrieval time.
 * @param config      Resolved reconsolidation config.
 */
export function applyReconsolidation(
  trace: MemoryTrace,
  currentMood: PADState,
  config: ResolvedReconsolidationConfig,
): void {
  if (!config.enabled) return;

  // A correction is kept as the person gave it.
  if (trace.tags.includes(CORRECTION_TAG)) return;

  // Importance immunity — use encodingStrength as importance proxy
  if (trace.encodingStrength >= config.immuneAboveImportance) return;

  const meta = getMeta(trace);
  const cumulative = meta.cumulativeDrift ?? 0;
  if (cumulative >= config.maxDriftPerTrace) return;

  const remaining = config.maxDriftPerTrace - cumulative;
  // Halve drift rate for perspective-encoded traces — they already shifted
  // from objective truth at encoding time; full reconsolidation on retrieval
  // would compound the distortion.
  const perspectiveEncoded = (meta as any).perspectiveEncoded === true;
  const rate = perspectiveEncoded ? config.driftRate * 0.5 : config.driftRate;

  // Snapshot before drift
  const before: PADState = {
    valence: trace.emotionalContext.valence,
    arousal: trace.emotionalContext.arousal,
    dominance: trace.emotionalContext.dominance,
  };

  // Compute raw deltas (linear interpolation toward current mood)
  let dV = rate * (currentMood.valence - trace.emotionalContext.valence);
  let dA = rate * (currentMood.arousal - trace.emotionalContext.arousal);
  let dD = rate * (currentMood.dominance - trace.emotionalContext.dominance);

  // Clamp total delta magnitude to remaining drift budget
  const totalDelta = Math.abs(dV) + Math.abs(dA) + Math.abs(dD);
  if (totalDelta > remaining && totalDelta > 0) {
    const scale = remaining / totalDelta;
    dV *= scale;
    dA *= scale;
    dD *= scale;
  }

  // Apply drift
  trace.emotionalContext.valence += dV;
  trace.emotionalContext.arousal += dA;
  trace.emotionalContext.dominance += dD;
  trace.emotionalContext.intensity =
    Math.abs(trace.emotionalContext.valence) * Math.max(0, trace.emotionalContext.arousal);

  // Update cumulative drift and audit trail
  const actualDelta = Math.abs(dV) + Math.abs(dA) + Math.abs(dD);
  meta.cumulativeDrift = cumulative + actualDelta;
  if (!meta.driftHistory) meta.driftHistory = [];
  meta.driftHistory.push({
    timestamp: Date.now(),
    beforePAD: before,
    afterPAD: {
      valence: trace.emotionalContext.valence,
      arousal: trace.emotionalContext.arousal,
      dominance: trace.emotionalContext.dominance,
    },
  });
}
