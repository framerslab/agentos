import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiniMaxImageProvider } from "../providers/MiniMaxImageProvider.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const success = {
  data: { image_urls: ["https://example.com/image.png"] },
  metadata: { success_count: 1, failed_count: 1 },
  base_resp: { status_code: 0 },
};

describe("MiniMaxImageProvider", () => {
  let provider: MiniMaxImageProvider;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    provider = new MiniMaxImageProvider();
    await provider.initialize({ apiKey: "test-key" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends generation parameters and normalizes partial-success URLs", async () => {
    fetchMock.mockResolvedValue(response(success));
    const result = await provider.generateImage({
      prompt: "A lighthouse",
      n: 2,
      size: "1024x1024",
      aspectRatio: "16:9",
      seed: 0,
      providerOptions: { minimax: { promptOptimizer: false } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.minimax.io/v1/image_generation");
    expect(init?.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "image-01",
      prompt: "A lighthouse",
      n: 2,
      width: 1024,
      height: 1024,
      aspect_ratio: "16:9",
      seed: 0,
      response_format: "url",
      prompt_optimizer: false,
    });
    expect(result).toMatchObject({
      providerId: "minimax",
      modelId: "image-01",
      usage: { totalImages: 1 },
      images: [
        { url: success.data.image_urls[0], providerMetadata: success.metadata },
      ],
    });
  });

  it("uses the China API root and the requested model for base64 output", async () => {
    await provider.initialize({
      apiKey: "regional-key",
      baseURL: "https://api.minimaxi.com/v1/image_generation".replace(
        "/image_generation",
        "/",
      ),
    });
    fetchMock.mockResolvedValue(
      response({
        data: { image_base64: ["aGVsbG8="] },
        base_resp: { status_code: 0 },
      }),
    );
    const result = await provider.generateImage({
      modelId: "image-01-live",
      prompt: "A lighthouse",
      responseFormat: "b64_json",
      providerOptions: {
        minimax: { width: 1024, height: 768, promptOptimizer: true },
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "image-01-live",
      response_format: "base64",
      width: 1024,
      height: 768,
      prompt_optimizer: true,
    });
    expect(result.images[0].base64).toBe("aGVsbG8=");
  });

  it("preserves the MIME type when a base64 response includes a data URL", async () => {
    fetchMock.mockResolvedValue(
      response({
        data: { image_base64: ["data:image/jpeg;base64,aGVsbG8="] },
        base_resp: { status_code: 0 },
      }),
    );
    const result = await provider.generateImage({
      prompt: "A lighthouse",
      responseFormat: "b64_json",
    });
    expect(result.images[0]).toMatchObject({
      mimeType: "image/jpeg",
      base64: "aGVsbG8=",
    });
  });

  it("supports flat options and initialization model overrides", async () => {
    await provider.initialize({
      apiKey: "test-key",
      defaultModelId: "image-01-live",
    });
    fetchMock.mockResolvedValue(response(success));
    await provider.generateImage({
      prompt: "A lighthouse",
      providerOptions: { promptOptimizer: true },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: "image-01-live",
      prompt_optimizer: true,
    });
  });

  it.each([401, 429, 500])("rejects HTTP %s", async (status) => {
    fetchMock.mockResolvedValue(response({}, status));
    await expect(
      provider.generateImage({ prompt: "A lighthouse" }),
    ).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([1002, 1004, 1008, 2013])(
    "rejects API status %s even with HTTP 200",
    async (status_code) => {
      fetchMock.mockResolvedValue(
        response({ ...success, base_resp: { status_code } }),
      );
      await expect(
        provider.generateImage({ prompt: "A lighthouse" }),
      ).rejects.toThrow(`status ${status_code}`);
    },
  );

  it.each([null, {}, { data: success.data }])(
    "rejects a missing success status",
    async (body) => {
      fetchMock.mockResolvedValue(response(body));
      await expect(
        provider.generateImage({ prompt: "A lighthouse" }),
      ).rejects.toThrow("status missing");
    },
  );

  it.each([
    undefined,
    {},
    { image_urls: [] },
    { image_urls: [123] },
    { image_urls: [""] },
  ])("rejects missing or malformed images", async (data) => {
    fetchMock.mockResolvedValue(
      response({ data, base_resp: { status_code: 0 } }),
    );
    await expect(
      provider.generateImage({ prompt: "A lighthouse" }),
    ).rejects.toThrow("no valid images");
  });

  it("rejects generation before initialization and after shutdown", async () => {
    const uninitialized = new MiniMaxImageProvider();
    await expect(
      uninitialized.generateImage({ prompt: "A lighthouse" }),
    ).rejects.toThrow("not initialized");
    await provider.shutdown();
    expect(provider.isInitialized).toBe(false);
    await expect(
      provider.generateImage({ prompt: "A lighthouse" }),
    ).rejects.toThrow("not initialized");
  });

  it("requires credentials and advertises both models", async () => {
    await expect(provider.initialize({ apiKey: " " })).rejects.toThrow(
      "requires apiKey",
    );
    expect(provider.isInitialized).toBe(false);
    expect(await provider.listAvailableModels()).toEqual([
      { providerId: "minimax", modelId: "image-01" },
      { providerId: "minimax", modelId: "image-01-live" },
    ]);
  });
});
