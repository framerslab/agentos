/**
 * @file index.ts
 * @description Barrel export for the orchestration compiler sub-package.
 *
 * Exposes schema lowering utilities and the static graph validator used during
 * the compilation pipeline that transforms author-facing graph/workflow/mission
 * definitions into `CompiledExecutionGraph` IR objects.
 */

export { lowerZodToJsonSchema } from './SchemaLowering.js';
export type { LowerZodOptions } from './SchemaLowering.js';
export { GraphValidator } from './Validator.js';
export type { ValidationResult } from './Validator.js';
export { GraphCompiler } from './GraphCompiler.js';
export type { GraphCompilerInput } from './GraphCompiler.js';
export { MissionCompiler } from './MissionCompiler.js';
export type { MissionConfig, SimplePlan } from './MissionCompiler.js';
