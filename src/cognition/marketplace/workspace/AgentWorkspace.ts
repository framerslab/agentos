/**
 * @fileoverview Per-agent workspace directory helpers.
 *
 * Agents that are allowed to perform filesystem operations should do so
 * inside an isolated per-agent workspace directory (a "sandbox folder"),
 * rather than arbitrary locations on the host machine.
 *
 * This module provides small utilities for:
 * - normalizing agent IDs into safe folder names
 * - resolving the base directory for workspaces
 * - resolving the full workspace directory for a given agent
 *
 * An agent's folder is named after its id, so the cleaned id is held to the
 * rule every name built from data meets (`pathNameProblem` in
 * `core/utils/pathName`), and the folder must resolve inside the base folder.
 * An id that fails either check is refused with an
 * `InvalidAgentWorkspaceIdError`.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_PATH_NAME_BYTES,
  describeRefusedName,
  pathNameProblem,
  resolveInsideFolder,
  type PathNameProblem,
} from '../../../core/utils/pathName.js';

/**
 * Why an agent's workspace id was refused:
 * - `'dot'`: the cleaned id starts with a dot, so it is `.`, `..` or a hidden
 *   name. `.` would name the base folder itself, which holds every agent's
 *   workspace, and `..` the folder above it.
 * - `'edge'`: the cleaned id ends with a dot. Windows drops it from a name, so
 *   the folder would be another agent's (`agent.` is `agent` there).
 * - `'empty'`, `'character'` and `'length'`: the rest of the rule every name
 *   built from data meets. The cleaning leaves none of them, so they are
 *   reported only should it ever change.
 * - `'outside'`: the folder would not lie inside the base folder.
 */
export type AgentWorkspaceIdProblem = PathNameProblem | 'outside';

/** The part of the rule each problem breaks, as the error message words it. */
const RULE_BROKEN: Record<AgentWorkspaceIdProblem, string> = {
  empty: 'a workspace folder name is not empty',
  character: 'a workspace folder name holds no slash, no backslash, no colon, none of " * < > ? | and no control character',
  dot: 'a workspace folder name does not start with a dot',
  edge: 'a workspace folder name does not start or end with a space, or end with a dot',
  length: `a workspace folder name is at most ${MAX_PATH_NAME_BYTES} bytes in UTF-8`,
  outside: "the agent's workspace folder would be outside the base folder",
};

/**
 * Thrown by {@link sanitizeAgentWorkspaceId} and {@link resolveAgentWorkspaceDir}
 * when an agent id gives no safe workspace folder. No folder is named for it.
 */
export class InvalidAgentWorkspaceIdError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'INVALID_AGENT_WORKSPACE_ID';

  /**
   * @param problem - The part of the rule the cleaned id breaks.
   * @param agentId - The id as given. The message shows at most its first 64 characters, escaped.
   */
  constructor(
    readonly problem: AgentWorkspaceIdProblem,
    agentId: unknown,
  ) {
    super(`agent workspace id ${describeRefusedName(agentId)} refused: ${RULE_BROKEN[problem]}`);
    this.name = 'InvalidAgentWorkspaceIdError';
  }
}

/**
 * Sanitize an arbitrary agent identifier into a safe folder name.
 *
 * - trims whitespace
 * - replaces slashes with '-'
 * - collapses non-alphanumerics to '-'
 * - limits length to 80 chars
 * - names an id that cleans to nothing 'agent'
 *
 * The cleaned name keeps dots, so it is then held to the rule every name
 * built from data meets: an id whose cleaned name starts or ends with a dot,
 * such as `.`, `..`, `/..` or ` .. `, or whose first 80 characters end with
 * one, is refused. Dots inside a name stay, so `a/../b` cleans to `a-..-b`,
 * one folder name.
 *
 * @param raw - The agent's id.
 * @returns The folder name.
 * @throws InvalidAgentWorkspaceIdError when the cleaned name breaks the rule.
 */
export function sanitizeAgentWorkspaceId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  const name = cleaned || 'agent';
  const problem = pathNameProblem(name);
  if (problem) throw new InvalidAgentWorkspaceIdError(problem, raw);
  return name;
}

/**
 * Resolve the base directory used for per-agent workspace folders.
 *
 * Override via env vars:
 * - WUNDERLAND_WORKSPACES_DIR (preferred for Wunderland runtimes)
 * - AGENTOS_WORKSPACES_DIR
 * - AGENTOS_AGENT_WORKSPACES_DIR
 */
export function resolveAgentWorkspaceBaseDir(): string {
  const env =
    process.env['WUNDERLAND_WORKSPACES_DIR'] ||
    process.env['AGENTOS_WORKSPACES_DIR'] ||
    process.env['AGENTOS_AGENT_WORKSPACES_DIR'];

  if (typeof env === 'string' && env.trim()) {
    return path.resolve(env.trim());
  }

  // Default: per-agent folders under a Documents-like directory.
  return path.join(os.homedir(), 'Documents', 'AgentOS', 'agents');
}

/**
 * Resolve the full workspace directory for an agent: the folder named by
 * {@link sanitizeAgentWorkspaceId}, which must resolve inside the base
 * folder, a second guard should a platform's path rules ever place the
 * folder of an accepted name elsewhere.
 *
 * @param agentId - The agent's id.
 * @param baseDir - The folder that holds every agent's workspace; {@link resolveAgentWorkspaceBaseDir} by default.
 * @returns The absolute path of the agent's workspace folder, inside the base folder.
 * @throws InvalidAgentWorkspaceIdError when the id gives no safe folder name, or its folder would be outside the base folder.
 */
export function resolveAgentWorkspaceDir(agentId: string, baseDir?: string): string {
  const base = typeof baseDir === 'string' && baseDir.trim()
    ? path.resolve(baseDir.trim())
    : resolveAgentWorkspaceBaseDir();
  const safeId = sanitizeAgentWorkspaceId(agentId);
  const dir = resolveInsideFolder(base, [safeId]);
  if (dir === null) throw new InvalidAgentWorkspaceIdError('outside', agentId);
  return dir;
}
