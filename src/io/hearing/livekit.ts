/**
 * @module hearing/livekit
 *
 * LiveKit for the hearing layer and the voice pipeline: transcripts written
 * into a LiveKit room as LiveKit's own transcription text streams, their
 * translations written to the participants that read them, a room
 * participant's audio as `AudioFrame`s, and an `IStreamTransport` over a
 * room, which with a publisher also speaks into it, and with the publisher's
 * `mark` option sets a machine-readable mark for synthetic speech on the
 * publishing participant's attributes (`SpeechMark`,
 * `LIVEKIT_SPEECH_MARK_ATTRIBUTES`). The transcription output
 * takes the host's connected `@livekit/rtc-node` `Room`, described by a
 * structural type. The audio source and the transport are Node only and run
 * on the optional peer `@livekit/rtc-node`, loaded on first use or passed in
 * by the host, so this entry imports no LiveKit package.
 *
 * @example
 * ```typescript
 * import { LiveKitRoomAudioSource, LiveKitTranscriptionOutput, LiveKitTranslationOutput } from '@framers/agentos/io/hearing/livekit';
 * ```
 */

export {
  LiveKitTranscriptionOutput,
  type LiveKitTranscriptionOutputOptions,
  type LiveKitTranscriptionRoomLike,
} from './LiveKitTranscriptionOutput.js';
export {
  LiveKitTranslationOutput,
  LIVEKIT_TRANSLATION_TOPIC,
  LIVEKIT_TRANSLATION_ATTRIBUTES,
  type LiveKitTranslationOutputOptions,
  type TranslationOutputLine,
} from './LiveKitTranslationOutput.js';
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
export {
  isLiveKitSipParticipant,
  LIVEKIT_PLAYOUT_ATTRIBUTE,
  LIVEKIT_SPEECH_MARK_ATTRIBUTES,
  type LiveKitAudioPublisherOptions,
  type LiveKitPlayout,
  type LiveKitPlayoutParticipant,
  type SpeechMark,
} from '../voice-pipeline/LiveKitAudioPublisher.js';
