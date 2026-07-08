// Streaming client for local / on-premises OpenAI-compatible servers
// (Ollama, LM Studio, vLLM) — POST {baseUrl}/chat/completions with
// stream: true, standard OpenAI chat-completions tool-calling format.
//
// This is a NEW client, not a base-URL override of ./openai.ts: upstream's
// openai.ts speaks the OpenAI *Responses* API (/v1/responses), which local
// servers do not reliably implement. Local servers implement the older
// chat-completions shape, so the wire format here differs (tool_calls
// deltas accumulated by index, messages array instead of Responses "input"
// items) even though the external StreamChatParams/StreamChatResult and
// callback contract stay identical to every other provider adapter.
import type {
  LlmMessage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { getLocalLlmConfig, stripLocalModelPrefix } from "./localConfig";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

type ChatCompletionMessage =
  | { role: "system"; content: string }
  | { role: "user" | "assistant"; content: string | null }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: FinalizedToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type FinalizedToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type DeltaToolCall = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type ChatCompletionChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      // Some OpenAI-compatible servers (reasoning-model backends) emit
      // a separate reasoning channel under this field.
      reasoning_content?: string | null;
      tool_calls?: DeltaToolCall[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string; code?: string } | string;
};

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
  announced: boolean;
};

function config() {
  const cfg = getLocalLlmConfig();
  if (!cfg) {
    throw new Error(
      "Local model provider is not configured. Set LOCAL_LLM_BASE_URL and LOCAL_LLM_MODELS.",
    );
  }
  return cfg;
}

function toChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function toLlmMessages(
  systemPrompt: string,
  messages: LlmMessage[],
): ChatCompletionMessage[] {
  const out: ChatCompletionMessage[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const message of messages) {
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    for (const data of dataLines) {
      if (!data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // Incomplete/half-formed SSE frames stay buffered until the
        // next read — many local servers split frames arbitrarily.
      }
    }
  }

  return { events, rest };
}

function abortError(): Error {
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function chunkFailureMessage(event: ChatCompletionChunk): string | null {
  if (!event.error) return null;
  if (typeof event.error === "string") return event.error;
  const message = event.error.message?.trim() || "Local model request failed.";
  const code = event.error.code?.trim();
  return code ? `Local model error (${code}): ${message}` : message;
}

/**
 * Parses accumulated (possibly malformed) tool-call argument JSON.
 * Local models frequently emit invalid JSON for tool arguments — this never
 * throws; callers branch on `ok` to decide whether to execute the tool or
 * feed an error result back to the model.
 */
function parseToolArguments(
  raw: string,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, input: parsed as Record<string, unknown> };
    }
    return { ok: false, error: "Tool arguments must be a JSON object." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid tool arguments: ${message}` };
  }
}

export async function streamLocal(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const { systemPrompt, tools = [], callbacks = {}, runTools } = params;
  const maxIter = params.maxIterations ?? 10;
  const cfg = config();
  const model = stripLocalModelPrefix(params.model);
  const url = toChatCompletionsUrl(cfg.baseUrl);

  let messages = toLlmMessages(systemPrompt, params.messages);
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "local",
    model,
  });

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools.length ? toChatCompletionsTools(tools) : undefined,
          stream: true,
        }),
        signal: params.abortSignal,
      });

      if (!response.ok || !response.body) {
        const text = (await response.text?.().catch(() => "")) ?? "";
        const err = new Error(
          `Local model request failed (${response.status}): ${
            text || response.statusText
          }`,
        );
        (err as { status?: number }).status = response.status;
        throw err;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pending = new Map<number, PendingToolCall>();
      let buffer = "";
      let sawReasoning = false;
      let finishReason: string | null = null;

      while (true) {
        throwIfAborted(params.abortSignal);
        const { done, value } = await reader.read();
        if (done) break;

        const decoded = decoder.decode(value, { stream: true });
        logRawLlmStream({
          provider: "local",
          model,
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        rawStreamRecorder?.record({
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        buffer += decoded;
        const extracted = extractSseJson(buffer);
        buffer = extracted.rest;

        for (const event of extracted.events as ChatCompletionChunk[]) {
          logRawLlmStream({
            provider: "local",
            model,
            iteration: iter,
            label: "sse_event",
            payload: event,
          });
          rawStreamRecorder?.record({
            iteration: iter,
            label: "sse_event",
            payload: event,
          });

          const failureMessage = chunkFailureMessage(event);
          if (failureMessage) throw new Error(failureMessage);

          const choice = event.choices?.[0];
          if (!choice) continue;

          if (typeof choice.delta?.reasoning_content === "string") {
            sawReasoning = true;
            callbacks.onReasoningDelta?.(choice.delta.reasoning_content);
          }

          if (typeof choice.delta?.content === "string") {
            fullText += choice.delta.content;
            callbacks.onContentDelta?.(choice.delta.content);
          }

          for (const fragment of choice.delta?.tool_calls ?? []) {
            const existing = pending.get(fragment.index);
            const entry: PendingToolCall = existing ?? {
              id: "",
              name: "",
              arguments: "",
              announced: false,
            };
            if (fragment.id) entry.id = fragment.id;
            if (fragment.function?.name) entry.name += fragment.function.name;
            if (fragment.function?.arguments)
              entry.arguments += fragment.function.arguments;
            pending.set(fragment.index, entry);

            if (!entry.announced && entry.id && entry.name) {
              entry.announced = true;
              const parsed = parseToolArguments(entry.arguments);
              callbacks.onToolCallStart?.({
                id: entry.id,
                name: entry.name,
                input: parsed.ok ? parsed.input : {},
              });
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }

      if (sawReasoning) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);

      const pendingCalls = Array.from(pending.values()).filter(
        (call) => call.id && call.name,
      );
      // Gate primarily on whether any tool-call fragments actually
      // arrived — some local servers report the wrong finish_reason
      // (or omit it), so we don't rely on it being "tool_calls".
      void finishReason;
      const hasToolCalls = pendingCalls.length > 0;

      if (!hasToolCalls || !runTools) break;

      // Announce any tool call that never got announced mid-stream
      // (some servers deliver the whole tool_calls array in one delta).
      for (const call of pendingCalls) {
        if (call.announced) continue;
        call.announced = true;
        const parsed = parseToolArguments(call.arguments);
        callbacks.onToolCallStart?.({
          id: call.id,
          name: call.name,
          input: parsed.ok ? parsed.input : {},
        });
      }

      const validCalls: NormalizedToolCall[] = [];
      const malformed: { id: string; error: string }[] = [];
      for (const call of pendingCalls) {
        const parsed = parseToolArguments(call.arguments);
        if (parsed.ok) {
          validCalls.push({
            id: call.id,
            name: call.name,
            input: parsed.input,
          });
        } else {
          console.warn("[localOpenAI] malformed tool-call JSON", {
            model,
            tool: call.name,
            error: parsed.error,
          });
          malformed.push({ id: call.id, error: parsed.error });
        }
      }

      const validResults = validCalls.length ? await runTools(validCalls) : [];
      throwIfAborted(params.abortSignal);

      const resultById = new Map<string, NormalizedToolResult>();
      for (const result of validResults)
        resultById.set(result.tool_use_id, result);
      for (const bad of malformed) {
        resultById.set(bad.id, {
          tool_use_id: bad.id,
          content: JSON.stringify({ error: bad.error }),
        });
      }

      const assistantToolCalls: FinalizedToolCall[] = pendingCalls.map(
        (call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        }),
      );

      messages = [
        ...messages,
        {
          role: "assistant",
          content: null,
          tool_calls: assistantToolCalls,
        },
        ...pendingCalls.map((call) => ({
          role: "tool" as const,
          tool_call_id: call.id,
          content:
            resultById.get(call.id)?.content ??
            JSON.stringify({ error: `No result for tool call ${call.id}` }),
        })),
      ];
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

function toChatCompletionsTools(tools: OpenAIToolSchema[]) {
  // Local chat-completions servers use the exact same tool schema shape
  // TOOLS is already authored in — no conversion needed.
  return tools;
}

export async function completeLocalText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const cfg = config();
  const model = stripLocalModelPrefix(params.model);
  const url = toChatCompletionsUrl(cfg.baseUrl);

  const messages: ChatCompletionMessage[] = [];
  if (params.systemPrompt)
    messages.push({ role: "system", content: params.systemPrompt });
  messages.push({ role: "user", content: params.user });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: params.maxTokens ?? 512,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Local model request failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

export type { NormalizedToolResult };
