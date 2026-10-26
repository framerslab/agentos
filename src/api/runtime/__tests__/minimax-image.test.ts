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

  it("generates with image-01 when the global default names MiniMax's text model", async () => {
    // A host that pins MiniMax's text model makes images with MiniMax's image
    // model; the chat model is never posted to /image_generation.
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("image-01");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.minimax.io/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("image-01");
  });

  it("generates with image-01 on the China root when the global default names MiniMax's text model", async () => {
    // MINIMAX_BASE_URL set to MiniMax's China root picks a region of MiniMax's
    // own API, which serves the same model names; it is not a custom endpoint
    // that keeps the default's model.
    vi.stubEnv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1");
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("image-01");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("image-01");
  });

  it("generates with image-01 on the China root the default names when MINIMAX_BASE_URL names a custom endpoint", async () => {
    // The default's base URL goes ahead of MINIMAX_BASE_URL, so the call is
    // sent to MiniMax's own China API, where the chat model cannot make
    // images; the custom endpoint in the environment is not where it goes.
    vi.stubEnv("MINIMAX_BASE_URL", "http://img.test/v1");
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
      baseUrl: "https://api.minimaxi.com/v1",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.model).toBe("image-01");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("image-01");
  });

  it("generates with image-01 on the China root when MINIMAX_BASE_URL ends in a newline", async () => {
    // The image provider trims the base URL, so the call reaches the China
    // root; the root read with its newline is still MiniMax's own endpoint.
    vi.stubEnv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1\n");
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.model).toBe("image-01");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("image-01");
  });

  it("generates with image-01 on the global root when MINIMAX_BASE_URL holds only whitespace", async () => {
    // A value of whitespace alone is unset (model.ts, resolveBaseUrl), so the
    // call is sent with no base URL and the image provider sends to MiniMax's
    // global root, where the chat model cannot make images.
    vi.stubEnv("MINIMAX_BASE_URL", " \n");
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.model).toBe("image-01");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.minimax.io/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("image-01");
  });

  // An empty or whitespace-only base URL on the default or on the call is
  // unset (model.ts, resolveBaseUrl: the rule the model pool states as "empty
  // counts as missing"), so MINIMAX_BASE_URL applies as it does for a call
  // with no baseUrl, and with no variable the call goes to MiniMax's global
  // root. The three cases below pin where the default's key goes and which
  // model is sent for each place the variable can point.
  const blankBaseUrls: Array<[string, { baseUrl?: string }, { baseUrl?: string }]> = [
    ["the default's baseUrl is empty", { baseUrl: "" }, {}],
    ["the call's baseUrl is empty", {}, { baseUrl: "" }],
    ["the default's baseUrl is whitespace", { baseUrl: " \n" }, {}],
    ["the call's baseUrl is whitespace", {}, { baseUrl: " \t" }],
  ];

  it.each(blankBaseUrls)(
    "keeps the default's model on the custom endpoint MINIMAX_BASE_URL names when %s",
    async (_label, defaultBaseUrl, callBaseUrl) => {
      // The blank is passed over, so the gateway in the environment is where
      // the default's key goes, as it is for a call with no baseUrl; a custom
      // endpoint may serve any model under any name, so the default's model
      // stays.
      vi.stubEnv("MINIMAX_BASE_URL", "http://gateway.test/v1");
      setDefaultProvider({
        provider: "minimax",
        model: "MiniMax-M3.1-Flash",
        apiKey: "default-key",
        ...defaultBaseUrl,
      });
      const result = await generateImage({ prompt: "A lighthouse", ...callBaseUrl });
      expect(result.model).toBe("MiniMax-M3.1-Flash");
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("http://gateway.test/v1/image_generation");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer default-key" });
      expect(JSON.parse(String(init?.body)).model).toBe("MiniMax-M3.1-Flash");
    },
  );

  it.each(blankBaseUrls)(
    "generates with image-01 on the China root MINIMAX_BASE_URL names when %s",
    async (_label, defaultBaseUrl, callBaseUrl) => {
      // The blank is passed over, so the China root in the environment is
      // where the call goes; a root of MiniMax's own serves its own names, so
      // the chat model is dropped for image-01 there.
      vi.stubEnv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1");
      setDefaultProvider({
        provider: "minimax",
        model: "MiniMax-M3.1-Flash",
        apiKey: "default-key",
        ...defaultBaseUrl,
      });
      const result = await generateImage({ prompt: "A lighthouse", ...callBaseUrl });
      expect(result.model).toBe("image-01");
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer default-key" });
      expect(JSON.parse(String(init?.body)).model).toBe("image-01");
    },
  );

  it.each(blankBaseUrls)(
    "generates with image-01 on the global root when %s and MINIMAX_BASE_URL is unset",
    async (_label, defaultBaseUrl, callBaseUrl) => {
      // With every source blank, the call is sent with no base URL and the
      // image provider sends to MiniMax's global root, where the chat model
      // cannot make images.
      setDefaultProvider({
        provider: "minimax",
        model: "MiniMax-M3.1-Flash",
        apiKey: "default-key",
        ...defaultBaseUrl,
      });
      const result = await generateImage({ prompt: "A lighthouse", ...callBaseUrl });
      expect(result.model).toBe("image-01");
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://api.minimax.io/v1/image_generation");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer default-key" });
      expect(JSON.parse(String(init?.body)).model).toBe("image-01");
    },
  );

  const rootSpellings: Array<[string, string]> = [
    ["HTTPS://API.MINIMAX.IO/v1", "https://api.minimax.io/v1/image_generation"],
    ["HTTPS://API.MINIMAXI.COM/v1", "https://api.minimaxi.com/v1/image_generation"],
    ["https://Api.MiniMax.io:443/v1/", "https://api.minimax.io/v1/image_generation"],
  ];

  it.each(rootSpellings)(
    "generates with image-01 when MINIMAX_BASE_URL is %s, which fetch sends to %s",
    async (baseUrl, sentTo) => {
      // fetch parses the URL as the URL Standard does: it lowercases the
      // scheme and the host and drops the default port, so the request
      // reaches MiniMax's own API, where the chat model cannot make images.
      vi.stubEnv("MINIMAX_BASE_URL", baseUrl);
      setDefaultProvider({
        provider: "minimax",
        model: "MiniMax-M3.1-Flash",
        apiKey: "default-key",
      });
      const result = await generateImage({ prompt: "A lighthouse" });
      expect(result.model).toBe("image-01");
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(new URL(String(url)).href).toBe(sentTo);
      expect(JSON.parse(String(init?.body)).model).toBe("image-01");
    },
  );

  it("keeps the default's model on a host that only begins with MiniMax's", async () => {
    // A host in capitals is MiniMax's own only when it is MiniMax's host; a
    // longer one is a custom endpoint, which may serve any model under any name.
    vi.stubEnv("MINIMAX_BASE_URL", "HTTPS://API.MINIMAX.IO.GATEWAY.TEST/v1");
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.model).toBe("MiniMax-M3.1-Flash");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).href).toBe("https://api.minimax.io.gateway.test/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("MiniMax-M3.1-Flash");
  });

  it("keeps the default's model on the custom endpoint the default names when MINIMAX_BASE_URL is the China root", async () => {
    // The call goes to the default's custom endpoint, ahead of the root in the
    // environment, and a custom endpoint may serve any model under any name.
    vi.stubEnv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1");
    setDefaultProvider({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      apiKey: "default-key",
      baseUrl: "http://img.test/v1",
    });
    const result = await generateImage({ prompt: "A lighthouse" });
    expect(result.model).toBe("MiniMax-M3.1-Flash");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://img.test/v1/image_generation");
    expect(JSON.parse(String(init?.body)).model).toBe("MiniMax-M3.1-Flash");
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
