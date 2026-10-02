import WebSocket from "ws";
import { ApiKeyPool } from "../../../core/providers/ApiKeyPool.js";
import type {
  SpeechSynthesisOptions,
  SpeechSynthesisResult,
  TextToSpeechProvider,
} from "../types.js";

export type MiniMaxSpeechRegion = "global" | "china";
export type MiniMaxSpeechAudioFormat = "mp3" | "wav" | "flac" | "pcm";

export const MINIMAX_SPEECH_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
] as const;

const REGION_HOSTS: Record<MiniMaxSpeechRegion, string> = {
  global: "api.minimax.io",
  china: "api.minimaxi.com",
};

const MIME_TYPES: Record<MiniMaxSpeechAudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  pcm: "audio/L16",
};

export interface MiniMaxTextToSpeechProviderConfig {
  apiKey: string;
  region?: MiniMaxSpeechRegion;
  model?: string;
  voice?: string;
  baseUrl?: string;
  webSocketUrl?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => WebSocket;
}

export interface MiniMaxSpeechProviderOptions {
  languageBoost?: string;
  outputFormat?: "hex" | "url";
  pronunciationDict?: Record<string, unknown>;
  audioSetting?: Record<string, unknown>;
  voiceSetting?: Record<string, unknown>;
  voiceModify?: Record<string, unknown>;
  subtitleEnable?: boolean;
}

interface MiniMaxBaseResponse {
  status_code?: number;
  status_msg?: string;
}

interface MiniMaxSpeechResponse {
  data?: { audio?: string; status?: number };
  extra_info?: { audio_length?: number; usage_characters?: number };
  base_resp?: MiniMaxBaseResponse;
}

export interface MiniMaxAsyncSpeechResponse {
  task_id?: string;
  file_id?: number;
  status?: string;
  base_resp?: MiniMaxBaseResponse;
}

function decodeHexAudio(value: string): Buffer {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error("MiniMax speech returned invalid hex audio.");
  }
  return Buffer.from(value, "hex");
}

/** Text-to-speech provider for MiniMax HTTP, async, and WebSocket APIs. */
export class MiniMaxTextToSpeechProvider implements TextToSpeechProvider {
  public readonly id = "minimax-tts";
  public readonly displayName = "MiniMax TTS";
  public readonly supportsStreaming = true;

  private readonly fetchImpl: typeof fetch;
  private readonly keyPool: ApiKeyPool;
  private readonly region: MiniMaxSpeechRegion;
  private readonly host: string;

  constructor(private readonly config: MiniMaxTextToSpeechProviderConfig) {
    this.region = config.region ?? "global";
    this.host = REGION_HOSTS[this.region];
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.keyPool = new ApiKeyPool(config.apiKey);
  }

  getProviderName(): string {
    return this.displayName;
  }

  async synthesize(
    text: string,
    options: SpeechSynthesisOptions = {},
  ): Promise<SpeechSynthesisResult> {
    const providerOptions = this.providerOptions(options);
    const audioFormat = this.audioFormat(options, providerOptions);
    const outputFormat = providerOptions.outputFormat ?? "hex";
    const response = await this.request<MiniMaxSpeechResponse>("/v1/t2a_v2", {
      ...this.buildRequest(text, options, providerOptions, audioFormat),
      stream: false,
      output_format: outputFormat,
      subtitle_enable: providerOptions.subtitleEnable,
    });
    const audio = response.data?.audio;
    if (!audio || response.data?.status !== 2) {
      throw new Error(
        "MiniMax speech synthesis completed without audio output.",
      );
    }

    const audioBuffer =
      outputFormat === "url"
        ? Buffer.from(await (await this.fetchImpl(audio)).arrayBuffer())
        : decodeHexAudio(audio);
    return this.result(audioBuffer, text, options, audioFormat, response);
  }

  async createAsync(
    text: string,
    options: SpeechSynthesisOptions = {},
  ): Promise<MiniMaxAsyncSpeechResponse> {
    const providerOptions = this.providerOptions(options);
    return this.request(
      "/v1/t2a_async_v2",
      this.buildRequest(
        text,
        options,
        providerOptions,
        this.audioFormat(options, providerOptions),
      ),
    );
  }

  async queryAsync(taskId: string): Promise<MiniMaxAsyncSpeechResponse> {
    return this.request("/v1/query/t2a_async_query_v2", { task_id: taskId });
  }

  async synthesizeWebSocket(
    text: string,
    options: SpeechSynthesisOptions = {},
  ): Promise<SpeechSynthesisResult> {
    const providerOptions = this.providerOptions(options);
    const audioFormat = this.audioFormat(options, providerOptions);
    const socketUrl =
      this.config.webSocketUrl ?? `wss://${this.host}/ws/v1/t2a_v2`;
    const headers = { Authorization: `Bearer ${this.keyPool.next()}` };
    const socket = this.config.webSocketFactory
      ? this.config.webSocketFactory(socketUrl, headers)
      : new WebSocket(socketUrl, { headers });

    return new Promise<SpeechSynthesisResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(error);
      };

      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            event?: string;
            data?: { audio?: string };
            base_resp?: MiniMaxBaseResponse;
          };
          if (
            message.base_resp?.status_code &&
            message.base_resp.status_code !== 0
          ) {
            fail(
              new Error(
                message.base_resp.status_msg ??
                  "MiniMax WebSocket synthesis failed.",
              ),
            );
            return;
          }
          if (message.event === "connected_success") {
            socket.send(
              JSON.stringify({
                event: "task_start",
                ...this.buildRequest("", options, providerOptions, audioFormat),
                text: undefined,
              }),
            );
          } else if (message.event === "task_started") {
            socket.send(JSON.stringify({ event: "task_continue", text }));
            socket.send(JSON.stringify({ event: "task_finish" }));
          } else if (
            message.event === "task_continued" &&
            message.data?.audio
          ) {
            chunks.push(decodeHexAudio(message.data.audio));
          } else if (message.event === "task_finished") {
            settled = true;
            socket.close();
            resolve(
              this.result(Buffer.concat(chunks), text, options, audioFormat),
            );
          } else if (message.event === "task_failed") {
            fail(new Error("MiniMax WebSocket synthesis failed."));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => fail(error));
      socket.on("close", () => {
        if (!settled)
          fail(
            new Error("MiniMax WebSocket closed before synthesis completed."),
          );
      });
    });
  }

  private providerOptions(
    options: SpeechSynthesisOptions,
  ): MiniMaxSpeechProviderOptions {
    return (options.providerSpecificOptions ??
      {}) as MiniMaxSpeechProviderOptions;
  }

  private audioFormat(
    options: SpeechSynthesisOptions,
    providerOptions: MiniMaxSpeechProviderOptions,
  ): MiniMaxSpeechAudioFormat {
    const requested =
      providerOptions.audioSetting?.["format"] ?? options.outputFormat ?? "mp3";
    if (
      requested !== "mp3" &&
      requested !== "wav" &&
      requested !== "flac" &&
      requested !== "pcm"
    ) {
      throw new Error("MiniMax speech format must be mp3, wav, flac, or pcm.");
    }
    return requested;
  }

  private buildRequest(
    text: string,
    options: SpeechSynthesisOptions,
    providerOptions: MiniMaxSpeechProviderOptions,
    audioFormat: MiniMaxSpeechAudioFormat,
  ): Record<string, unknown> {
    return {
      model: options.model ?? this.config.model ?? "speech-2.8-hd",
      text,
      language_boost: providerOptions.languageBoost ?? options.languageCode,
      voice_setting: {
        voice_id:
          options.voice ?? this.config.voice ?? "English_expressive_narrator",
        ...(options.speed !== undefined ? { speed: options.speed } : {}),
        ...(options.volume !== undefined ? { vol: options.volume } : {}),
        ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
        ...providerOptions.voiceSetting,
      },
      pronunciation_dict: providerOptions.pronunciationDict,
      audio_setting: { ...providerOptions.audioSetting, format: audioFormat },
      voice_modify: providerOptions.voiceModify,
    };
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const baseUrl = this.config.baseUrl ?? `https://${this.host}`;
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.keyPool.next()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let payload: T & { base_resp?: MiniMaxBaseResponse };
    try {
      payload = (await response.json()) as T & {
        base_resp?: MiniMaxBaseResponse;
      };
    } catch {
      throw new Error(
        `MiniMax speech returned invalid JSON (${response.status}).`,
      );
    }
    if (!response.ok || payload.base_resp?.status_code !== 0) {
      const message =
        payload.base_resp?.status_msg ??
        response.statusText ??
        "request failed";
      throw new Error(
        `MiniMax speech request failed (${response.status}): ${message}`,
      );
    }
    return payload;
  }

  private result(
    audioBuffer: Buffer,
    text: string,
    options: SpeechSynthesisOptions,
    audioFormat: MiniMaxSpeechAudioFormat,
    response?: MiniMaxSpeechResponse,
  ): SpeechSynthesisResult {
    const voice =
      options.voice ?? this.config.voice ?? "English_expressive_narrator";
    const model = options.model ?? this.config.model ?? "speech-2.8-hd";
    return {
      audioBuffer,
      mimeType: MIME_TYPES[audioFormat],
      cost: 0,
      durationSeconds:
        response?.extra_info?.audio_length !== undefined
          ? response.extra_info.audio_length / 1000
          : undefined,
      providerResponse: response,
      voiceUsed: voice,
      providerName: this.displayName,
      usage: {
        characters: response?.extra_info?.usage_characters ?? text.length,
        modelUsed: model,
        region: this.region,
      },
    };
  }
}
