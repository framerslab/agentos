/**
 * @fileoverview Emergent Capability Engine — public API barrel.
 * @module @framers/agentos/emergent
 *
 * Re-exports all types, interfaces, and constants from the emergent module.
 * Import from this barrel to avoid deep path coupling to internal files.
 *
 * @example
 * ```ts
 * import type { EmergentTool, ForgeToolRequest, DEFAULT_EMERGENT_CONFIG } from '@framers/agentos/emergent';
 * ```
 */

export * from './types.js';
export { type SelfImprovementConfig, DEFAULT_SELF_IMPROVEMENT_CONFIG } from './SelfImprovementConfig.js';
export { ComposableToolBuilder } from './ComposableToolBuilder.js';
export { SandboxedToolForge } from './SandboxedToolForge.js';
export type { SandboxedToolForgeConfig } from './SandboxedToolForge.js';
export { CAPABILITY_NAMES, CAPABILITY_ALIASES, normalizeAllowlist, toSandboxApis } from './capabilities.js';
export {
  parsePersistedSource,
  inferRequestFromCode,
  requestFromImplementation,
  parseStoredRequest,
} from './persisted-source.js';
export type { PersistedSource } from './persisted-source.js';
export { EmergentToolRegistry } from './EmergentToolRegistry.js';
export type {
  IStorageAdapter as EmergentRegistryStorageAdapter,
  AuditEntry,
} from './EmergentToolRegistry.js';
export {
  EMERGENT_TOOL_PACKAGE_SCHEMA_VERSION,
  buildEmergentToolPackage,
  serializeEmergentToolPackage,
  parseEmergentToolPackage,
  materializeEmergentToolFromPackage,
} from './ToolPackage.js';
export type {
  PortableSandboxImplementation,
  PortableToolImplementation,
  EmergentToolPackageManifest,
  BuildEmergentToolPackageOptions,
  MaterializeEmergentToolFromPackageOptions,
} from './ToolPackage.js';
export { EmergentJudge } from './EmergentJudge.js';
export type { ToolCandidate, EmergentJudgeConfig } from './EmergentJudge.js';
export { EmergentCapabilityEngine } from './EmergentCapabilityEngine.js';
export type { EmergentCapabilityEngineDeps } from './EmergentCapabilityEngine.js';
export { ForgeToolMetaTool } from './ForgeToolMetaTool.js';
export type { ForgeToolInput } from './ForgeToolMetaTool.js';
export {
  exportToolAsSkill,
  buildCapabilityYaml,
  writeSkillFile,
  exportToolAsSkillPack,
} from './SkillExporter.js';
export { AdaptPersonalityTool } from './AdaptPersonalityTool.js';
export { ManageSkillsTool } from './ManageSkillsTool.js';
export { CreateWorkflowTool } from './CreateWorkflowTool.js';
export { SelfEvaluateTool } from './SelfEvaluateTool.js';
export { PersonalityMutationStore } from './PersonalityMutationStore.js';
export type { PersonalityMutation, RecordMutationInput, DecayResult } from './PersonalityMutationStore.js';
export type { SelfImprovementToolDeps } from './EmergentCapabilityEngine.js';

// Forge observability — instrumentation for consumers that want live
// visibility into forge health (rejection-reason histogram, shape-check
// pre-validator, schema inference from testCases, capture wrapper,
// aggregator).
export {
  classifyForgeRejection,
  type ForgeRejectionCategory,
} from './ForgeRejectionClassifier.js';
export {
  validateForgeShape,
  type ForgeShapeRequest,
} from './ForgeShapeValidator.js';
export {
  inferSchemaFromTestCases,
  type ForgeSchemaInferenceRequest,
} from './ForgeSchemaInference.js';
export {
  wrapForgeTool,
  type CapturedForge,
  type ForgeLogEvent,
  type WrapForgeToolOptions,
} from './wrapForgeTool.js';
export {
  ForgeStatsAggregator,
  emptyForgeStats,
  type ForgeStats,
} from './ForgeStatsAggregator.js';

// Emergent agent synthesis — used by the hierarchical strategy when
// emergent.enabled is true to spawn new specialist sub-agents at runtime.
export { EmergentAgentForge } from './EmergentAgentForge.js';
export type {
  AgentSpec,
  ForgeDefaults,
  ForgeResult,
} from './EmergentAgentForge.js';
export { EmergentAgentJudge } from './EmergentAgentJudge.js';
export type {
  EmergentAgentJudgeConfig,
  AgentVerdict,
  JudgeGenerateText,
} from './EmergentAgentJudge.js';
