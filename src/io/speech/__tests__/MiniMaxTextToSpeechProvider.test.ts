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

  it("uses the China endpoint and downloads URL output from an allowed host", async () => {
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
      .mockResolvedValueOnce(new Response("audio"));
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      region: "china",
      audioUrlHosts: ["cdn.example.com"],
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

    // The download carries no key, refuses redirects and has a deadline.
    const [downloadUrl, downloadInit] = fetchImpl.mock.calls[1]!;
    expect(downloadUrl).toBe("https://cdn.example.com/audio.wav");
    expect(downloadInit?.headers).toBeUndefined();
    expect(downloadInit?.redirect).toBe("error");
    expect(downloadInit?.signal).toBeInstanceOf(AbortSignal);
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
          task_id: 95157322514444,
          file_id: 95157322514496,
          base_resp: { status_code: 0 },
        }),
      )
      .mockResolvedValueOnce(
        response({
          task_id: 95157322514444,
          status: "success",
          file_id: 95157322514496,
          base_resp: { status_code: 0 },
        }),
      );
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(provider.createAsync("long text")).resolves.toMatchObject({
      task_id: 95157322514444,
    });
    await expect(
      provider.queryAsync("95157322514444"),
    ).resolves.toMatchObject({
      status: "success",
    });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.minimax.io/v1/t2a_async_v2",
      "https://api.minimax.io/v1/query/t2a_async_query_v2?task_id=95157322514444",
    ]);
    // MiniMax documents the query as a GET with task_id in the query string:
    // https://platform.minimax.io/docs/api-reference/speech-t2a-async-query
    const queryInit = fetchImpl.mock.calls[1]![1];
    expect(queryInit?.method).toBe("GET");
    expect(queryInit?.body).toBeUndefined();
    expect(
      (queryInit?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-key");
  });

  it("does not download URL output from a host that was not allowed", async () => {
    const fetchImpl = vi
      .fn(
        (
          _input: string | URL | Request,
          _init?: RequestInit,
        ): Promise<Response> => Promise.resolve(new Response("not audio")),
      )
      .mockResolvedValueOnce(
        response({
          data: {
            audio: "https://internal.example.net/latest/meta-data",
            status: 2,
          },
          base_resp: { status_code: 0 },
        }),
      );
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      provider.synthesize("hello", {
        providerSpecificOptions: { outputFormat: "url" },
      }),
    ).rejects.toThrow("internal.example.net");
    // Only the synthesis request went out; the returned URL was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * A provider built with `config` whose synthesis response links to `link`;
   * `download` answers the request for that link.
   */
  function urlOutputProvider(
    link: string,
    config: {
      audioUrlHosts?: string[];
      maxAudioDownloadBytes?: number;
      audioDownloadTimeoutMs?: number;
    },
    download: (init?: RequestInit) => Promise<Response> = async () =>
      new Response("audio"),
  ) {
    const fetchImpl = vi
      .fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
          download(init),
      )
      .mockResolvedValueOnce(
        response({
          data: { audio: link, status: 2 },
          base_resp: { status_code: 0 },
        }),
      );
    const provider = new MiniMaxTextToSpeechProvider({
      apiKey: "test-key",
      fetchImpl,
      ...config,
    });
    const synthesize = () =>
      provider.synthesize("hello", {
        providerSpecificOptions: { outputFormat: "url" },
      });
    return { fetchImpl, synthesize };
  }

  it.each([
    ["an http link", "http://cdn.example.com/a.mp3", "only https"],
    [
      "a host that only starts with an allowed one",
      "https://cdn.example.com.attacker.example/a.mp3",
      "not in audioUrlHosts",
    ],
    ["text that is not a URL", "audio.mp3", "not a URL"],
  ])("refuses %s without fetching it", async (_name, link, message) => {
    const { fetchImpl, synthesize } = urlOutputProvider(link, {
      audioUrlHosts: ["cdn.example.com"],
    });

    await expect(synthesize()).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows the subdomains of a *. entry, not the domain itself", async () => {
    const config = { audioUrlHosts: ["*.example.com"] };

    const sub = urlOutputProvider("https://eu.audio.example.com/a.mp3", config);
    await expect(sub.synthesize()).resolves.toMatchObject({
      audioBuffer: Buffer.from("audio"),
    });

    const bare = urlOutputProvider("https://example.com/a.mp3", config);
    await expect(bare.synthesize()).rejects.toThrow("not in audioUrlHosts");
  });

  it("fails on a download that is not a success", async () => {
    const { synthesize } = urlOutputProvider(
      "https://cdn.example.com/a.mp3",
      { audioUrlHosts: ["cdn.example.com"] },
      async () => new Response("denied", { status: 403 }),
    );

    await expect(synthesize()).rejects.toThrow("download failed (403)");
  });

  it("stops at maxAudioDownloadBytes, read or declared", async () => {
    const config = { audioUrlHosts: ["cdn.example.com"], maxAudioDownloadBytes: 4 };

    const read = urlOutputProvider("https://cdn.example.com/a.mp3", config, async () =>
      new Response("12345"),
    );
    await expect(read.synthesize()).rejects.toThrow("larger than 4 bytes");

    const declared = urlOutputProvider("https://cdn.example.com/a.mp3", config, async () =>
      new Response("12", { headers: { "content-length": "999" } }),
    );
    await expect(declared.synthesize()).rejects.toThrow("larger than 4 bytes");

    const fits = urlOutputProvider("https://cdn.example.com/a.mp3", config, async () =>
      new Response("1234"),
    );
    await expect(fits.synthesize()).resolves.toMatchObject({
      audioBuffer: Buffer.from("1234"),
    });
  });

  it("gives up on a download that outlasts audioDownloadTimeoutMs", async () => {
    const { synthesize } = urlOutputProvider(
      "https://cdn.example.com/a.mp3",
      { audioUrlHosts: ["cdn.example.com"], audioDownloadTimeoutMs: 5 },
      (init) =>
        new Promise<Response>((resolve, reject) => {
          // A reply that would come long after the deadline.
          const late = setTimeout(() => resolve(new Response("late")), 10_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(late);
            reject(init?.signal?.reason);
          });
        }),
    );

    await expect(synthesize()).rejects.toThrow("timed out after 5 ms");
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
