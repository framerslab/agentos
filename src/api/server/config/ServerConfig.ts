// agentos/server/config/ServerConfig.ts
export interface AgentOSServerConfig {
  port?: number;
  host?: string;
  apiKey?: string;
  enableCors?: boolean;
  corsOrigin?: string | string[];
  maxRequestSize?: string;
  /**
   * When true (default), requests that miss the built-in routes are offered to
   * extension-contributed EXTENSION_KIND_HTTP_HANDLER payloads (registration
   * order, first-true wins) before the 404 fallthrough. Kill switch for hosts
   * that must preserve the legacy route surface exactly.
   */
  dispatchExtensionHandlers?: boolean;
}

export function createAgentOSConfig(overrides?: Partial<AgentOSServerConfig>): AgentOSServerConfig {
  return {
    port: 3001,
    host: 'localhost',
    enableCors: true,
    corsOrigin: '*',
    maxRequestSize: '10mb',
    dispatchExtensionHandlers: true,
    ...overrides
  };
}
