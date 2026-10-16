/**
 * @fileoverview The name rule for a forged tool, and the folder a tool is exported to.
 *
 * A model names the tool it forges, and the skill exporter names a folder after the tool. The forge holds the name
 * to the rule every name built from data meets (`pathNameProblem` in `core/utils/pathName`) and to an identifier
 * pattern. The exporter checks the name against the first rule again and writes only inside its output folder, so
 * a tool the forge did not check, such as one loaded from a stored row or one a host builds itself, is checked as
 * well.
 *
 * @module agentos/emergent/ToolName
 */

import * as path from 'node:path';
import {
  MAX_PATH_NAME_BYTES,
  describeRefusedName,
  pathNameProblem,
  resolveInsideFolder,
  type PathNameProblem,
} from '../../core/utils/pathName.js';

/**
 * The identifier pattern for a name a model gives: a forged tool's name, and a synthesised agent's role
 * (`EmergentAgentForge`), which names its `delegate_to_<role>` tool. An ASCII letter, then ASCII letters, digits,
 * underscores and hyphens.
 */
export const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Why a tool's name was refused:
 * - `'type'`: the name is not a string.
 * - `'empty'`, `'character'`, `'dot'`, `'edge'` and `'length'`: the name breaks the rule every name built from
 *   data meets (`PathNameProblem` in `core/utils/pathName`). It is empty; it holds a slash, a backslash, a colon,
 *   one of `"`, `*`, `<`, `>`, `?` and `|`, or a control character; it starts with a dot; it starts or ends with a
 *   space, or ends with a dot; or it holds more than 200 bytes in UTF-8.
 * - `'identifier'`: the forge's own rule. The name is not an ASCII letter followed by ASCII letters, digits,
 *   underscores and hyphens ({@link IDENTIFIER_PATTERN}).
 * - `'outside'`: the tool's folder would not lie inside the output folder.
 */
export type ToolNameProblem = 'type' | PathNameProblem | 'identifier' | 'outside';

/** The part of the rule each problem breaks, as the error message words it. */
const RULE_BROKEN: Record<ToolNameProblem, string> = {
  type: 'a tool name is a string',
  empty: 'a tool name is not empty',
  character: 'a tool name holds no slash, no backslash, no colon, none of " * < > ? | and no control character',
  dot: 'a tool name does not start with a dot',
  edge: 'a tool name does not start or end with a space, or end with a dot',
  length: `a tool name is at most ${MAX_PATH_NAME_BYTES} bytes in UTF-8`,
  identifier: 'a forged tool name is an ASCII letter followed by ASCII letters, digits, underscores and hyphens',
  outside: "the tool's folder would be outside the output folder",
};

/** Reported or thrown when a tool's name is refused. Nothing is forged or written for the refused name. */
export class InvalidToolNameError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'INVALID_TOOL_NAME';

  /**
   * @param problem - The part of the name rule the name breaks.
   * @param name - The refused name. The message shows at most its first 64 characters, escaped.
   */
  constructor(
    readonly problem: ToolNameProblem,
    name: unknown,
  ) {
    super(`tool name ${describeRefusedName(name)} refused: ${RULE_BROKEN[problem]}`);
    this.name = 'InvalidToolNameError';
  }
}

/**
 * The part of the forge's name rule `name` breaks, or null when a tool may be forged under it. The name is held to
 * the rule every name built from data meets, then to {@link IDENTIFIER_PATTERN}. A name the forge accepts is
 * therefore one the skill exporter accepts.
 *
 * @param name - The name a forge request gives the tool.
 */
export function forgedToolNameProblem(name: unknown): ToolNameProblem | null {
  if (typeof name !== 'string') return 'type';
  return pathNameProblem(name) ?? (IDENTIFIER_PATTERN.test(name) ? null : 'identifier');
}

/**
 * The folder that a tool named `name` is exported to under `outputDir`, resolved. The name is held to the rule
 * every name built from data meets. Then the resolved folder must lie inside the resolved output folder, a second
 * guard should a platform's path rules ever place the folder of an accepted name elsewhere.
 *
 * @param outputDir - The folder the tool's own folder is made in.
 * @param name - The tool's name.
 * @param paths - The path functions to resolve with: the platform's by default, `path.win32` or `path.posix` to pick one.
 * @returns The absolute path of the tool's folder.
 * @throws InvalidToolNameError when the name is refused or its folder would be outside `outputDir`.
 */
export function resolveToolFolder(
  outputDir: string,
  name: unknown,
  paths: Pick<path.PlatformPath, 'resolve' | 'sep'> = path,
): string {
  if (typeof name !== 'string') throw new InvalidToolNameError('type', name);
  const problem = pathNameProblem(name);
  if (problem) throw new InvalidToolNameError(problem, name);
  const folder = resolveInsideFolder(outputDir, [name], paths);
  if (folder === null) throw new InvalidToolNameError('outside', name);
  return folder;
}
