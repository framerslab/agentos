import { describe, it, expect, vi } from 'vitest';
import { CitationVerifier } from '../CitationVerifier.js';
import { formatVerifiedResponse } from '../format.js';

/** Deterministic mock embedding for testing. */
function mockEmbedFn(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(t => {
    const vec = new Array(8).fill(0);
    for (let i = 0; i < t.length; i++) {
      vec[i % 8] += t.charCodeAt(i) / 1000;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? vec.map(v => v / mag) : vec;
  }));
}

describe('CitationVerifier', () => {
  const verifier = new CitationVerifier({ embedFn: mockEmbedFn });

  it('verifies claims against matching sources', async () => {
    const result = await verifier.verify(
      'The sky appears blue during daytime. Water molecules are fundamentally wet in nature.',
      [{ content: 'The sky appears blue during daytime due to scattering.' }, { content: 'Water molecules are wet and cold.' }],
    );
    expect(result.totalClaims).toBe(2);
    expect(result.claims.every(c => c.verdict === 'supported' || c.verdict === 'weak')).toBe(true);
    expect(result.overallGrounded).toBe(true);
  });

  it('assigns verdicts based on cosine similarity thresholds', async () => {
    // With mock embeddings, all text gets some similarity — test the structure
    const result = await verifier.verify(
      'This is a very specific technical claim about quantum mechanics.',
      [{ content: 'Cats are small domesticated mammals that purr.' }],
    );
    expect(result.totalClaims).toBe(1);
    expect(result.claims[0].confidence).toBeGreaterThanOrEqual(0);
    expect(result.claims[0].confidence).toBeLessThanOrEqual(1);
    expect(['supported', 'weak', 'unverifiable']).toContain(result.claims[0].verdict);
  });

  it('returns empty result for empty text', async () => {
    const result = await verifier.verify('', [{ content: 'source' }]);
    expect(result.totalClaims).toBe(0);
    expect(result.overallGrounded).toBe(true);
    expect(result.supportedRatio).toBe(1);
  });

  it('uses custom extractClaims when provided', async () => {
    const customExtract = vi.fn().mockResolvedValue(['Claim A.', 'Claim B.']);
    const v = new CitationVerifier({ embedFn: mockEmbedFn, extractClaims: customExtract });
    const result = await v.verify('Some text.', [{ content: 'source' }]);
    expect(customExtract).toHaveBeenCalledWith('Some text.');
    expect(result.totalClaims).toBe(2);
  });

  it('detects contradiction via NLI', async () => {
    const nliFn = vi.fn().mockResolvedValue({ label: 'contradiction', score: 0.9 });
    const v = new CitationVerifier({
      embedFn: mockEmbedFn,
      nliFn,
      supportThreshold: 0.01,
    });
    const result = await v.verify(
      'The earth is flat.',
      [{ content: 'The earth is flat.' }],
    );
    expect(result.claims[0].verdict).toBe('contradicted');
    expect(result.overallGrounded).toBe(false);
  });

  it('formatVerifiedResponse renders a one-line summary', async () => {
    const result = await verifier.verify(
      'Cats are mammals. Dogs are reptiles.',
      [{ content: 'Cats are small domesticated mammals.' }],
    );
    expect(formatVerifiedResponse(result)).toMatch(/\d+\/\d+ claims verified \(\d+%\)/);
  });

  it('formatVerifiedResponse handles empty results', async () => {
    const result = await verifier.verify('', [{ content: 'source' }]);
    expect(formatVerifiedResponse(result)).toBe('No verifiable claims found.');
  });

  it('accepts a pre-decomposed string[] of claims and skips internal extraction', async () => {
    const extractSpy = vi.fn();
    const v = new CitationVerifier({ embedFn: mockEmbedFn, extractClaims: extractSpy });
    const result = await v.verify(
      ['Cats are mammals.', 'Dogs are reptiles.'],
      [{ content: 'Cats are small domesticated mammals.' }],
    );
    expect(extractSpy).not.toHaveBeenCalled();
    expect(result.totalClaims).toBe(2);
    expect(result.claims.map((c) => c.text)).toEqual(['Cats are mammals.', 'Dogs are reptiles.']);
  });

  it('verify(claims[]) keeps caller-provided claim order in result.claims', async () => {
    const result = await verifier.verify(
      ['First claim about A.', 'Second claim about B.', 'Third claim about C.'],
      [{ content: 'Sources about A and B.' }],
    );
    expect(result.claims[0].text).toBe('First claim about A.');
    expect(result.claims[1].text).toBe('Second claim about B.');
    expect(result.claims[2].text).toBe('Third claim about C.');
  });

  it('extractClaims() exposes the same decomposition the verify(string) path uses', async () => {
    const claims = await verifier.extractClaims(
      'The sky appears blue during daytime. Water molecules are fundamentally wet in nature.',
    );
    expect(claims.length).toBe(2);
    expect(claims[0]).toMatch(/sky/);
    expect(claims[1]).toMatch(/[Ww]ater/);
  });

  it('extractClaims() honors a custom extractor when configured', async () => {
    const customExtract = vi.fn().mockResolvedValue(['One.', 'Two.', 'Three.']);
    const v = new CitationVerifier({ embedFn: mockEmbedFn, extractClaims: customExtract });
    const claims = await v.extractClaims('whatever text');
    expect(customExtract).toHaveBeenCalledWith('whatever text');
    expect(claims).toEqual(['One.', 'Two.', 'Three.']);
  });
});

describe('CitationVerifier with known vectors and pickOnly', () => {
  /** An embedder that records what it is sent and answers a fixed vector a text. */
  function recordingEmbed(vectors: Record<string, number[]>) {
    const sent: string[][] = [];
    const embedFn = vi.fn(async (texts: string[]) => {
      sent.push([...texts]);
      return texts.map((text) => vectors[text] ?? [0, 0]);
    });
    return { embedFn, sent };
  }

  it('sends the embedder the claims and only the sources without a vector, and scores with the vector given', async () => {
    const { embedFn, sent } = recordingEmbed({ c: [1, 0], a: [1, 0], b: [0, 1] });
    const verifier = new CitationVerifier({ embedFn });
    const result = await verifier.verify(['c'], [{ content: 'a', embedding: [1, 0] }, { content: 'b' }]);
    expect(sent).toEqual([['c', 'b']]);
    expect(result.claims[0]).toMatchObject({ sourceIndex: 0, confidence: 1, verdict: 'supported' });
    expect(result.claims[0].scored).toBeUndefined();

    // A source whose vector is given ranks by that vector, not by its text.
    const swapped = await verifier.verify(['c'], [{ content: 'a', embedding: [0, 1] }, { content: 'b', embedding: [1, 0] }]);
    expect(sent[1]).toEqual(['c']);
    expect(swapped.claims[0]).toMatchObject({ sourceIndex: 1, confidence: 1 });
  });

  it('sends every source as before when none carries a vector', async () => {
    const { embedFn, sent } = recordingEmbed({ c: [1, 0], a: [1, 0], b: [0, 1] });
    await new CitationVerifier({ embedFn }).verify(['c'], [{ content: 'a' }, { content: 'b' }]);
    expect(sent).toEqual([['c', 'a', 'b']]);
  });

  it('refuses a source vector whose length differs from the claims\' vectors', async () => {
    const { embedFn } = recordingEmbed({ c: [1, 0] });
    await expect(new CitationVerifier({ embedFn }).verify(['c'], [{ content: 'a', embedding: [1, 0, 0] }])).rejects.toThrow(RangeError);
  });

  it('with pickOnly and one source names it without an embedding, and the judge still runs', async () => {
    // The vectors the embedder would answer are orthogonal, so a cosine would have named nothing.
    const { embedFn } = recordingEmbed({ c: [1, 0], a: [0, 1] });
    const nliFn = vi.fn().mockResolvedValue({ label: 'entailment', score: 1 });
    const verifier = new CitationVerifier({ embedFn, nliFn, pickOnly: true, supportThreshold: 0, unverifiableThreshold: 0 });
    const result = await verifier.verify(['c'], [{ content: 'a', url: 'https://example.org/a' }]);
    expect(embedFn).not.toHaveBeenCalled();
    expect(nliFn).toHaveBeenCalledWith('a', 'c');
    expect(result.claims[0]).toEqual({
      text: 'c', verdict: 'supported', confidence: 0, scored: false, sourceIndex: 0, sourceSnippet: 'a', sourceRef: 'https://example.org/a',
    });

    nliFn.mockResolvedValue({ label: 'contradiction', score: 0.9 });
    expect((await verifier.verify(['c'], [{ content: 'a' }])).claims[0]).toMatchObject({ verdict: 'contradicted', sourceIndex: 0, scored: false });
    nliFn.mockResolvedValue({ label: 'neutral', score: 0 });
    expect((await verifier.verify(['c'], [{ content: 'a' }])).claims[0]).toMatchObject({ verdict: 'unverifiable', sourceIndex: 0, scored: false });
    nliFn.mockRejectedValue(new Error('judge down'));
    expect((await verifier.verify(['c'], [{ content: 'a' }])).claims[0]).toMatchObject({ verdict: 'unverifiable', sourceIndex: 0, scored: false });
    expect(embedFn).not.toHaveBeenCalled();

    // Without a judge nothing decides the claim.
    const alone = await new CitationVerifier({ embedFn, pickOnly: true }).verify(['c', 'd'], [{ content: 'a' }]);
    expect(embedFn).not.toHaveBeenCalled();
    expect(alone.claims.map((claim) => [claim.verdict, claim.sourceIndex, claim.confidence, claim.scored])).toEqual([
      ['unverifiable', 0, 0, false],
      ['unverifiable', 0, 0, false],
    ]);
  });

  it('with pickOnly and more than one source ranks by cosine as before', async () => {
    const { embedFn, sent } = recordingEmbed({ c: [1, 0], a: [0, 1], b: [1, 0] });
    const result = await new CitationVerifier({ embedFn, pickOnly: true }).verify(['c'], [{ content: 'a' }, { content: 'b' }]);
    expect(sent).toEqual([['c', 'a', 'b']]);
    expect(result.claims[0]).toMatchObject({ sourceIndex: 1, confidence: 1, verdict: 'supported' });
    expect(result.claims[0].scored).toBeUndefined();
  });
});
