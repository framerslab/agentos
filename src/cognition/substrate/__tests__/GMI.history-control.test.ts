/**
 * @fileoverview The host can replace or clear a GMI's conversation history.
 * Checked through the messages the provider receives: after replaceHistory
 * the next request carries exactly the given messages before the new user
 * message, an empty array is authoritative, and a replaced or cleared fact
 * never reaches a later request.
 */
import { describe, expect, it, vi } from 'vitest';
import { createConversationMessage, MessageRole } from '../../../core/conversation/ConversationMessage';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ReasoningEntryType } from '../IGMI';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

const nonSystem = (messages: Array<{ role: string; content: unknown }>) => messages.filter((m) => m.role !== 'system').map((m) => m.content);

describe('GMI history control', () => {
  it('replaceHistory makes the given messages the whole history; an empty array and clearHistory empty it', async () => {
    const { provider, received } = scriptedProvider([textReply('Noted.'), textReply('It is heron.'), textReply('Rome.'), textReply('Hi.'), textReply('Again.')]);
    const { gmi } = await createScriptedGmi({ provider });

    await runTurn(gmi, textTurn('t1', 'The code word is heron.'));
    await runTurn(gmi, textTurn('t2', 'What is the code word?'));
    // Left alone, the history carries the fact into the next request.
    expect(nonSystem(received[1])).toEqual(['The code word is heron.', 'Noted.', 'What is the code word?']);

    gmi.replaceHistory([
      createConversationMessage(MessageRole.USER, 'What is the capital of France?'),
      createConversationMessage(MessageRole.ASSISTANT, 'Paris.'),
    ]);
    await runTurn(gmi, textTurn('t3', 'And of Italy?'));
    expect(nonSystem(received[2])).toEqual(['What is the capital of France?', 'Paris.', 'And of Italy?']);

    gmi.replaceHistory([]);
    await runTurn(gmi, textTurn('t4', 'Hello.'));
    expect(nonSystem(received[3])).toEqual(['Hello.']);

    gmi.clearHistory();
    await runTurn(gmi, textTurn('t5', 'Again.'));
    expect(nonSystem(received[4])).toEqual(['Again.']);
    expect(JSON.stringify(received.slice(2))).not.toContain('heron');
  });

  it('replacing or clearing the history also drops what the GMI recorded about the turns it removes: their excerpts leave the trace, the sentiment history and the evidence a metaprompt sends', async () => {
    const { provider } = scriptedProvider([
      toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'heron' } }]),
      textReply('Noted.'),
      textReply('Hello.'),
    ]);
    // Every metaprompt call: the prompt it sent to the model.
    const evidence: string[] = [];
    Object.assign(provider, {
      generateCompletion: async (_modelId: string, messages: Array<{ content: unknown }>) => {
        evidence.push(String(messages[0].content));
        return { id: 'metaprompt', object: 'chat.completion', created: 0, modelId: 'scripted-model', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finishReason: 'stop' }] };
      },
    });
    const utilityAI = {
      analyzeSentiment: async () => ({ score: 0, polarity: 'neutral', intensity: 0 }),
      parseJsonSafe: async () => ({}),
    } as unknown as IUtilityAI;
    const { gmi } = await createScriptedGmi({
      provider,
      toolResults: { call_a: { toolCallId: 'call_a', toolName: 'lookup', output: { found: 'egret' } } },
      // Sentiment tracking on, and a reflection metaprompt that runs after every user turn.
      persona: {
        sentimentTracking: { enabled: true },
        metaPrompts: [{ id: 'gmi_self_trait_adjustment', promptTemplate: 'Evidence: {{evidence}}', trigger: { type: 'turn_interval', intervalTurns: 1 } }],
      } as never,
      config: { utilityAI },
    });
    const recorded = async (): Promise<string> => JSON.stringify([gmi.getReasoningTrace(), await gmi.getWorkingMemorySnapshot()]);

    await runTurn(gmi, textTurn('t1', 'I am confused: the code word is heron.'));
    await vi.waitFor(() => expect(evidence).toHaveLength(1));
    // While the turn is in the history, the trace, the sentiment history and the metaprompt's evidence hold excerpts of it.
    expect(await recorded()).toContain('heron');
    expect(await recorded()).toContain('egret');
    expect(evidence[0]).toContain('heron');

    gmi.clearHistory();
    await runTurn(gmi, textTurn('t2', 'Hello there.'));
    await vi.waitFor(() => expect(evidence).toHaveLength(2));
    expect(await recorded()).not.toContain('heron');
    expect(await recorded()).not.toContain('egret');
    expect(evidence[1]).not.toContain('heron');
    // The entries stay, without their details: the trace still shows that a tool ran.
    expect(gmi.getReasoningTrace().entries.filter((entry) => entry.type === ReasoningEntryType.TOOL_EXECUTION_RESULT)).toHaveLength(1);

    // A history that still holds a turn's message keeps what was recorded about the turn; one that does not drops it.
    gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'Hello there.'), createConversationMessage(MessageRole.ASSISTANT, 'Hello.')]);
    expect(JSON.stringify(gmi.getReasoningTrace())).toContain('Hello there.');
    gmi.replaceHistory([createConversationMessage(MessageRole.USER, 'Another subject.')]);
    expect(JSON.stringify(gmi.getReasoningTrace())).not.toContain('Hello there.');
  });
});
