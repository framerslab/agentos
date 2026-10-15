/**
 * @file AgentWorkspace.test.ts
 * An agent's workspace folder is named after its id: the cleaned id is held to the rule every name built from data
 * meets, and the folder lies inside the base folder, or the id is refused with a typed error.
 */
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InvalidAgentWorkspaceIdError,
  resolveAgentWorkspaceDir,
  sanitizeAgentWorkspaceId,
  type AgentWorkspaceIdProblem,
} from '../AgentWorkspace.js';

const BASE = path.resolve('/srv/agentos/agents');

/** The error `run` throws, or undefined when it returns. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('an agent workspace folder is named only inside the base folder', () => {
  const accepted: Array<[string, string, string]> = [
    ['a normal id', 'seed_42', 'seed_42'],
    ['a UUID', '0f8fad5b-d9cb-469f-a165-70867728950e', '0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['parent folders between names, which become one name', 'a/../b', 'a-..-b'],
    ['a backslash between names', 'a\\..\\b', 'a-..-b'],
    ['dots inside a name', 'gpt-4.1-agent', 'gpt-4.1-agent'],
    ['an id that cleans to nothing', '!!!', 'agent'],
    ['an empty id', '', 'agent'],
  ];

  it.each(accepted)('resolves %s to its own folder inside the base folder', (_label, agentId, folder) => {
    expect(sanitizeAgentWorkspaceId(agentId)).toBe(folder);
    expect(resolveAgentWorkspaceDir(agentId, BASE)).toBe(path.join(BASE, folder));
  });

  const refused: Array<[string, string, AgentWorkspaceIdProblem]> = [
    ['the parent folder', '..', 'dot'],
    ['the base folder itself', '.', 'dot'],
    ['three dots', '...', 'dot'],
    ['the parent folder after a slash', '/..', 'dot'],
    ['the parent folder after a backslash', '\\..', 'dot'],
    ['the parent folder within spaces', ' .. ', 'dot'],
    ['the parent folder within dashes', '-..-', 'dot'],
    ['a hidden name', '.ssh', 'dot'],
    ['a trailing dot, which Windows drops', 'agent.', 'edge'],
    ['an id whose first 80 characters end with a dot', `${'a'.repeat(79)}.b`, 'edge'],
  ];

  it.each(refused)('refuses %s with a typed error, and names no folder', (_label, agentId, problem) => {
    for (const run of [() => sanitizeAgentWorkspaceId(agentId), () => resolveAgentWorkspaceDir(agentId, BASE)]) {
      const err = thrownBy(run);
      expect(err).toBeInstanceOf(InvalidAgentWorkspaceIdError);
      expect(err).toMatchObject({ name: 'InvalidAgentWorkspaceIdError', code: 'INVALID_AGENT_WORKSPACE_ID', problem });
    }
  });

  it("names the refused id in the error's message, escaped", () => {
    expect(thrownBy(() => resolveAgentWorkspaceDir('/..', BASE))).toMatchObject({
      message: 'agent workspace id "/.." refused: a workspace folder name does not start with a dot',
    });
  });
});
