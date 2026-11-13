/**
 * @fileoverview The error types and codes a log line may carry. An error's `name` and `code` are set by whoever
 * threw it (a tool, a vendor's SDK, a host's store or callback), so a line keeps one only when it is a member of
 * these closed lists and writes `unknown` otherwise. Both are read-only views with no `add`, `delete` or `clear`, so
 * a host cannot change them. A new error class
 * or code of the library is added here in the change that adds it (tests/logging/listed-error-lists.spec.ts fails
 * until it is).
 *
 * @module agentos/core/logging/listedErrors
 */

/**
 * A frozen read-only view of `values`: membership, size and iteration over a set no caller can reach. A frozen `Set`
 * would not do, since `Object.freeze()` leaves its `add`, `delete` and `clear` working.
 */
function closedList(values: readonly string[]): ReadonlySet<string> {
  const members = new Set<string>(values);
  const view: ReadonlySet<string> = {
    get size() { return members.size; },
    has: (value: string) => members.has(value),
    forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) {
      members.forEach((value) => callback.call(thisArg, value, value, view));
    },
    entries: () => members.entries(),
    keys: () => members.keys(),
    values: () => members.values(),
    [Symbol.iterator]: () => members.values(),
  } as ReadonlySet<string>;
  return Object.freeze(view);
}

/**
 * JavaScript's built-in error classes, the platform's names for an abort, a timeout and a value that cannot be cloned,
 * and the library's own: each error class it declares and each name it sets on an error where it throws it.
 */
export const LISTED_ERROR_TYPES: ReadonlySet<string> = closedList([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'AbortError', 'TimeoutError', 'DataCloneError',
  'AgencyConfigError', 'AgencyPanelError', 'AgencyQuorumError', 'AgencySeatingError', 'AgentCoreError',
  'AgentFactoryError', 'AgentOSServiceError', 'AggregateVoiceError', 'AnthropicProviderError', 'AppError',
  'AttemptBudgetExhaustedError', 'AuthenticationError', 'AvatarProviderError', 'CLISubprocessError',
  'CapabilityManifestRefusedError', 'CeilingError', 'CircuitOpenError', 'ClaudeCodeProviderError', 'ContentKeyError',
  'ContextWindowExceededError', 'ConversationTableConflictError', 'CostCapExceededError', 'CreditConflictError',
  'DeepgramUsageReadError', 'DestinationRefusedError', 'DispatchRefusedError', 'DocumentReadTimeoutError',
  'DocumentTooComplexError', 'DocumentTooLargeError', 'DuplicateIdempotencyKeyError', 'EgressRefusedError',
  'EmptyTranscriptError', 'FencedError', 'GMIError', 'GMIManagerError', 'GeminiCLIProviderError',
  'GeminiProviderError', 'GuardedFetchError', 'GuardrailStopError', 'ImageEditNotSupportedError',
  'ImageUpscaleNotSupportedError', 'ImageVariationNotSupportedError', 'IngestRouterBudgetExceededError',
  'IngestRouterDispatcherMissingError', 'IngestRouterUnknownKindError', 'InvalidAgentWorkspaceIdError',
  'InvalidSegmentationPromptError', 'InvalidToolNameError', 'InvalidWikiPageIdError', 'LLMProviderCircuitOpenError',
  'LanguageDetectionUnsupportedError', 'LibraryCursorError', 'LlmOutputValidationError', 'LogValidationError',
  'MemoryRouterAugmentedTableMissingError', 'MemoryRouterBudgetExceededError', 'MemoryRouterDispatcherMissingError',
  'MemoryRouterUnknownCategoryError', 'MissingStageError', 'ModelRouterError', 'NoCapacityError',
  'NoVoiceProvidersAvailableError', 'NotFoundError', 'ObjectGenerationError', 'OllamaProviderError',
  'OpenAIProviderError', 'OpenRouterProviderError', 'PageRowChangedError', 'PromptEngineError', 'ProvenanceViolationError', 'ProviderError',
  'ProviderInitializationError', 'QuickJSUnavailableError', 'ReadRouterBudgetExceededError',
  'ReadRouterDispatcherMissingError', 'ReadRouterUnknownIntentError', 'ReaderRouterUnknownCategoryError',
  'ReaderRouterUnknownPresetError', 'RecallOptionError', 'ReferenceHttpError', 'RequestyProviderError',
  'SandboxError', 'ScannedDocumentError', 'SealedSecretError', 'SegmentationModeNotSupportedError',
  'SegmentationProviderError', 'SkillExportRefusedError', 'SoulLoadError', 'SpendMeterUnavailableError',
  'StepExpiredError', 'StreamError', 'StructuredOutputError', 'StructuredReplyConfigError',
  'SttConnectionAuthorizationError', 'ToolTimeoutError', 'TraceMovedError', 'TranscriptReadError',
  'TranslationProviderError', 'UnpricedModelError', 'UnreadableAudioError', 'UnsupportedAudioFormatError',
  'UnsupportedIngestStrategyError', 'UnsupportedMemoryBackendError', 'UnsupportedReadStrategyError',
  'ValidationError', 'VoiceInterruptError', 'VoicePipelineError',
  'CapabilityRefusal', 'DeepLHttpError', 'ImageToVideoNotSupportedError', 'LaunchDeadlineError', 'LaunchEndedError',
  'MusicNotSupportedError', 'OAuthGrantRefused', 'PiecesFailed', 'ProviderStreamError', 'RefusedTraceName',
  'SFXNotSupportedError', 'VoiceStoreConflict',
]);

/** Every literal code the library's own source gives an error, in upper or lower case, and Node.js's network codes. */
export const LISTED_ERROR_CODES: ReadonlySet<string> = closedList([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ABORT_ERR',
  'GUARDRAIL_BLOCKED', 'GUARDRAIL_HELD', 'GUARDRAIL_UNAVAILABLE',
  'AGENT_CONFIG_INVALID', 'AGENT_NOT_INITIALIZED', 'ALL_KEYS_FAILED', 'ALREADY_EXISTS', 'API_CLIENT_ERROR',
  'API_ERROR', 'API_KEY_MISSING', 'API_REQUEST_FAILED', 'API_RESPONSE_MALFORMED', 'API_SERVER_ERROR',
  'AUTH_ACCESS_DENIED', 'AUTH_AUTHENTICATION_REQUIRED', 'AUTH_PERMISSION_DENIED', 'AUTH_SUBSCRIPTION_ERROR',
  'AUTONOMY_ACTION_BLOCKED', 'AUTONOMY_CONFIG_EDIT_BLOCKED', 'AUTONOMY_HUMAN_PROMPT_BLOCKED',
  'AUTONOMY_TOOL_CHANGE_BLOCKED', 'BILLING_ALLOWANCE_EXHAUSTED', 'BINARY_NOT_FOUND', 'CAPABILITY_MANIFEST_REFUSED',
  'CODEC_NOT_FOUND', 'CONFIG_ERROR', 'CONTEXT_TOO_LONG', 'CONTEXT_UPDATE_FAILED_TOOL_RESULT',
  'CONTEXT_WINDOW_EXCEEDED', 'CRASHED', 'DEPENDENCY_MISSING_LLMPROVIDER', 'DEPENDENCY_MISSING_PROMPTENGINE',
  'DOCUMENT_READ_TIMEOUT', 'DOCUMENT_TOO_COMPLEX', 'DOCUMENT_TOO_LARGE', 'EMBEDDINGS_NOT_SUPPORTED',
  'EMBEDDING_FAILED', 'EMBEDDING_NO_INPUT', 'EMPTY_TOOL_CALL_REQUEST', 'ENGINE_NOT_INITIALIZED',
  'FACTORY_NOT_INITIALIZED', 'GET_AGENT_CLASS_NOT_REGISTERED', 'GET_AGENT_CONSTRUCTION_FAILED',
  'GET_AGENT_INITIALIZATION_FAILED', 'GET_AGENT_MISSING_DEPS', 'GET_AGENT_NO_ID', 'GET_AGENT_NO_PROVIDER_ID',
  'GET_AGENT_PROVIDER_RESOLUTION_FAILED', 'GET_MODEL_INFO_FAILED', 'GMI_CONTEXT_ERROR', 'GMI_FEEDBACK_ERROR',
  'GMI_INITIALIZATION_ERROR', 'GMI_PERSONA_LOAD_ERROR', 'GMI_PERSONA_NOT_FOUND', 'GMI_PROCESSING_ERROR',
  'GMI_SHUTDOWN_ERROR', 'GMI_STRUCTURED_OUTPUT_INVALID', 'IMAGE_URL_NOT_SUPPORTED', 'INITIALIZATION_FAILED',
  'INIT_CONFIG_MISSING', 'INIT_DEFAULTS_MISSING', 'INIT_FAILED_MISSING_API_KEY', 'INIT_FAILED_MISSING_BASEURL',
  'INIT_NO_CLASSMAP', 'INIT_NO_CONFIGS', 'INIT_PROVIDER_MANAGER_MISSING', 'INIT_RULES_MISSING',
  'INTERNAL_AGENT_ERROR_EXPLAINED', 'INTERNAL_ERROR_EXPLANATION_FAILED', 'INVALID_AGENT_WORKSPACE_ID',
  'INVALID_CONFIG_PARAM', 'INVALID_RESPONSE', 'INVALID_TEMPLATE_FUNCTION', 'INVALID_TEMPLATE_NAME',
  'INVALID_TOOL_NAME', 'INVALID_WIKI_PAGE_ID', 'LANGUAGE_DETECTION_UNSUPPORTED', 'LIST_CONFIGS_CLONE_FAILED',
  'LIST_MODELS_FAILED', 'LLM_PROVIDER_ERROR', 'LLM_PROVIDER_EXECUTION_ERROR', 'LLM_PROVIDER_RESPONSE_ERROR',
  'LLM_PROVIDER_UNAVAILABLE', 'LLM_RESPONSE_NO_CHOICE', 'MAX_RETRIES_REACHED', 'MODEL_ID_MISSING', 'NETWORK_ERROR',
  'NOT_AUTHENTICATED', 'NOT_FOUND', 'NOT_INITIALIZED', 'POOL_AGENT_INIT_NO_FACTORY', 'POOL_AGENT_INVALID_CONFIG',
  'POOL_AGENT_MISSING_FACTORY', 'POOL_AGENT_MISSING_PROVIDER_MANAGER', 'POOL_DELEGATION_NO_AGENT_SELECTED',
  'POOL_ROUTED_AGENT_NOT_FOUND', 'POOL_ROUTING_LLM_ERROR', 'POOL_SELF_TOOL_RESULT_LLM_ERROR',
  'POOL_STRATEGY_EXECUTION_FAILED', 'POOL_SYNTHESIS_LLM_ERROR', 'POOL_TOOL_RESULT_CONTEXT_ERROR',
  'POOL_UNKNOWN_STRATEGY', 'PROMPT_CONSTRUCTION_ERROR', 'PROMPT_VALIDATION_ERROR', 'PROVENANCE_VIOLATION',
  'PROVIDER_ERROR', 'PROVIDER_NOT_FOUND', 'PROVIDER_NOT_INITIALIZED', 'RAG_INGESTION_FAILED', 'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED', 'REGISTER_INVALID_AGENT_TYPE', 'REGISTER_INVALID_CONSTRUCTOR', 'REQUEST_ABORTED',
  'REQUEST_HARD_TIMEOUT', 'REQUEST_TIMEOUT', 'RESPONSES_FAILED', 'RESPONSES_STREAM_ERROR',
  'RESPONSES_UNMAPPABLE_CONTENT', 'SCANNED_DOCUMENT', 'SCHEMA_PARSE_FAILED', 'SEALED_MUTATION_BLOCKED',
  'SKILL_EXPORT_REFUSED', 'SOUL_LOAD_FAILED', 'SPAWN_FAILED', 'SPEND_METER_UNAVAILABLE', 'STREAM_BODY_NULL',
  'STREAM_CHUNK_MALFORMED', 'STREAM_CONNECTION_FAILED', 'STREAM_ERROR_EVENT', 'STREAM_IDLE_TIMEOUT',
  'STREAM_INCOMPLETE', 'STREAM_PARSING_ERROR', 'STREAM_PROCESSING_ERROR', 'STRUCTURED_REPLY_CONFIG',
  'SUB_AGENT_DELEGATION_FAILED', 'SUB_AGENT_FAILURE_IN_MOE', 'SUB_AGENT_LOAD_FAILED',
  'SUB_AGENT_TURN_PROCESSING_FAILED', 'SYS_ALREADY_EXISTS', 'SYS_CONFIGURATION_ERROR', 'SYS_CONFIG_ERROR',
  'SYS_DATABASE_ERROR', 'SYS_DEPENDENCY_ERROR', 'SYS_GUARDRAIL_REQUIRED_MISSING', 'SYS_INITIALIZATION_FAILED',
  'SYS_INTERNAL_ERROR', 'SYS_INTERNAL_SERVER_ERROR', 'SYS_INVALID_ARGUMENT', 'SYS_INVALID_STATE',
  'SYS_METHOD_NOT_SUPPORTED', 'SYS_MISSING_DATA', 'SYS_MISSING_DEPENDENCY', 'SYS_NOT_FOUND', 'SYS_NOT_IMPLEMENTED',
  'SYS_NOT_INITIALIZED', 'SYS_NOT_SUPPORTED', 'SYS_PARSING_ERROR', 'SYS_PROCESSING_ERROR', 'SYS_RATE_LIMIT_EXCEEDED',
  'SYS_RESOURCE_ALREADY_EXISTS', 'SYS_RESOURCE_NOT_FOUND', 'SYS_SERVICE_UNAVAILABLE', 'SYS_SPEND_METER_UNAVAILABLE',
  'SYS_STREAM_ERROR', 'SYS_TIMEOUT', 'SYS_VALIDATION_ERROR', 'TEMPLATE_NOT_FOUND', 'TIMEOUT', 'TOOL_ERROR',
  'TOOL_EXECUTION_FAILED', 'TOOL_NOT_FOUND', 'TOOL_PARSE_FAILED', 'TOOL_RESULT_LLM_PROCESSING_FAILED',
  'TRANSLATION_EMPTY_OUTPUT', 'TRANSLATION_INCOMPLETE', 'TRANSLATION_REQUEST_FAILED', 'TRANSLATION_TIMEOUT',
  'TRANSLATION_TRUNCATED', 'UNHANDLED_CONSTRUCTION_ERROR', 'UNKNOWN', 'VALIDATION_ERROR', 'VERSION_OUTDATED',
  'IMAGE_LOCAL_FILE_REFUSED', 'IMAGE_URL_REFUSED',
  // The lower-case codes of the library's own classes: a refused or cut capability call, a ceiling the engine cannot
  // build, a content key, a Deepgram usage read and a segmentation request, and the code a provider error is given
  // when a vendor's filter stopped the request or the reply.
  'aborted', 'audit_needs_storage', 'audit_unavailable', 'body_limit', 'call_ended', 'call_quota_exceeded', 'conflict',
  'content_filter', 'contract', 'cut_in_flight', 'duplicate', 'file_exists', 'file_left', 'file_too_large', 'host_not_allowed', 'http',
  'incomplete', 'invalid', 'invalid_approval', 'invalid_audit', 'invalid_bound', 'invalid_domain', 'invalid_headers',
  'invalid_mode', 'invalid_path', 'invalid_request', 'invalid_url', 'method_not_allowed', 'no_such_directory',
  'no_such_file', 'not_a_file', 'page_limit', 'path_not_allowed', 'policy_denied', 'protected_path', 'provider_failed',
  'request_too_large', 'response_too_large', 'revoked', 'root_not_absolute', 'scheme_not_allowed', 'sealed', 'shape',
  'timed_out', 'timeout', 'too_many_redirects', 'transport', 'unavailable', 'unknown_capability', 'unstable',
  'unsupported_body', 'unsupported_data',
]);
