import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { MiniMaxTextToSpeechProvider } from "../providers/MiniMaxTextToSpeechProvider.js";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("MiniMaxTextToSpeechProvider", () => {
  it("synthesizes hex audio through the global HTTP endpoint", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response({
          data: { audio: "000102ff", status: 2 },
          extra_info: { audio_length: 1250, usage_characters: 5 },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
    );
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await provider.synthesize("hello", {
      voice: "English_expressive_narrator",
      providerSpecificOptions: {
        languageBoost: "English",
        pronunciationDict: { tone: ["hello/hello"] },
        audioSetting: { sample_rate: 32000 },
        voiceModify: { pitch: 1 },
        subtitleEnable: true,
      },
    });

    expect(result.audioBuffer).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(result.durationSeconds).toBe(1.25);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: "speech-2.8-hd",
      text: "hello",
      stream: false,
      output_format: "hex",
      language_boost: "English",
      voice_setting: { voice_id: "English_expressive_narrator" },
      audio_setting: { sample_rate: 32000, format: "mp3" },
      pronunciation_dict: { tone: ["hello/hello"] },
      voice_modify: { pitch: 1 },
      subtitle_enable: true,
    });
  });

  it("uses the China endpoint and downloads URL output", async () => {
    const fetchImpl = vi
      .fn(
        (
          _input: string | URL | Request,
          _init?: RequestInit,
        ): Promise<Response> =>
          Promise.resolve(undefined as unknown as Response),
      )
      .mockResolvedValueOnce(
        response({
          data: { audio: "https://cdn.example.com/audio.wav", status: 2 },
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce({
        arrayBuffer: vi.fn(async () => Buffer.from("audio")),
      } as unknown as Response);
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      region: "china",
      fetchImpl,
    });

    const result = await provider.synthesize("hello", {
      outputFormat: "wav",
      providerSpecificOptions: { outputFormat: "url" },
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.minimaxi.com/v1/t2a_v2",
    );
    expect(result.audioBuffer.toString()).toBe("audio");
    expect(result.mimeType).toBe("audio/wav");
  });

  it("creates and queries asynchronous speech tasks", async () => {
    const fetchImpl = vi
      .fn(
        (
          _input: string | URL | Request,
          _init?: RequestInit,
        ): Promise<Response> =>
          Promise.resolve(undefined as unknown as Response),
      )
      .mockResolvedValueOnce(
        response({
          task_id: "task-1",
          file_id: 42,
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce(
        response({
          task_id: "task-1",
          status: "success",
          file_id: 42,
          base_resp: { status_code: 0 },
        }),
      );
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(provider.createAsync("long text")).resolves.toMatchObject({
      task_id: "task-1",
    });
    await expect(provider.queryAsync("task-1")).resolves.toMatchObject({
      status: "success",
    });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.minimax.io/v1/t2a_async_v2",
      "https://api.minimax.io/v1/query/t2a_async_query_v2",
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]?.body as string)).toEqual({
      task_id: "task-1",
    });
  });

  it("runs the WebSocket start, continue, and finish protocol", async () => {
    class Socket extends EventEmitter {
      sent: string[] = [];
      send(value: string) {
        this.sent.push(value);
      }
      close() {}
    }
    const socket = new Socket();
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      webSocketFactory: (url, headers) => {
        expect(url).toBe("wss://api.minimax.io/ws/v1/t2a_v2");
        expect(headers.Authorization).toBe("Bearer test-key");
        return socket as unknown as WebSocket;
      },
    });

    const resultPromise = provider.synthesizeWebSocket("hello");
    socket.emit(
      "message",
      JSON.stringify({
        event: "connected_success",
        base_resp: { status_code: 0 },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        event: "task_started",
        base_resp: { status_code: 0 },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        event: "task_continued",
        data: { audio: "0001ff" },
        base_resp: { status_code: 0 },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        event: "task_finished",
        base_resp: { status_code: 0 },
      }),
    );

    await expect(resultPromise).resolves.toMatchObject({
      audioBuffer: Buffer.from([0, 1, 255]),
      mimeType: "audio/mpeg",
    });
    expect(socket.sent.map((value) => JSON.parse(value).event)).toEqual([
      "task_start",
      "task_continue",
      "task_finish",
    ]);
  });

  it("rejects invalid hex audio", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response({
          data: { audio: "not-hex", status: 2 },
          base_resp: { status_code: 0 },
        }),
    );
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(provider.synthesize("hello")).rejects.toThrow(
      "invalid hex audio",
    );
  });
});
