import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPoolAgent } from '../AgentPoolAgent.js';
import { AgentPoolStrategy } from '../AgentPoolConfig.js';
import { ConversationContext } from '../../../core/conversation/ConversationContext.js';

const sentinel = 'sentinel-words-7731';
afterEach(() => vi.restoreAllMocks());

describe('AgentPoolAgent routing diagnostics', () => {
  it.each([
    ['NONE', 'none'],
    [sentinel, 'unknown_agent'],
  ])('logs routing outcome %s without input or model text', async (reply, outcome) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent: AgentPoolAgent = Object.assign(Object.create(AgentPoolAgent.prototype), {
      name: 'pool-1', isInitialized: true,
      poolConfig: { strategy: AgentPoolStrategy.UNIFIED_PERSONA_ROUTING, subAgentIds: ['agent-1'] },
      subAgents: new Map([['agent-1', { id: 'agent-1', name: 'specialist', description: 'Handles requests' }]]),
      callLLM: vi.fn().mockResolvedValue({ choices: [{ message: { content: reply } }] }),
    });
    const result = await agent.processTurn(sentinel, new ConversationContext('conversation-1'));
    expect(result.responseText).toContain('rephrase');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toEqual({ candidateNames: ['specialist'], inputLength: sentinel.length, outcome });
    expect(warn.mock.calls[1][1]).toEqual({ candidateNames: ['specialist'], inputLength: sentinel.length, outcome: 'no_agent_selected' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
  });
});
