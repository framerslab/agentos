/** Browser-safe wire contracts. No server runtime, provider, store or Node import is reachable here. */
export * from './schemas.js';
/** OpenAPI generation uses the same schemas and remains browser-safe. */
export { buildVoicePlatformOpenApi, serializeVoicePlatformOpenApi, VOICE_HTTP_EXAMPLES } from './openapi.js';
export type { VoicePlatformOpenApi } from './openapi.js';
