/**
 * A log of the session events an orchestrator or a session hands its listeners, each as one line, in the order they
 * came: the tests of both runtimes read the same lines.
 */
import type { VoiceSessionEventMap } from '../types.js';

/** What the log listens on: an orchestrator, a session, or any emitter of the session events. */
type SessionEventSource = { on(event: string, listener: (payload: any) => void): unknown };

/**
 * Records the session events `target` emits from now on, except `error` and the deprecated names, as lines:
 * `agent <old>><new>`, `user <old>><new>`, `transcribed <interim|final> <text>`, `item user <source> <text>`,
 * `item assistant <played|interrupted> <text>|<playedText>`, `speech <source> <userInitiated>`, `barge_in <action>`,
 * `session_error <source> <recoverable>` and `close <reason>`.
 *
 * @param target - The orchestrator, or the session it returned.
 * @returns The lines, which grow as the events come.
 */
export function recordSessionEvents(target: SessionEventSource): string[] {
  const log: string[] = [];
  target.on('agent_state_changed', (event: VoiceSessionEventMap['agent_state_changed']) => {
    log.push(`agent ${event.oldState}>${event.newState}`);
  });
  target.on('user_state_changed', (event: VoiceSessionEventMap['user_state_changed']) => {
    log.push(`user ${event.oldState}>${event.newState}`);
  });
  target.on('user_input_transcribed', (event: VoiceSessionEventMap['user_input_transcribed']) => {
    log.push(`transcribed ${event.isFinal ? 'final' : 'interim'} ${event.transcript}`);
  });
  target.on('conversation_item_added', ({ item }: VoiceSessionEventMap['conversation_item_added']) => {
    log.push(
      item.role === 'user'
        ? `item user ${item.source} ${item.text}`
        : `item assistant ${item.interrupted ? 'interrupted' : 'played'} ${item.text}|${item.playedText}`
    );
  });
  target.on('speech_created', (event: VoiceSessionEventMap['speech_created']) => {
    log.push(`speech ${event.source} ${event.userInitiated}`);
  });
  target.on('barge_in', (event: VoiceSessionEventMap['barge_in']) => {
    log.push(`barge_in ${event.action}`);
  });
  target.on('session_error', (event: VoiceSessionEventMap['session_error']) => {
    log.push(`session_error ${event.source} ${event.recoverable}`);
  });
  target.on('close', (event: VoiceSessionEventMap['close']) => {
    log.push(`close ${event.reason}`);
  });
  return log;
}
