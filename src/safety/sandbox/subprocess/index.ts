/**
 * @fileoverview Core subprocess management — first-class AgentOS capability
 * for spawning and managing external CLI binaries.
 *
 * @module agentos/sandbox/subprocess
 */

export { CLISubprocessBridge } from './CLISubprocessBridge';
export { CLIRegistry, WELL_KNOWN_CLIS } from './CLIRegistry';
export { CLISubprocessError, CLI_ERROR } from './errors';
export type {
  BridgeOptions,
  BridgeResult,
  StreamEvent,
  StreamParseContext,
  OutputFormat,
  InstallCheckResult,
  CLIDescriptor,
  CLIScanResult,
} from './types';
