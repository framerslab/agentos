/**
 * @fileoverview A detection provider that refuses. Whisper is a speech model: it names a
 * clip's language only while transcribing audio, it detects nothing from text, and it reports
 * no confidence. So `detect(text)` throws {@link LanguageDetectionUnsupportedError} rather than
 * answer a guess, and `LanguageService` does not build this provider from its config (a
 * `whisper_stub` entry is skipped with one `language.detector_unsupported` line).
 *
 * @module agentos/cognition/nlp/language/providers/WhisperDetectionProvider
 */
import { ILanguageDetectionProvider, DetectedLanguageResult, LanguageDetectionUnsupportedError } from '../interfaces';

interface WhisperParams { apiKey?: string; endpoint?: string; }

export class WhisperDetectionProvider implements ILanguageDetectionProvider {
  public isInitialized = false;
  constructor(public readonly id: string, _params: WhisperParams = {}) {}
  async initialize(): Promise<void> { this.isInitialized = true; }

  /** @throws {LanguageDetectionUnsupportedError} Always: Whisper does not detect a language from text. */
  async detect(_text: string): Promise<DetectedLanguageResult[]> {
    throw new LanguageDetectionUnsupportedError(
      'WhisperDetectionProvider does not detect a language from text: Whisper detects a language only from audio while transcribing',
      this.id,
    );
  }

  shutdown() { return Promise.resolve(); }
}
