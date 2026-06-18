import { describe, expect, it } from 'vitest';
import { GeminiProvider } from '../implementations/GeminiProvider';
import { isContentPolicyRefusal } from '../../../../api/generateText';

// mapResponseToCompletion is a pure mapping (no network/init needed).
type MapFn = (resp: unknown, modelId: string) => unknown;
function mapper(p: GeminiProvider): MapFn {
  return (p as unknown as { mapResponseToCompletion: MapFn }).mapResponseToCompletion.bind(p);
}

const usage = { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 };

describe('GeminiProvider — SAFETY block surfaces as a content-policy error (fallback can engage)', () => {
  it('throws a content_filter error when Gemini returns a SAFETY finish with no content', () => {
    const provider = new GeminiProvider();
    const blocked = { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }], usageMetadata: usage };
    expect(() => mapper(provider)(blocked, 'gemini-2.5-flash')).toThrow(/safety|blocked|content/i);
  });

  it('the thrown error is classified as a content-policy refusal (engages the policy-aware fallback)', () => {
    const provider = new GeminiProvider();
    const blocked = { candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }], usageMetadata: usage };
    let caught: unknown;
    try {
      mapper(provider)(blocked, 'gemini-2.5-flash');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('content_filter');
    expect(isContentPolicyRefusal(caught)).toBe(true);
  });

  it('does NOT throw for a normal completion with content', () => {
    const provider = new GeminiProvider();
    const ok = { candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { ...usage, candidatesTokenCount: 1 } };
    expect(() => mapper(provider)(ok, 'gemini-2.5-flash')).not.toThrow();
  });

  it('does NOT throw when a SAFETY finish still returned partial text (returns what we have)', () => {
    const provider = new GeminiProvider();
    const partial = { candidates: [{ content: { parts: [{ text: 'partial answer' }] }, finishReason: 'SAFETY' }], usageMetadata: { ...usage, candidatesTokenCount: 2 } };
    expect(() => mapper(provider)(partial, 'gemini-2.5-flash')).not.toThrow();
  });
});
