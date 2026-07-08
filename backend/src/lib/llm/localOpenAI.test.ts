import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeLocalText, streamLocal } from "./localOpenAI";
import type { NormalizedToolCall, NormalizedToolResult } from "./types";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(responses: Response[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const response = responses[Math.min(i, responses.length - 1)];
      i++;
      return response;
    }),
  );
  return { calls };
}

function requestBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}

describe("streamLocal", () => {
  beforeEach(() => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");
    vi.stubEnv("LOCAL_LLM_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("throws a clear error when local mode is not configured", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("LOCAL_LLM_BASE_URL", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LOCAL_LLM_MODELS", "");
    await expect(
      streamLocal({
        model: "local:qwen2.5:14b-instruct",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("assembles streamed content deltas into fullText and fires onContentDelta", async () => {
    const { calls } = stubFetch([
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ]);

    const deltas: string[] = [];
    const result = await streamLocal({
      model: "local:qwen2.5:14b-instruct",
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Say hello" }],
      callbacks: { onContentDelta: (t) => deltas.push(t) },
    });

    expect(result.fullText).toBe("Hello world");
    expect(deltas).toEqual(["Hello", " world"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");

    const body = requestBody(calls[0]);
    // "local:" prefix must be stripped before sending to the server.
    expect(body.model).toBe("qwen2.5:14b-instruct");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Say hello" },
    ]);
  });

  it("defaults the Authorization header to Bearer ollama when no LOCAL_LLM_API_KEY is set", async () => {
    const { calls } = stubFetch([
      sseResponse([
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ]);

    await streamLocal({
      model: "local:qwen2.5:14b-instruct",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ollama");
  });

  it("uses LOCAL_LLM_API_KEY as the bearer token when set", async () => {
    vi.stubEnv("LOCAL_LLM_API_KEY", "my-secret-token");
    const { calls } = stubFetch([
      sseResponse([
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ]);

    await streamLocal({
      model: "local:qwen2.5:14b-instruct",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret-token");
  });

  it("accumulates tool-call argument fragments by index, runs the tool loop, and shapes the second-turn messages", async () => {
    const { calls } = stubFetch([
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"London\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        'data: {"choices":[{"delta":{"content":"It is 15C in London."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ]);

    const started: NormalizedToolCall[] = [];
    const runTools = vi.fn(
      async (
        toolCalls: NormalizedToolCall[],
      ): Promise<NormalizedToolResult[]> =>
        toolCalls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({ temp: 15 }),
        })),
    );

    const result = await streamLocal({
      model: "local:qwen2.5:14b-instruct",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "Weather in London?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      callbacks: { onToolCallStart: (c) => started.push(c) },
      runTools,
    });

    // onToolCallStart fires as soon as id+name are known — mirroring
    // openai.ts, which announces on the function_call "item added"
    // event before arguments have finished streaming in. The full
    // parsed input only becomes available once accumulation completes,
    // which is what gets passed to runTools below.
    expect(started).toEqual([{ id: "call_1", name: "get_weather", input: {} }]);
    expect(runTools).toHaveBeenCalledWith([
      { id: "call_1", name: "get_weather", input: { location: "London" } },
    ]);
    expect(result.fullText).toBe("It is 15C in London.");
    expect(calls).toHaveLength(2);

    const secondBody = requestBody(calls[1]);
    const messages = secondBody.messages as Record<string, unknown>[];
    // system + user + assistant(tool_calls) + tool result
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"location":"London"}',
          },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ temp: 15 }),
    });
  });

  it("converts malformed tool-call JSON into an error result instead of crashing", async () => {
    const { calls } = stubFetch([
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"get_weather","arguments":"{not valid json"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Sorry, I could not check that."},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ]);

    const runTools = vi.fn(async (): Promise<NormalizedToolResult[]> => []);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await streamLocal({
      model: "local:qwen2.5:14b-instruct",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [],
      runTools,
    });

    // The malformed call is never executed — with no valid calls left,
    // runTools is skipped entirely and the error is reported directly.
    expect(runTools).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    const secondBody = requestBody(calls[1]);
    const messages = secondBody.messages as Record<string, unknown>[];
    const toolResult = messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_bad",
    ) as { content: string } | undefined;
    expect(toolResult).toBeDefined();
    const parsed = JSON.parse(toolResult!.content);
    expect(parsed.error).toMatch(/Invalid tool arguments/);

    warnSpy.mockRestore();
  });

  it("aborts immediately without calling fetch when the signal is already aborted", async () => {
    const { calls } = stubFetch([
      sseResponse([
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      streamLocal({
        model: "local:qwen2.5:14b-instruct",
        systemPrompt: "",
        messages: [{ role: "user", content: "hi" }],
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});

describe("completeLocalText", () => {
  beforeEach(() => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");
    vi.stubEnv("LOCAL_LLM_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the non-streaming completion content and strips the local: prefix", async () => {
    const { calls } = stubFetch([
      jsonResponse({ choices: [{ message: { content: "Generated Title" } }] }),
    ]);

    const text = await completeLocalText({
      model: "local:qwen2.5:14b-instruct",
      systemPrompt: "Generate a title.",
      user: "Some message",
    });

    expect(text).toBe("Generated Title");
    const body = requestBody(calls[0]);
    expect(body.model).toBe("qwen2.5:14b-instruct");
    expect(body.stream).toBe(false);
  });
});
