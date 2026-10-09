/**
 * @file citationVerification.ts
 * The `verifyCitations` check `agent().generate()` runs on its answer, on both
 * runtimes: the sources the configured retriever finds for the user's input,
 * and a {@link CitationVerifier} verdict for each claim of the answer.
 */
import { CitationVerifier } from '../../cognition/rag/citation/CitationVerifier.js';
import type { VerifiedResponse } from '../../cognition/rag/citation/types.js';
import type { VerifyCitationsConfig } from '../types.js';

/**
 * Run citation verification on a freshly-generated response. Retrieves
 * sources via the configured `retrieve` hook, then scores each atomic claim
 * in the response against those sources with {@link CitationVerifier}.
 *
 * Errors are non-fatal: a failed retrieval or verifier crash returns
 * `undefined` so the agent's response is still delivered to the caller
 * unchanged. Verification is a *check*, not a gate.
 *
 * @param text     - The generated response text to verify.
 * @param userText - The user's input — passed to the retriever as a query.
 * @param config   - Verifier wiring (embedder, retriever, thresholds).
 */
export async function runCitationVerification(
  text: string,
  userText: string,
  config: VerifyCitationsConfig,
): Promise<VerifiedResponse | undefined> {
  try {
    // Resolve wiring: `retrievalAugmentor` shortcut takes precedence and
    // auto-derives both retrieve + embedFn. Otherwise fall back to the
    // explicit hooks. We require at least one valid combination; if neither
    // is provided we no-op (verification is a check, not a gate, so a
    // missing config should not fail the response).
    const augmentor = config.retrievalAugmentor;

    const retrieve = augmentor
      ? async (query: string) => {
          const result = await augmentor.retrieveContext(query, config.retrievalOptions);
          // Convert RagRetrievedChunk -> VerificationSource. The verifier only
          // looks at content/title/url; metadata + score are dropped (they
          // do not feed cosine similarity).
          return (result.retrievedChunks ?? []).map((chunk) => ({
            content: chunk.content,
            title:
              typeof chunk.metadata?.title === 'string'
                ? (chunk.metadata.title as string)
                : undefined,
            url:
              chunk.source ??
              (typeof chunk.metadata?.url === 'string'
                ? (chunk.metadata.url as string)
                : undefined),
          }));
        }
      : config.retrieve;

    const embedFn = augmentor
      ? (texts: string[]) => augmentor.embedTexts(texts)
      : config.embedFn;

    if (!retrieve || !embedFn) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          '[@framers/agentos] verifyCitations missing both retrievalAugmentor and explicit retrieve/embedFn. Skipping verification.',
        );
      }
      return undefined;
    }

    const sources = await retrieve(userText);
    if (!sources || sources.length === 0) return undefined;
    const verifier = new CitationVerifier({
      embedFn,
      supportThreshold: config.supportThreshold,
      unverifiableThreshold: config.unverifiableThreshold,
      nliFn: config.nliFn,
      extractClaims: config.extractClaims,
    });
    return await verifier.verify(text, sources);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[@framers/agentos] verifyCitations failed: ${(err as Error).message}. Returning response without grounding.`,
      );
    }
    return undefined;
  }
}
