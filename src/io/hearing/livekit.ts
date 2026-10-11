/**
 * @module hearing/livekit
 *
 * LiveKit for the hearing layer and the voice pipeline: transcripts written
 * into a LiveKit room as LiveKit's own transcription text streams, a room
 * participant's audio as `AudioFrame`s, and an `IStreamTransport` over a
 * room. The transcription output takes the host's connected
 * `@livekit/rtc-node` `Room`, described by a structural type. The audio source
 * and the transport are Node only and run on the optional peer
 * `@livekit/rtc-node`, loaded on first use or passed in by the host, so this
 * entry imports no LiveKit package.
 *
 * @example
 * ```typescript
 * import { LiveKitRoomAudioSource, LiveKitTranscriptionOutput } from '@framers/agentos/io/hearing/livekit';
 * ```
 */

export {
  LiveKitTranscriptionOutput,
  type LiveKitTranscriptionOutputOptions,
  type LiveKitTranscriptionRoomLike,
} from './LiveKitTranscriptionOutput.js';
export {
  LiveKitRoomAudioSource,
  loadLiveKitRtc,
  type LiveKitRoomAudioSourceOptions,
  type LiveKitRtcModule,
  type LiveKitRoomLike,
  type LiveKitParticipantLike,
  type LiveKitLocalParticipantLike,
  type LiveKitTrackLike,
  type LiveKitTrackPublicationLike,
  type LiveKitAudioFrameLike,
  type LiveKitAudioStreamLike,
  type LiveKitAudioStreamReaderLike,
  type LiveKitTextStreamReaderLike,
  type LiveKitTextStreamHandler,
  type LiveKitSendTextOptions,
} from './LiveKitRoomAudioSource.js';
export {
  LiveKitStreamTransport,
  LIVEKIT_TRANSPORT_DEFAULT_TOPIC,
  type LiveKitStreamTransportOptions,
} from '../voice-pipeline/LiveKitStreamTransport.js';
