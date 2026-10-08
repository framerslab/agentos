import type { AdaptiveVADConfig, VADResult } from '../hearing/AdaptiveVAD.js';
import type { NoiseProfile } from '../hearing/EnvironmentalCalibrator.js';
import type { SilenceDetectorConfig } from '../hearing/SilenceDetector.js';

export type SpeechProviderKind = 'telephony' | 'stt' | 'tts' | 'vad' | 'wake-word';

export type SpeechResponseFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
export type SpeechSynthesisOutputFormat =
  | 'mp3'
  | 'opus'
  | 'aac'
  | 'flac'
  | 'wav'
  | 'pcm'
  | (string & {});

export interface SpeechAudioInput {
  data: Buffer;
  fileName?: string;
  mimeType?: string;
  format?: string;
  sampleRate?: number;
  durationSeconds?: number;
}

export interface SpeechTranscriptionWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface SpeechTranscriptionSegment {
  text: string;
  startTime: number;
  endTime: number;
  confidence?: number;
  speaker?: string | number;
  words?: SpeechTranscriptionWord[];
  id?: number;
  seek?: number;
  tokens?: number[];
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

export interface SpeechTranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  cost: number;
  segments?: SpeechTranscriptionSegment[];
  providerResponse?: unknown;
  confidence?: number;
  isFinal?: boolean;
  usage?: {
    durationMinutes: number;
    modelUsed: string;
    providerSpecific?: Record<string, unknown>;
  };
}

export interface SpeechTranscriptionOptions {
  language?: string;
  model?: string;
  prompt?: string;
  responseFormat?: SpeechResponseFormat;
  temperature?: number;
  enableSpeakerDiarization?: boolean;
  numSpeakers?: number;
  providerSpecificOptions?: Record<string, unknown>;
  providerId?: string;
  stream?: boolean;
}

export interface SpeechTranscriptionRequestOptions {
  language?: string;
  prompt?: string;
  model?: string;
  responseFormat?: string;
  userId?: string;
  temperature?: number | string;
  providerId?: string;
  stream?: boolean | string;
}

export interface SpeechAudioAnalysis {
  duration: number;
  fileSize: number;
  estimatedCost: number;
  isOptimal: boolean;
  recommendations: string[];
  mimeType?: string;
}

export interface SpeechSynthesisResult {
  audioBuffer: Buffer;
  mimeType: string;
  cost: number;
  durationSeconds?: number;
  providerResponse?: unknown;
  voiceUsed?: string;
  providerName?: string;
  usage?: {
    characters: number;
    modelUsed: string;
    [key: string]: unknown;
  };
}

export interface SpeechVoice {
  id: string;
  name: string;
  gender?: 'male' | 'female' | 'neutral' | string;
  lang: string;
  description?: string;
  provider: string;
  isDefault?: boolean;
}

export interface SpeechSynthesisOptions {
  voice?: string;
  outputFormat?: SpeechSynthesisOutputFormat;
  speed?: number;
  pitch?: number;
  volume?: number;
  languageCode?: string;
  model?: string;
  providerId?: string;
  providerSpecificOptions?: Record<string, unknown>;
}

export interface SpeechToTextProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly supportsStreaming?: boolean;
  transcribe(
    audio: SpeechAudioInput,
    options?: SpeechTranscriptionOptions
  ): Promise<SpeechTranscriptionResult>;
  getProviderName(): string;
}

export interface TextToSpeechProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly supportsStreaming?: boolean;
  synthesize(text: string, options?: SpeechSynthesisOptions): Promise<SpeechSynthesisResult>;
  getProviderName(): string;
  listAvailableVoices?(): Promise<SpeechVoice[]>;
}

export interface SpeechVadDecision {
  isSpeech: boolean;
  confidence?: number;
  result?: VADResult;
  profile?: NoiseProfile | null;
}

export interface SpeechVadProvider {
  readonly id: string;
  readonly displayName?: string;
  processFrame(frame: Float32Array): SpeechVadDecision;
  reset(): void;
  getNoiseProfile?(): NoiseProfile | null;
  dispose?(): void;
}

export interface WakeWordDetection {
  keyword: string;
  confidence?: number;
  providerId?: string;
  metadata?: Record<string, unknown>;
}

export interface WakeWordProvider {
  readonly id: string;
  readonly displayName?: string;
  detect(frame: Float32Array, sampleRate: number): WakeWordDetection | null | Promise<WakeWordDetection | null>;
  reset?(): void;
  dispose?(): void;
}

export interface SpeechProviderCatalogEntry {
  id: string;
  kind: SpeechProviderKind;
  label: string;
  envVars: readonly string[];
  local: boolean;
  streaming?: boolean;
  description: string;
  extensionName?: string;
  defaultModel?: string;
  defaultVoice?: string;
  features?: readonly string[];
  available?: boolean;
}

/** Configuration for the speech provider resolver. */
export interface SpeechResolverConfig {
  stt?: {
    preferred?: string[];
    fallback?: boolean;
  };
  tts?: {
    preferred?: string[];
    voice?: string;
    fallback?: boolean;
  };
  wakeWord?: {
    provider?: string;
    keywords?: string[];
    sensitivity?: number;
  };
}

/** Requirements for provider resolution. */
export interface ProviderRequirements {
  streaming?: boolean;
  local?: boolean;
  /** Features every match must list. `'streaming'` is read as the `streaming` capability, which a provider instance can override. */
  features?: string[];
  preferredIds?: string[];
}

/** A registered provider with metadata. */
export interface ProviderRegistration {
  id: string;
  kind: SpeechProviderKind;
  provider: SpeechToTextProvider | TextToSpeechProvider | SpeechVadProvider | WakeWordProvider;
  catalogEntry: SpeechProviderCatalogEntry;
  isConfigured: boolean;
  priority: number;
  source: 'core' | 'extension';
}

export type SpeechSessionMode = 'manual' | 'vad' | 'wake-word';
export type SpeechSessionState =
  | 'idle'
  | 'wake-listening'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'responding'
  | 'playing'
  | 'interrupted'
  | 'closed'
  | 'error';

export type SpeechSessionBoundaryReason =
  | 'speech-end'
  | 'silence-timeout'
  | 'manual'
  | 'provider'
  | 'wake-word';

export interface SpeechSessionAudioCapture {
  audioBuffer: Buffer;
  mimeType: string;
  fileName: string;
  sampleRate: number;
  durationMs: number;
  frameCount: number;
}

export interface SpeechSessionConfig {
  mode?: SpeechSessionMode;
  sampleRate?: number;
  frameDurationMs?: number;
  audioFileName?: string;
  autoTranscribeOnSpeechEnd?: boolean;
  sttOptions?: SpeechTranscriptionOptions;
  ttsOptions?: SpeechSynthesisOptions;
  vad?: AdaptiveVADConfig;
  silence?: SilenceDetectorConfig;
  wakeWord?: {
    keyword?: string;
  };
}

export interface SpeechSessionProviders {
  stt?: SpeechToTextProvider;
  tts?: TextToSpeechProvider;
  vad?: SpeechVadProvider;
  wakeWord?: WakeWordProvider;
}

export interface SpeechSessionStateChangedEvent {
  previous: SpeechSessionState;
  current: SpeechSessionState;
}

export interface SpeechSessionSpeechStartedEvent {
  timestamp: number;
  vad: VADResult;
}

export interface SpeechSessionSpeechEndedEvent {
  timestamp: number;
  vad: VADResult;
  durationMs: number;
}

export interface SpeechSessionUtteranceCapturedEvent {
  reason: SpeechSessionBoundaryReason;
  capture: SpeechSessionAudioCapture;
}

export interface SpeechSessionTranscriptEvent {
  result: SpeechTranscriptionResult;
  capture: SpeechSessionAudioCapture;
}

export interface SpeechSessionWakeWordEvent {
  detection: WakeWordDetection;
}

export interface SpeechSessionSynthesisStartedEvent {
  text: string;
}

export interface SpeechSessionSynthesisCompletedEvent {
  text: string;
  result: SpeechSynthesisResult;
}

export interface SpeechSessionErrorEvent {
  error: Error;
}

export interface SpeechSessionEventMap {
  state_changed: (event: SpeechSessionStateChangedEvent) => void;
  vad_result: (result: SpeechVadDecision) => void;
  speech_started: (event: SpeechSessionSpeechStartedEvent) => void;
  speech_ended: (event: SpeechSessionSpeechEndedEvent) => void;
  significant_pause: (pauseDurationMs: number) => void;
  utterance_captured: (event: SpeechSessionUtteranceCapturedEvent) => void;
  transcript_final: (event: SpeechSessionTranscriptEvent) => void;
  wake_word_detected: (event: SpeechSessionWakeWordEvent) => void;
  synthesis_started: (event: SpeechSessionSynthesisStartedEvent) => void;
  synthesis_completed: (event: SpeechSessionSynthesisCompletedEvent) => void;
  error: (event: SpeechSessionErrorEvent) => void;
}

export interface SpeechRuntimeSessionConfig extends SpeechSessionConfig {
  sttProviderId?: string;
  ttsProviderId?: string;
  vadProviderId?: string;
  wakeWordProviderId?: string;
}

export interface SpeechRuntimeConfig {
  autoRegisterFromEnv?: boolean;
  env?: Record<string, string | undefined>;
  preferredSttProviderId?: string;
  preferredTtsProviderId?: string;
}

// Backward-compatible aliases for the Rabbithole backend speech contracts.
export type ITranscriptionSegmentWord = SpeechTranscriptionWord;
export type ITranscriptionSegment = SpeechTranscriptionSegment;
export type ITranscriptionResult = SpeechTranscriptionResult;
export type ISttOptions = SpeechTranscriptionOptions;
export type ISttRequestOptions = SpeechTranscriptionRequestOptions;
export type IAudioAnalysis = SpeechAudioAnalysis;
export type SttResponseFormat = SpeechResponseFormat;
export type ISttProvider = SpeechToTextProvider;
export type ITtsResult = SpeechSynthesisResult;
export type IAvailableVoice = SpeechVoice;
export type ITtsOptions = SpeechSynthesisOptions;
export type ITtsProvider = TextToSpeechProvider;
