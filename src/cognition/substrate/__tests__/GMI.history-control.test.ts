/**
 * @fileoverview The host can replace or clear a GMI's conversation history.
 * Checked through the messages the provider receives: after replaceHistory
 * the next request carries exactly the given messages before the new user
 * message, an empty array is authoritative, and a replaced or cleared fact
 * never reaches a later request.
 */
import { describe, expect, it } from 'vitest';
import { createConversationMessage, MessageRole } from '../../../core/conversation/ConversationMessage';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn } from './helpers/scriptedGmi';

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
});
