import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedText, type EmbedTextOptions } from "../../embedText.js";
import { clearDefaultProvider, setDefaultProvider } from "../global-default.js";

// MiniMax publishes no embedding model. Without a MiniMax base URL, embedText's
// OpenAI-compatible branch sends to https://api.openai.com/v1, so a MiniMax
// call must be refused before any request carries the MiniMax key.
describe("embedText on MiniMax", () => {
  beforeEach(() => {
    clearDefaultProvider();
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test-key");
    // Recorded by the stub, so unstubAllEnvs restores it; then unset.
    vi.stubEnv("MINIMAX_BASE_URL", "");
    delete process.env.MINIMAX_BASE_URL;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: "MiniMax-M3.1-Flash",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      ),
    );
  });

  afterEach(() => {
    clearDefaultProvider();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const targets: Array<[string, Pick<EmbedTextOptions, "provider" | "model">]> = [
    ["the provider and its text model", { provider: "minimax", model: "MiniMax-M3.1-Flash" }],
    ["a minimax: model id", { model: "minimax:MiniMax-M3" }],
  ];

  it.each(targets)("refuses %s before any request is sent", async (_label, target) => {
    await expect(embedText({ ...target, input: "hello" })).rejects.toThrow(
      "MiniMax publishes no embedding model",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses under a MiniMax global default that names a custom endpoint, as the provider does", async () => {
    // MiniMaxProvider refuses embeddings whatever its base URL; embedText
    // follows it rather than posting the default's key to that endpoint.
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
      baseUrl: "http://embed.test/v1",
    });
    await expect(embedText({ input: "hello" })).rejects.toThrow(
      "MiniMax publishes no embedding model",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
