/**
 * Provider error code for a request larger than the model's context window:
 * the provider rejected it, or a size check refused to send it. Another model
 * with a larger window can serve the request, and the rejection says nothing
 * about the provider's health.
 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';
