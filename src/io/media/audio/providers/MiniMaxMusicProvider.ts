/**
 * Music generation provider for the MiniMax Music API.
 */

import { ApiKeyPool } from '../../../../core/providers/ApiKeyPool.js';
import type { IAudioGenerator } from '../IAudioGenerator.js';
import type {
  AudioResult,
  MusicGenerateRequest,
} from '../types.js';

export type MiniMaxMusicRegion = 'global' | 'china';
export type MiniMaxMusicResponseFormat = 'url' | 'hex';
export type MiniMaxMusicAudioFormat = 'mp3' | 'wav' | 'pcm';

export interface MiniMaxMusicProviderConfig {
  apiKey: string;
  baseURL?: string;
  region?: MiniMaxMusicRegion;
  defaultModelId?: string;
}

export interface MiniMaxMusicProviderOptions {
  region?: MiniMaxMusicRegion;
  baseURL?: string;
  responseFormat?: MiniMaxMusicResponseFormat;
  lyrics?: string;
  lyricsOptimizer?: boolean;
  isInstrumental?: boolean;
  audioSetting?: {
    sample_rate?: number;
    bitrate?: number;
    format?: MiniMaxMusicAudioFormat;
  };
  aigcWatermark?: boolean;
  audioUrl?: string;
  audioBase64?: string;
  coverFeatureId?: string;
}

interface MiniMaxMusicResponse {
  data?: {
    audio?: string;
    status?: number;
  };
  trace_id?: string;
  extra_info?: {
    music_duration?: number;
    music_sample_rate?: number;
    music_channel?: number;
    bitrate?: number;
    music_size?: number;
  };
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

const MUSIC_ENDPOINTS: Record<MiniMaxMusicRegion, string> = {
  global: 'https://api.minimax.io/v1/music_generation',
  china: 'https://api.minimaxi.com/v1/music_generation',
};

const AUDIO_MIME_TYPES: Record<MiniMaxMusicAudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

function asOptions(value: Record<string, unknown> | undefined): MiniMaxMusicProviderOptions {
  return (value ?? {}) as MiniMaxMusicProviderOptions;
}

export class MiniMaxMusicProvider implements IAudioGenerator {
  public readonly providerId = 'minimax-music';
  public isInitialized = false;
  public defaultModelId?: string;

  private _config!: Required<
    Pick<MiniMaxMusicProviderConfig, 'apiKey' | 'baseURL' | 'region' | 'defaultModelId'>
  >;
  private keyPool!: ApiKeyPool;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new Error('MiniMax Music provider requires apiKey (MINIMAX_API_KEY).');
    }

    const region: MiniMaxMusicRegion = config.region === 'china' ? 'china' : 'global';
    this._config = {
      apiKey,
      region,
      baseURL:
        typeof config.baseURL === 'string' && config.baseURL.trim()
          ? config.baseURL.trim()
          : MUSIC_ENDPOINTS[region],
      defaultModelId:
        typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
          ? config.defaultModelId.trim()
          : 'music-3.0',
    };

    this.defaultModelId = this._config.defaultModelId;
    this.keyPool = new ApiKeyPool(apiKey);
    this.isInitialized = true;
  }

  async generateMusic(request: MusicGenerateRequest): Promise<AudioResult> {
    if (!this.isInitialized) {
      throw new Error('MiniMax Music provider is not initialized. Call initialize() first.');
    }

    const options = asOptions(request.providerOptions);
    const model = request.modelId || this.defaultModelId || 'music-3.0';
    const region = options.region === 'china' || options.region === 'global'
      ? options.region
      : this._config.region;
    const endpoint = options.baseURL?.trim() ||
      (options.region ? MUSIC_ENDPOINTS[region] : this._config.baseURL);
    const responseFormat = options.responseFormat ?? 'url';
    if (responseFormat !== 'url' && responseFormat !== 'hex') {
      throw new Error('MiniMax music responseFormat must be "url" or "hex".');
    }
    const requestedAudioFormat = options.audioSetting?.format ?? request.outputFormat ?? 'mp3';
    if (requestedAudioFormat !== 'mp3' && requestedAudioFormat !== 'wav' && requestedAudioFormat !== 'pcm') {
      throw new Error('MiniMax music audio format must be "mp3", "wav", or "pcm".');
    }
    const audioFormat: MiniMaxMusicAudioFormat = requestedAudioFormat;
    const isCover = model === 'music-cover' || model === 'music-cover-free';
    const referenceInputs = [options.audioUrl, options.audioBase64, options.coverFeatureId]
      .filter((value) => typeof value === 'string' && value.length > 0);

    if (isCover && referenceInputs.length !== 1) {
      throw new Error(
        'MiniMax music cover requires exactly one of audioUrl, audioBase64, or coverFeatureId.',
      );
    }

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      stream: false,
      output_format: responseFormat,
      audio_setting: {
        ...options.audioSetting,
        format: audioFormat,
      },
    };

    if (options.lyrics !== undefined) body.lyrics = options.lyrics;
    if (!isCover) {
      body.lyrics_optimizer =
        options.lyricsOptimizer ?? (!options.lyrics && !options.isInstrumental);
      body.is_instrumental = options.isInstrumental ?? false;
    }
    if (region === 'china' && options.aigcWatermark !== undefined) {
      body.aigc_watermark = options.aigcWatermark;
    }
    if (options.audioUrl) body.audio_url = options.audioUrl;
    if (options.audioBase64) body.audio_base64 = options.audioBase64;
    if (options.coverFeatureId) body.cover_feature_id = options.coverFeatureId;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json() as MiniMaxMusicResponse;
    if (!response.ok || payload.base_resp?.status_code !== 0) {
      const message = payload.base_resp?.status_msg || response.statusText || 'unknown error';
      throw new Error(`MiniMax music generation failed (${response.status}): ${message}`);
    }
    if (payload.data?.status !== 2) {
      throw new Error(`MiniMax music generation returned incomplete status ${payload.data?.status}.`);
    }

    const audio = payload.data.audio;
    if (!audio) {
      throw new Error('MiniMax music generation completed without audio output.');
    }

    const durationMs = payload.extra_info?.music_duration;
    const generatedAudio = {
      ...(responseFormat === 'url'
        ? { url: audio }
        : { base64: Buffer.from(audio, 'hex').toString('base64') }),
      mimeType: AUDIO_MIME_TYPES[audioFormat],
      ...(durationMs !== undefined ? { durationSec: durationMs / 1000 } : {}),
      ...(payload.extra_info?.music_sample_rate !== undefined
        ? { sampleRate: payload.extra_info.music_sample_rate }
        : {}),
      providerMetadata: {
        traceId: payload.trace_id,
        status: payload.data.status,
        responseFormat,
        region,
        channelCount: payload.extra_info?.music_channel,
        bitrate: payload.extra_info?.bitrate,
        sizeBytes: payload.extra_info?.music_size,
      },
    };

    return {
      created: Math.floor(Date.now() / 1000),
      modelId: model,
      providerId: this.providerId,
      audio: [generatedAudio],
      usage: { totalAudioClips: 1 },
    };
  }

  supports(capability: 'music' | 'sfx'): boolean {
    return capability === 'music';
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
  }
}
