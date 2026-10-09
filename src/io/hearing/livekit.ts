/**
 * @module hearing/livekit
 *
 * LiveKit for the hearing layer: transcripts written into a LiveKit room as
 * LiveKit's own transcription text streams, by an agent that joined the room
 * as a participant. It takes the host's connected `@livekit/rtc-node` `Room`,
 * described by a structural type, so this entry imports no LiveKit package.
 *
 * @example
 * ```typescript
 * import { LiveKitTranscriptionOutput } from '@framers/agentos/io/hearing/livekit';
 * ```
 */

export {
  LiveKitTranscriptionOutput,
  type LiveKitTranscriptionOutputOptions,
  type LiveKitTranscriptionRoomLike,
} from './LiveKitTranscriptionOutput.js';
