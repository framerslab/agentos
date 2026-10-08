import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateImage } from "../../generateImage.js";
import { resolveMediaProvider, resolveModelOption } from "../../model.js";
import {
  createImageProvider,
  hasImageProviderFactory,
} from "../../../io/media/images/index.js";
import { clearDefaultProvider, setDefaultProvider } from "../global-default.js";
import { autoDetectProvider } from "../provider-defaults.js";

describe("MiniMax image API integration", () => {
  beforeEach(() => {
    clearDefaultProvider();
    for (const key of Object.keys(process.env)) {
      if (/API_KEY|API_TOKEN|BASE_URL/.test(key)) vi.stubEnv(key, "");
    }
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { image_urls: ["https://example.com/image.png"] },
          base_resp: { status_code: 0 },
        }),
      ),
    );
  });

  afterEach(() => {
    clearDefaultProvider();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers the factory, default image model, and credentials", () => {
    expect(hasImageProviderFactory("minimax")).toBe(true);
    expect(createImageProvider("minimax").providerId).toBe("minimax");
    expect(resolveModelOption({ provider: "minimax" }, "image")).toEqual({
      providerId: "minimax",
      modelId: "image-01",
    });
    expect(resolveMediaProvider("minimax", "image-01").apiKey).toBe("test-key");
    expect(autoDetectProvider("image")).toBe("minimax");
  });

  it("automatically detects the provider from its key", async () => {
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("image-01");
  });

  it("resolves the regional endpoint and passes namespaced options", async () => {
    vi.stubEnv(
      "MINIMAX_BASE_URL",
      "https://api.minimaxi.com/v1/image_generation".replace(
        "/image_generation",
        "",
      ),
    );
    const result = await generateImage({
      provider: "minimax",
      model: "image-01-live",
      prompt: "A lighthouse",
      providerOptions: { minimax: { promptOptimizer: true } },
    });
    expect(result.model).toBe("image-01-live");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(JSON.parse(String(init?.body)).prompt_optimizer).toBe(true);
  });

  it("uses an explicit global default without environment credentials", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "");
    setDefaultProvider({ provider: "minimax", apiKey: "default-key" });
    expect((await generateImage({ prompt: "A lighthouse" })).provider).toBe(
      "minimax",
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer default-key",
    });
  });

  it("requires a key and honors inline credential overrides", () => {
    vi.stubEnv("MINIMAX_API_KEY", "");
    expect(() => resolveMediaProvider("minimax", "image-01")).toThrow(
      "MINIMAX_API_KEY",
    );
    expect(
      resolveMediaProvider("minimax", "image-01", { apiKey: "inline-key" })
        .apiKey,
    ).toBe("inline-key");
  });
});
