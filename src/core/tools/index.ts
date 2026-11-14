/**
 * Tool interfaces, orchestrator, executor, and permission helpers.
 *
 * @module tools
 */

export {
  type ITool,
  type JSONSchemaObject,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from './ITool.js';

export {
  type IToolOrchestrator,
  type ToolDefinitionForLLM,
} from './IToolOrchestrator.js';

export { ToolExecutor } from './ToolExecutor.js';
export type { ToolExecutionRequestDetails } from './ToolExecutor.js';

export { ToolOrchestrator } from './ToolOrchestrator.js';
export type { ToolOrchestratorConfig } from '../config/ToolOrchestratorConfig.js';

export {
  type IToolPermissionManager,
  type PermissionCheckContext,
  type PermissionCheckResult,
  type ToolPermissionManagerConfig,
} from './permissions/IToolPermissionManager.js';
export { ToolPermissionManager } from './permissions/ToolPermissionManager.js';

export { createCurrentDateTimeTool } from './builtins/currentDateTime.js';
