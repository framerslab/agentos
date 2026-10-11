/**
 * @fileoverview Audio pieces and their batch transcription, in a page or on a server. The only external import is
 * the optional peer Mediabunny; this entry reaches no Node built-in.
 * @module agentos/io/hearing/pieces
 */

export { planPieces, type PiecePlan } from './plan.js';
export { readAudioInfo, pieceSeconds, type AudioInfo, UnreadableAudioError, COPY_TARGETS, MAX_COPIED_PCM_BYTES_PER_SECOND } from './read.js';
export { wavHeaderSeconds, readWavPcm, type WavPcm } from './wav.js';
export { cutPieces, type AudioPiece, type CutOptions } from './cut.js';
export {
  transcribePieces,
  mergeSeam,
  lastSentence,
  PiecesFailed,
  type TranscribePiecesOptions,
  type PieceInput,
  type PieceTranscript,
  type TranscribePiece,
  type PieceOutcome,
} from '../transcribePieces.js';
