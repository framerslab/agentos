import { describe, it, expect } from 'vitest';
import { resolveCacheCapabilities } from '../model-cache-capabilities';

/**
 * Per-model cache capability table, pinned against Anthropic's prompt-caching
 * docs (2026-09-30): cacheable-prefix floors of 512/1024/2048/4096 tokens,
 * which are not monotonic across generations, and prior-turn thinking
 * retention on Opus 4.5+ / Sonnet 4.6+ / Fable / Mythos only (all Haiku and
 * older Opus/Sonnet strip server-side before caching).
 */
describe('resolveCacheCapabilities', () => {
  const cases: Array<[string, { floor: number; retains: boolean; caches?: boolean }]> = [
    // Opus 5.x, Fable, Mythos 5.x and Sonnet 5.5: 512
    ['claude-opus-5', { floor: 512, retains: true }],
    ['anthropic/claude-opus-5', { floor: 512, retains: true }],
    ['claude-opus-5-5', { floor: 512, retains: true }],
    ['anthropic/claude-opus-5-5', { floor: 512, retains: true }],
    ['claude-fable-5', { floor: 512, retains: true }],
    ['claude-fable-5-1', { floor: 512, retains: true }],
    ['claude-mythos-5', { floor: 512, retains: true }],
    ['claude-mythos-5-1', { floor: 512, retains: true }],
    ['claude-sonnet-5-5', { floor: 512, retains: true }],
    ['anthropic/claude-sonnet-5-5', { floor: 512, retains: true }],
    ['claude-sonnet-5-5-20261001', { floor: 512, retains: true }],
    // Mythos Preview keeps its own 2048 floor
    ['claude-mythos-preview', { floor: 2048, retains: true }],
    // Opus 4.x: each minor version has its own floor
    ['claude-opus-4-8', { floor: 1024, retains: true }],
    ['anthropic/claude-opus-4-8', { floor: 1024, retains: true }],
    ['anthropic.claude-opus-4-8', { floor: 1024, retains: true }],
    ['anthropic:claude-opus-4-7', { floor: 2048, retains: true }],
    ['claude-opus-4-6', { floor: 4096, retains: true }],
    ['claude-opus-4-5-20251101', { floor: 4096, retains: true }],
    // Older Opus: pre-retention, 1024
    ['claude-opus-4-1', { floor: 1024, retains: false }],
    ['claude-opus-4-1-20250805', { floor: 1024, retains: false }],
    ['claude-opus-4-20250514', { floor: 1024, retains: false }],
    ['claude-3-opus-20240229', { floor: 1024, retains: false }],
    // Sonnet 4.6 and Sonnet 5: retain, 1024
    ['claude-sonnet-4-6', { floor: 1024, retains: true }],
    ['claude-sonnet-5', { floor: 1024, retains: true }],
    ['claude-sonnet-5-20260101', { floor: 1024, retains: true }],
    // Older Sonnet: 1024, no retention
    ['claude-sonnet-4-5-20250929', { floor: 1024, retains: false }],
    ['claude-sonnet-4-20250514', { floor: 1024, retains: false }],
    ['claude-3-7-sonnet-20250219', { floor: 1024, retains: false }],
    ['claude-3-5-sonnet-20241022', { floor: 1024, retains: false }],
    // Haiku: never retains; 4.5 has the 4096 floor, 3.x the 2048 floor
    ['claude-haiku-4-5-20251001', { floor: 4096, retains: false }],
    ['claude-haiku-4-5', { floor: 4096, retains: false }],
    ['claude-3-5-haiku-20241022', { floor: 2048, retains: false }],
    ['claude-3-haiku-20240307', { floor: 2048, retains: false }],
    // Unknown future claude model: modern default, the highest floor
    ['claude-nova-9', { floor: 4096, retains: true }],
    // Non-Anthropic id routed here by mistake: auto-cache stands down
    ['gpt-4o-mini', { floor: 4096, retains: false, caches: false }],
  ];

  for (const [id, want] of cases) {
    it(`${id} -> floor=${want.floor} retains=${want.retains}${want.caches === false ? ' caches=false' : ''}`, () => {
      const caps = resolveCacheCapabilities(id);
      expect(caps.minCacheablePrefixTokens).toBe(want.floor);
      expect(caps.retainsPriorThinkingInContext).toBe(want.retains);
      expect(caps.supportsPromptCaching).toBe(want.caches !== false);
    });
  }
});
