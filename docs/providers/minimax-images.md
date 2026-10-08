# MiniMax image generation

Set `MINIMAX_API_KEY`, then call the `minimax` image provider:

```ts
import { generateImage } from "@framers/agentos";

const result = await generateImage({
  provider: "minimax",
  prompt: "A watercolor lighthouse at sunrise",
  aspectRatio: "16:9",
  n: 2,
  seed: 42,
  providerOptions: { minimax: { promptOptimizer: true } },
});
console.log(result.images);
```

The default model is `image-01`; pass `model: 'image-01-live'` to select
that model explicitly. A configured key also enables automatic image-provider
detection and fallback.

Requests use `https://api.minimax.io/v1/image_generation` by default. For China, set `MINIMAX_BASE_URL` to
`https://api.minimaxi.com/v1`, or pass that API root
as `baseUrl` together with its regional API key. Direct provider initialization
accepts `apiKey`, `baseURL`, and `defaultModelId`.

Use `responseFormat: 'b64_json'` for inline base64 data. Otherwise, image URLs
expire after 24 hours. Download them before they expire. `size: '1024x1024'` or
`providerOptions.minimax.width` and `height` supply pixel dimensions;
`aspectRatio` takes precedence when both are set. The API validates model-specific
size limits. Generation metadata is retained on each image, including partial
success and failure counts. HTTP errors, API errors, and missing image data reject
the request. Image editing is not implemented by this provider.

See the [MiniMax text-to-image API documentation](https://platform.minimax.io/docs/api-reference/image-generation-t2i).
